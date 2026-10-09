import type { CredentialStatusDto } from '@eudiplo/sdk-core';
import { describe, expect, it } from 'vitest';
import { groupCredentialStatus, statusLabel } from './credential-status';

const entry = (
  credentialConfigurationId: string,
  status: number,
  bits = 2,
  index = 0
): CredentialStatusDto => ({
  credentialConfigurationId,
  statusListId: `list-${bits}`,
  index,
  status,
  bits: bits as CredentialStatusDto['bits'],
});

describe('groupCredentialStatus', () => {
  it('groups entries by credential configuration and counts their statuses', () => {
    const groups = groupCredentialStatus([
      entry('pid', 2, 2, 0),
      entry('pid', 0, 2, 1),
      entry('mdl', 0, 1),
      entry('pid', 0, 2, 2),
    ]);

    expect(groups.map((group) => group.credentialConfigurationId)).toEqual(['pid', 'mdl']);
    expect(groups[0].counts).toEqual([
      { status: 0, count: 2 },
      { status: 2, count: 1 },
    ]);
  });

  it('offers suspend and revoke for valid credentials on a 2-bit list', () => {
    const [group] = groupCredentialStatus([entry('pid', 0)]);

    expect(group).toMatchObject({ canRevoke: true, canSuspend: true, canReinstate: false });
  });

  it('offers no suspension when one of the lists has a single bit per entry', () => {
    const [group] = groupCredentialStatus([entry('pid', 0, 2), entry('pid', 0, 1, 1)]);

    expect(group.canSuspend).toBe(false);
  });

  it('offers reinstate and revoke for suspended credentials', () => {
    const [group] = groupCredentialStatus([entry('pid', 2)]);

    expect(group).toMatchObject({ canRevoke: true, canSuspend: false, canReinstate: true });
  });

  it('only offers revoking the rest once a credential is revoked', () => {
    const [group] = groupCredentialStatus([entry('pid', 1), entry('pid', 2, 2, 1)]);

    expect(group).toMatchObject({ canRevoke: true, canSuspend: false, canReinstate: false });
  });

  it('offers nothing when every credential is revoked', () => {
    const [group] = groupCredentialStatus([entry('pid', 1)]);

    expect(group).toMatchObject({ canRevoke: false, canSuspend: false, canReinstate: false });
  });
});

describe('statusLabel', () => {
  it.each([
    [0, 'valid'],
    [1, 'revoked'],
    [2, 'suspended'],
    [3, 'status 3'],
  ])('labels %s as %s', (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});
