#!/usr/bin/env bun
/**
 * drishti PWA icon generator — the single source of truth for the app icon.
 *
 * drishti means "sight / vision"; the mark is a stylised aperture-eye: a
 * dark rounded tile, an emerald ring, and a solid emerald pupil. The same
 * geometry (fractions of the canvas, below) drives *both* outputs, so the
 * vector favicon and the raster PWA icons can never drift apart:
 *
 *   - `icon.svg`                 vector mark (favicon + manifest svg entry)
 *   - `icon-192.png`             manifest icon (any)
 *   - `icon-512.png`             manifest icon (any)
 *   - `icon-maskable-512.png`    manifest icon (maskable — full-bleed bg)
 *   - `apple-touch-icon.png`     iOS home-screen icon (180, full-bleed bg)
 *
 * Re-run after editing the geometry: `just gen-pwa-icons` (or
 * `bun scripts/gen-pwa-icons.ts`). The emitted files are committed as
 * source assets so the Nix build only has to copy them — it pulls in no
 * image toolchain. PNGs are encoded by hand (zlib + CRC32) to keep that
 * dependency footprint at zero rather than add a rasteriser/image library.
 */

import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { BRAND_DARK } from "../packages/app/src/client/brand";

type RGB = readonly [number, number, number];

/** "#rrggbb" → [r, g, b]. */
function hexToRgb(hex: string): RGB {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── Icon geometry, as fractions of the canvas (centre at 0.5, 0.5) ──────
// The background is the shared brand dark; the emerald accents are
// icon-only (no CSS/manifest counterpart), so they stay literal here.
const COLORS = {
  bg: hexToRgb(BRAND_DARK),
  ring: [0x34, 0xd3, 0x99], // emerald-400
  pupil: [0x10, 0xb9, 0x81], // emerald-500 — the "connected" accent
} satisfies Record<string, RGB>;
const CORNER = 0.22; // rounded-tile corner radius
const RING_OUTER = 0.34;
const RING_INNER = 0.24;
const PUPIL = 0.12;

/** Background treatment. "tile" rounds the corners and leaves them
 *  transparent; "fullbleed" paints the whole square opaque (what maskable
 *  and iOS want — the platform supplies its own mask/rounding). */
type Mode = "tile" | "fullbleed";

// ── Raster path ─────────────────────────────────────────────────────────

/** Smooth 0→1 coverage as the sample crosses `edge`, anti-aliased over one
 *  device pixel. `inside` flips which side reads as covered. */
function coverage(value: number, edge: number, px: number, inside: boolean): number {
  const t = (edge - value) / px;
  const c = Math.min(Math.max(t + 0.5, 0), 1);
  return inside ? c : 1 - c;
}

/** Signed distance from point `p` to a centred rounded square of the given
 *  half-extent and corner radius. Negative inside. */
function roundedSquareSDF(px: number, py: number, half: number, radius: number): number {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** `over` alpha-compositing of a straight-alpha source onto `dst` (RGBA, 0–1). */
function over(dst: number[], src: RGB, srcA: number): void {
  const outA = srcA + dst[3]! * (1 - srcA);
  if (outA <= 0) {
    dst[0] = dst[1] = dst[2] = dst[3] = 0;
    return;
  }
  for (let i = 0; i < 3; i++)
    dst[i] = (src[i]! / 255) * srcA + dst[i]! * dst[3]! * (1 - srcA);
  // de-premultiply back to straight alpha
  for (let i = 0; i < 3; i++) dst[i] = dst[i]! / outA;
  dst[3] = outA;
}

function renderRGBA(size: number, mode: Mode): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  const px = 1.5 / size; // ~1.5 device px of anti-aliasing, in unit space
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // sample at pixel centre, in [0,1]
      const ux = (x + 0.5) / size;
      const uy = (y + 0.5) / size;
      const dx = ux - 0.5;
      const dy = uy - 0.5;
      const dist = Math.hypot(dx, dy);

      const pixel = [0, 0, 0, 0];
      // background
      const bgA =
        mode === "fullbleed"
          ? 1
          : coverage(roundedSquareSDF(dx, dy, 0.5, CORNER), 0, px, true);
      over(pixel, COLORS.bg, bgA);
      // emerald ring (annulus between RING_INNER and RING_OUTER)
      const ringA =
        coverage(dist, RING_OUTER, px, true) * coverage(dist, RING_INNER, px, false);
      over(pixel, COLORS.ring, ringA);
      // pupil
      over(pixel, COLORS.pupil, coverage(dist, PUPIL, px, true));

      const o = (y * size + x) * 4;
      buf[o] = Math.round(pixel[0]! * 255);
      buf[o + 1] = Math.round(pixel[1]! * 255);
      buf[o + 2] = Math.round(pixel[2]! * 255);
      buf[o + 3] = Math.round(pixel[3]! * 255);
    }
  }
  return buf;
}

// ── Minimal PNG encoder (truecolour + alpha, no compression heuristics) ──

const ENC = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ENC.encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  // layout: 4-byte length | type+data (body) | 4-byte CRC
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}

function encodePNG(size: number, rgba: Uint8Array): Uint8Array {
  // filter byte 0 (none) prepended to each scanline
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── Vector path (same geometry, expressed in a 512 viewBox) ──────────────

function renderSVG(): string {
  const S = 512;
  const c = S / 2;
  const ringMid = ((RING_OUTER + RING_INNER) / 2) * S;
  const ringWidth = (RING_OUTER - RING_INNER) * S;
  const hex = (rgb: RGB) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="drishti">
  <rect width="${S}" height="${S}" rx="${CORNER * S}" fill="${hex(COLORS.bg)}"/>
  <circle cx="${c}" cy="${c}" r="${ringMid}" fill="none" stroke="${hex(COLORS.ring)}" stroke-width="${ringWidth}"/>
  <circle cx="${c}" cy="${c}" r="${PUPIL * S}" fill="${hex(COLORS.pupil)}"/>
</svg>
`;
}

// ── Emit ─────────────────────────────────────────────────────────────────

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "app", "src", "client", "public", "icons");
mkdirSync(OUT, { recursive: true });

const writePNG = (name: string, size: number, mode: Mode) => {
  writeFileSync(resolve(OUT, name), encodePNG(size, renderRGBA(size, mode)));
  console.log(`wrote ${name} (${size}×${size}, ${mode})`);
};

writeFileSync(resolve(OUT, "icon.svg"), renderSVG());
console.log("wrote icon.svg");
writePNG("icon-192.png", 192, "tile");
writePNG("icon-512.png", 512, "tile");
writePNG("icon-maskable-512.png", 512, "fullbleed");
writePNG("apple-touch-icon.png", 180, "fullbleed");
