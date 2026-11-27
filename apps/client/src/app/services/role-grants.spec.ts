import { describe, expect, it } from 'vitest';
import { canManageRoles, grantableRoles, grantHint, roleChoices, roles } from './role-grants';

describe('grantableRoles', () => {
  it('offers every role to tenants:manage', () => {
    expect(grantableRoles(['tenants:manage'])).toEqual(roles);
  });

  it('offers every role except the reserved ones to tenant:admin', () => {
    expect(grantableRoles(['tenant:admin'])).toEqual(
      roles.filter((role) => role !== 'tenants:manage' && role !== 'tenant:admin')
    );
  });

  it('offers only the held roles otherwise, including the roles they imply', () => {
    expect(grantableRoles(['clients:manage', 'issuance:offer', 'offline_access'])).toEqual([
      'clients:manage',
      'issuance:offer',
      'issuance:read',
    ]);
  });
});

describe('canManageRoles', () => {
  it('allows a target whose roles the caller holds', () => {
    expect(canManageRoles(['clients:manage', 'issuance:offer'], ['issuance:offer'])).toBe(true);
  });

  it('refuses a target with a role the caller lacks', () => {
    expect(canManageRoles(['clients:manage'], ['registrar:manage'])).toBe(false);
  });

  it('allows a reserved role the caller holds', () => {
    expect(canManageRoles(['clients:manage', 'tenant:admin'], ['tenant:admin'])).toBe(true);
  });

  it('ignores role names EUDIPLO does not know', () => {
    expect(canManageRoles(['users:manage'], ['default-roles-eudiplo'])).toBe(true);
  });
});

describe('grantHint', () => {
  it.each([
    [['tenants:manage'], 'You can grant every role.'],
    [['tenant:admin'], 'You can grant every role except tenants:manage and tenant:admin.'],
    [
      ['clients:manage'],
      'You can grant only roles you have, including those your roles include, except tenants:manage and tenant:admin.',
    ],
  ])('explains the grants of %j', (callerRoles, hint) => {
    expect(grantHint(callerRoles)).toBe(hint);
  });
});

describe('roleChoices', () => {
  it('offers roles of the edited client the caller holds but may not grant', () => {
    const { options, unmanageable } = roleChoices(
      ['clients:manage', 'tenant:admin'],
      ['clients:manage', 'tenant:admin', 'default-roles-eudiplo']
    );
    // Held, so it may stay or be removed, but not be added back once saved.
    expect(options).toContainEqual({ role: 'tenant:admin', locked: false });
    expect(options).toContainEqual({ role: 'registrar:manage', locked: false });
    expect(options.map((option) => option.role)).not.toContain('default-roles-eudiplo');
    expect(unmanageable).toEqual([]);
  });

  it('lists the roles that keep the caller from changing the client', () => {
    const { options, unmanageable } = roleChoices(['clients:manage'], ['registrar:manage']);
    expect(options).toContainEqual({ role: 'registrar:manage', locked: true });
    expect(unmanageable).toEqual(['registrar:manage']);
  });
});
