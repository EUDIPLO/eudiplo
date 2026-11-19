import { describe, expect, it } from 'vitest';

import { groupRoles, uniqueRoles } from './role-groups';

describe('groupRoles', () => {
  it('groups the roles by area, once each, and keeps unknown roles under Other', () => {
    expect(
      groupRoles([
        'clients:manage',
        'issuance:offer',
        'clients:manage',
        'audit:read',
        'presentation:manage',
        'future:role',
      ]).map((group) => [group.title, group.roles])
    ).toEqual([
      ['Issuance', ['issuance:offer']],
      ['Presentation', ['presentation:manage']],
      ['Sessions and audit', ['audit:read']],
      ['Administration', ['clients:manage']],
      ['Other', ['future:role']],
    ]);
  });
});

describe('uniqueRoles', () => {
  it('names each role once, in the order first seen', () => {
    expect(uniqueRoles(['b', 'a', 'b'])).toEqual(['b', 'a']);
    expect(uniqueRoles(undefined)).toEqual([]);
  });
});
