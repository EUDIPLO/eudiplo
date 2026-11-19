/** Roles of one area, as the client and user pages group them. */
export interface RoleGroup {
  title: string;
  icon: string;
  roles: string[];
}

/** The areas the client and user pages group roles into; a role in none of them falls under "Other". */
const roleAreas: { title: string; icon: string; roles: string[] }[] = [
  {
    title: 'Issuance',
    icon: 'card_giftcard',
    roles: ['issuance:manage', 'issuance:offer', 'credentials:status'],
  },
  {
    title: 'Presentation',
    icon: 'verified_user',
    roles: ['presentation:manage', 'presentation:request'],
  },
  { title: 'Sessions and audit', icon: 'history', roles: ['sessions:read', 'audit:read'] },
  { title: 'Keys and certificates', icon: 'key', roles: ['keys:manage', 'registrar:manage'] },
  {
    title: 'Administration',
    icon: 'admin_panel_settings',
    roles: ['clients:manage', 'users:manage', 'tenant:admin', 'tenants:manage'],
  },
];

/** A client's or user's roles by area, each role once, in the order of the areas. */
export function groupRoles(roles: string[]): RoleGroup[] {
  const own = new Set(roles);
  const groups: RoleGroup[] = roleAreas
    .map((area) => ({ ...area, roles: area.roles.filter((role) => own.has(role)) }))
    .filter((group) => group.roles.length > 0);
  const known = new Set(roleAreas.flatMap((area) => area.roles));
  const other = [...own].filter((role) => !known.has(role));
  if (other.length) groups.push({ title: 'Other', icon: 'more_horiz', roles: other });
  return groups;
}

/** Roles without repeats, as stored records may name a role twice. */
export function uniqueRoles(roles: readonly string[] | undefined): string[] {
  return [...new Set(roles ?? [])];
}
