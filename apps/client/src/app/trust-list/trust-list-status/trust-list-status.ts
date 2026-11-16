import type { TrustListFetchOutcome, TrustListStatusResponseDto } from '@eudiplo/sdk-core';

/** The fragment that links to the Lists in use section, for example from the dashboard. */
export const TRUST_LIST_STATUS_FRAGMENT = 'trust-list-status-heading';

/** How each outcome of a trust list's last load reads on screen. */
export const trustListOutcomeLabels: Record<TrustListFetchOutcome, string> = {
  accepted: 'Accepted',
  outdated: 'Outdated',
  superseded: 'Older version',
  invalidSequenceNumber: 'Invalid sequence number',
  tooManyCertificates: 'Too many certificates',
  failed: 'Failed',
};

/**
 * Days after which a list's entry counts as stale: a list in use is loaded
 * again on its next use, so one not checked for this long is most likely no
 * longer referenced. Its entry stays until the tenant is deleted.
 */
export const TRUST_LIST_STATUS_STALE_DAYS = 7;

/** A list that added no trust at its last load. */
export function isTrustListRejected(status: TrustListStatusResponseDto): boolean {
  return status.outcome !== 'accepted';
}

/** The list was not loaded for {@link TRUST_LIST_STATUS_STALE_DAYS} days. */
export function isTrustListStatusStale(
  status: TrustListStatusResponseDto,
  now = Date.now()
): boolean {
  const checkedAt = Date.parse(status.checkedAt);
  return now - checkedAt > TRUST_LIST_STATUS_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/** The lists that added no trust at their last load and were checked recently, in the order given. */
export function rejectedTrustLists(
  statuses: TrustListStatusResponseDto[],
  now = Date.now()
): TrustListStatusResponseDto[] {
  return statuses.filter(
    (status) => isTrustListRejected(status) && !isTrustListStatusStale(status, now)
  );
}
