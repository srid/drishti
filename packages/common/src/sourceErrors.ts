export type OsfactsSourceFacet =
  | "proc"
  | "ports"
  | "ports_unclaimed"
  | "ports_uid"
  | "mem"
  | "start_time"
  | "cpu_time"
  | "uid"
  | "cwd"
  | "status"
  | "argv"
  | "uptime"
  | "load"
  | "cpu"
  | "net"
  | "disk";

export interface OsfactsSourceStatus {
  operation: string;
  errors: Array<{ source: string; facet: OsfactsSourceFacet; code: string }>;
}

const OSFACTS_SOURCE_FACETS: readonly string[] = [
  "proc",
  "ports",
  "ports_unclaimed",
  "ports_uid",
  "mem",
  "start_time",
  "cpu_time",
  "uid",
  "cwd",
  "status",
  "argv",
  "uptime",
  "load",
  "cpu",
  "net",
  "disk",
];

function isSourceFacet(value: unknown): value is OsfactsSourceFacet {
  return typeof value === "string" && OSFACTS_SOURCE_FACETS.includes(value);
}

const STATUS_MARKER = "drishti-osfacts-source-status:";

function isStatus(value: unknown): value is OsfactsSourceStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OsfactsSourceStatus>;
  return (
    typeof candidate.operation === "string" &&
    Array.isArray(candidate.errors) &&
    candidate.errors.every(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        typeof (error as { source?: unknown }).source === "string" &&
        isSourceFacet((error as { facet?: unknown }).facet) &&
        typeof (error as { code?: unknown }).code === "string",
    )
  );
}

/** A fail-loud rejection for an error-only response or a fixed host aggregate
 * missing a required fact. Usable partial process frames publish instead and
 * carry the same facts through the surface's `sourceErrors` collection. The
 * marker survives oRPC, stderr, and SSH log transport. */
export class OsfactsSourceError extends Error {
  readonly status: OsfactsSourceStatus;

  constructor(status: OsfactsSourceStatus) {
    const facts = status.errors
      .map(({ source, facet, code }) => `${source}:${facet}:${code}`)
      .join(", ");
    super(
      `osfacts ${status.operation} source error: ${facts}\n` +
        `${STATUS_MARKER}${JSON.stringify(status)}`,
    );
    this.name = "OsfactsSourceError";
    this.status = status;
  }
}

/** Recover structured source status either directly or after an error has
 * crossed a text-only process/transport boundary. */
export function osfactsSourceStatus(value: unknown): OsfactsSourceStatus | null {
  if (value instanceof OsfactsSourceError) return value.status;
  const text = value instanceof Error ? value.message : String(value ?? "");
  const marker = text.indexOf(STATUS_MARKER);
  if (marker < 0) return null;
  const encoded = text
    .slice(marker + STATUS_MARKER.length)
    .split("\n", 1)[0]
    ?.trim();
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    return isStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
