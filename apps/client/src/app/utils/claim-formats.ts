import { CLAIM_FIELD_FORMAT_VALIDATORS, type ClaimFieldFormat } from '@eudiplo/sdk-core';

/** What a claim with this format must hold, as hint and error text. */
export const CLAIM_FORMAT_MESSAGES: Record<ClaimFieldFormat, string> = {
  date: 'Enter a calendar date as YYYY-MM-DD, e.g. 1964-08-12.',
  'date-time': 'Enter an RFC 3339 date and time, e.g. 2026-11-20T10:00:00Z.',
};

/** Labels of the claim formats, the same on the create and show pages. */
export const CLAIM_FORMAT_LABELS: Record<ClaimFieldFormat, string> = {
  date: 'Date (YYYY-MM-DD)',
  'date-time': 'Date and time (RFC 3339)',
};

/** The claim format a JSON schema node declares, if it is one EUDIPLO issues. */
export function claimFormatOf(schema: unknown): ClaimFieldFormat | undefined {
  const format = (schema as { format?: unknown } | null | undefined)?.format;
  return typeof format === 'string' && Object.hasOwn(CLAIM_FIELD_FORMAT_VALIDATORS, format)
    ? (format as ClaimFieldFormat)
    : undefined;
}

/** Whether `value` is empty or matches the claim format, as issuance checks it. */
export function matchesClaimFormat(format: ClaimFieldFormat, value: unknown): boolean {
  return (
    value == null ||
    value === '' ||
    (typeof value === 'string' && CLAIM_FIELD_FORMAT_VALIDATORS[format](value))
  );
}
