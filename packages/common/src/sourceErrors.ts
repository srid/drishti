export interface OsfactsSourceStatus {
  operation: string;
  errors: Array<{ source: string; code: string }>;
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
        typeof (error as { code?: unknown }).code === "string",
    )
  );
}

/** A fail-loud osfacts frame rejection which retains the `E` rows as data.
 * The marker in `message` survives oRPC, process stderr, and SSH log transport;
 * direct callers can use the strongly-typed `status` field. */
export class OsfactsSourceError extends Error {
  readonly status: OsfactsSourceStatus;

  constructor(status: OsfactsSourceStatus) {
    const facts = status.errors
      .map(({ source, code }) => `${source}:${code}`)
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
