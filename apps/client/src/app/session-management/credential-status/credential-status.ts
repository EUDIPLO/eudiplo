import type { CredentialStatusDto } from '@eudiplo/sdk-core';

export const STATUS_VALID = 0;
export const STATUS_REVOKED = 1;
export const STATUS_SUSPENDED = 2;

/** A status the client can set: valid (reinstate), revoked or suspended. */
export type CredentialStatusValue =
  typeof STATUS_VALID | typeof STATUS_REVOKED | typeof STATUS_SUSPENDED;

/**
 * The credentials of one credential configuration in a session, with the
 * changes `POST /session/revoke` accepts for all of them at once.
 */
export interface CredentialStatusGroup {
  credentialConfigurationId: string;
  entries: CredentialStatusDto[];
  /** Number of entries per status value, in ascending order of the value. */
  counts: { status: number; count: number }[];
  /** Some entry is not revoked yet. */
  canRevoke: boolean;
  /** No entry is revoked, every list has at least 2 bits and some entry is not suspended. */
  canSuspend: boolean;
  /** No entry is revoked and some entry is not valid. */
  canReinstate: boolean;
}

export function statusLabel(status: number): string {
  switch (status) {
    case STATUS_VALID:
      return 'valid';
    case STATUS_REVOKED:
      return 'revoked';
    case STATUS_SUSPENDED:
      return 'suspended';
    default:
      return `status ${status}`;
  }
}

/**
 * Group status entries by credential configuration. Revocation is final, so a
 * group with a revoked entry can only be revoked further: the backend rejects
 * suspending or reinstating it.
 */
export function groupCredentialStatus(entries: CredentialStatusDto[]): CredentialStatusGroup[] {
  const byConfiguration = new Map<string, CredentialStatusDto[]>();
  for (const entry of entries) {
    const group = byConfiguration.get(entry.credentialConfigurationId) ?? [];
    group.push(entry);
    byConfiguration.set(entry.credentialConfigurationId, group);
  }
  return [...byConfiguration].map(([credentialConfigurationId, group]) => {
    const counts = new Map<number, number>();
    for (const entry of group) {
      counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    }
    const anyRevoked = counts.has(STATUS_REVOKED);
    return {
      credentialConfigurationId,
      entries: group,
      counts: [...counts].sort(([a], [b]) => a - b).map(([status, count]) => ({ status, count })),
      canRevoke: group.some((entry) => entry.status !== STATUS_REVOKED),
      canSuspend:
        !anyRevoked &&
        group.every((entry) => entry.bits >= 2) &&
        group.some((entry) => entry.status !== STATUS_SUSPENDED),
      canReinstate: !anyRevoked && group.some((entry) => entry.status !== STATUS_VALID),
    };
  });
}
