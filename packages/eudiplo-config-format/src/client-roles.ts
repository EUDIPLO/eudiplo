/**
 * Role changes of the 11.0 role model for stored and file-managed clients.
 *
 * 11.0 narrowed two roles: `clients:manage` no longer reads the audit log
 * (`audit:read` does), and `issuance:manage` and `presentation:manage` no
 * longer write key chains (`keys:manage` does). So that no client loses
 * access on the upgrade, a client with one of these roles gets the role that
 * now holds the right, unless `tenant:admin` or `tenants:manage` already
 * implies it. The database migration, the Client v2 to v3 file migration and
 * the Keycloak upgrade apply the same rule.
 */

const ADMIN_ROLES = ["tenant:admin", "tenants:manage"];

/** Each role that 11.0 adds, with the roles that make a client get it, in the order they are added. */
const ADDED_ROLES: ReadonlyArray<{ role: string; for: readonly string[] }> = [
    { role: "audit:read", for: ["clients:manage"] },
    { role: "keys:manage", for: ["issuance:manage", "presentation:manage"] },
];

/** The roles whose holders the 11.0 upgrade may give another role. */
export const NARROWED_ROLES: readonly string[] = ADDED_ROLES.flatMap(
    (added) => added.for,
);

/**
 * The roles of a client after the 11.0 upgrade: `roles` with `audit:read` and
 * `keys:manage` appended where the client needs them to keep its access.
 * Returns `roles` unchanged when nothing is added.
 */
export function upgradeRolesToRoleModel11(roles: readonly string[]): string[] {
    if (roles.some((role) => ADMIN_ROLES.includes(role))) return [...roles];
    const result = [...roles];
    for (const added of ADDED_ROLES) {
        if (
            !result.includes(added.role) &&
            added.for.some((role) => result.includes(role))
        ) {
            result.push(added.role);
        }
    }
    return result;
}

/**
 * The role lists other than `roles` that `upgradeRolesToRoleModel11` turns
 * into `roles`, so a document applied before the upgrade can be recognized
 * after it.
 */
export function rolesBeforeRoleModel11(roles: readonly string[]): string[][] {
    const candidates: string[][] = [];
    const trailing = ADDED_ROLES.map((added) => added.role).reverse();
    let current = [...roles];
    for (const role of trailing) {
        if (current.at(-1) === role) {
            current = current.slice(0, -1);
            candidates.push(current);
        }
    }
    const same = (a: readonly string[], b: readonly string[]) =>
        a.length === b.length && a.every((role, index) => role === b[index]);
    return candidates.filter((candidate) =>
        same(upgradeRolesToRoleModel11(candidate), roles),
    );
}
