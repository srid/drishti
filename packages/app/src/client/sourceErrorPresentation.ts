import { osfactsSourceStatus } from "drishti-common/source-errors";

export interface SourceErrorFact {
  operation: string;
  source: string;
  code: string;
}

/** Flatten and deduplicate osfacts statuses recovered from direct errors or
 * text-only remote failure/log lines. */
export function sourceErrorFacts(values: readonly unknown[]): SourceErrorFact[] {
  const facts = new Map<string, SourceErrorFact>();
  for (const value of values) {
    const status = osfactsSourceStatus(value);
    if (status === null) continue;
    for (const error of status.errors) {
      const fact = { operation: status.operation, ...error };
      facts.set(`${fact.operation}\0${fact.source}\0${fact.code}`, fact);
    }
  }
  return [...facts.values()];
}

export function mergeSourceErrorFacts(
  ...groups: readonly (readonly SourceErrorFact[])[]
): SourceErrorFact[] {
  const facts = new Map<string, SourceErrorFact>();
  for (const group of groups)
    for (const fact of group)
      facts.set(`${fact.operation}\0${fact.source}\0${fact.code}`, fact);
  return [...facts.values()];
}
