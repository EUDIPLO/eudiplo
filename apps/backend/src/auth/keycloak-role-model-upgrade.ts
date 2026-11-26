import {
    NARROWED_ROLES,
    upgradeRolesToRoleModel11,
} from "@eudiplo/config-format/client-roles.js";
import type KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import type { Logger } from "@nestjs/common";
import { isRole, Role } from "./roles/role.enum.js";

/**
 * The realm role that came with the 11.0 role model. While the realm lacks it,
 * its role assignments still need the upgrade; it is created only once the
 * upgrade has run (`upgradeRealmToRoleModel11`), and no other code creates it.
 */
export const ROLE_MODEL_11_MARKER = Role.KeysExport;

const PAGE_SIZE = 100;

/**
 * Upgrades the realm's role assignments to the 11.0 role model and then
 * creates `ROLE_MODEL_11_MARKER`, so it runs once per realm. A failure is
 * logged and leaves the marker missing, so the next start tries again; other
 * startup steps go on. When another replica created the marker first, the
 * conflict is ignored.
 */
export async function upgradeRealmToRoleModel11(
    kc: KeycloakAdminClient,
    logger: Logger,
): Promise<void> {
    try {
        await upgradeRealmRolesToRoleModel11(kc, logger);
    } catch (err) {
        logger.error(
            "Could not upgrade the Keycloak role assignments to the 11.0 role model; the next start tries again. The service account of OIDC_CLIENT_ID needs to view and manage users and realm roles.",
            err,
        );
        return;
    }
    try {
        await kc.roles.create({ name: ROLE_MODEL_11_MARKER });
    } catch (err) {
        const exists = await kc.roles
            .findOneByName({ name: ROLE_MODEL_11_MARKER })
            .catch(() => undefined);
        if (!exists) {
            logger.error(
                `Upgraded the Keycloak role assignments, but could not create the realm role ${ROLE_MODEL_11_MARKER}; the next start runs the upgrade again.`,
                err,
            );
        }
    }
}

/**
 * Gives the Keycloak users and service accounts that hold a role 11.0
 * narrowed, mapped directly, the role that now holds its right
 * (`upgradeRolesToRoleModel11`), as the database migration does for the
 * stored clients. `upgradeRealmToRoleModel11` runs it once per realm. Mappings through
 * groups or composite roles are not changed; they are logged so an
 * administrator can add the roles there.
 */
export async function upgradeRealmRolesToRoleModel11(
    kc: KeycloakAdminClient,
    logger: Logger,
): Promise<void> {
    const realmRoles = await kc.roles.find();
    const byName = new Map(
        realmRoles
            .filter((role) => role.id && role.name)
            .map((role) => [role.name!, { id: role.id!, name: role.name! }]),
    );

    const holders = new Set<string>();
    for (const name of NARROWED_ROLES) {
        if (!byName.has(name)) continue;
        for (let first = 0; ; first += PAGE_SIZE) {
            const users = await kc.roles.findUsersWithRole({
                name,
                first,
                max: PAGE_SIZE,
                briefRepresentation: true,
            });
            for (const user of users) if (user.id) holders.add(user.id);
            if (users.length < PAGE_SIZE) break;
        }
    }

    let upgraded = 0;
    for (const id of holders) {
        const mapped = await kc.users.listRealmRoleMappings({ id });
        const names = mapped
            .map((role) => role.name)
            .filter((name): name is string => isRole(name));
        const added = upgradeRolesToRoleModel11(names).slice(names.length);
        const roles = added
            .map((name) => byName.get(name))
            .filter((role) => role !== undefined);
        if (roles.length === 0) continue;
        await kc.users.addRealmRoleMappings({ id, roles });
        upgraded++;
    }
    if (upgraded > 0) {
        logger.log(
            `Added audit:read or keys:manage to ${upgraded} Keycloak user(s) or service account(s) so they keep their access under the 11.0 role model; remove the roles where they are not needed.`,
        );
    }

    const composites: string[] = [];
    for (const role of realmRoles) {
        if (!role.composite || !role.id || isRole(role.name)) continue;
        const children = await kc.roles.getCompositeRoles({ id: role.id });
        if (children.some((child) => NARROWED_ROLES.includes(child.name!))) {
            composites.push(role.name!);
        }
    }
    if (composites.length > 0) {
        logger.warn(
            `The composite realm role(s) ${composites.join(", ")} contain clients:manage, issuance:manage or presentation:manage. EUDIPLO did not change them: add audit:read where clients:manage needs the audit log, and keys:manage where issuance:manage or presentation:manage needs to change key chains.`,
        );
    }
    const groups = await kc.groups
        .count()
        .then((result) => result.count)
        .catch(() => 1);
    if (groups > 0) {
        logger.warn(
            "Realm roles assigned through Keycloak groups were not upgraded: give groups with clients:manage the role audit:read, and groups with issuance:manage or presentation:manage the role keys:manage, where they need them.",
        );
    }
}
