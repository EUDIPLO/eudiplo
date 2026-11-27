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
const UPGRADE_BATCH = 20;

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

    const upgraded = await addSplitOffRoles(
        kc,
        await narrowedRoleHolders(kc, byName),
        byName,
    );
    if (upgraded > 0) {
        logger.log(
            `Added audit:read or keys:manage to ${upgraded} Keycloak user(s) or service account(s) so they keep their access under the 11.0 role model; remove the roles where they are not needed.`,
        );
    }

    const composites = await compositesWithNarrowedRoles(kc, realmRoles);
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

type RoleRef = { id: string; name: string };

/** The IDs of the users and service accounts with a narrowed role mapped directly. */
async function narrowedRoleHolders(
    kc: KeycloakAdminClient,
    byName: Map<string, RoleRef>,
): Promise<Set<string>> {
    const holders = new Set<string>();
    for (const name of NARROWED_ROLES.filter((role) => byName.has(role))) {
        // Pages one after another: each request needs the previous count.
        let first = 0;
        let page: { id?: string }[];
        do {
            page = await kc.roles.findUsersWithRole({
                name,
                first,
                max: PAGE_SIZE,
                briefRepresentation: true,
            });
            for (const user of page) if (user.id) holders.add(user.id);
            first += PAGE_SIZE;
        } while (page.length === PAGE_SIZE);
    }
    return holders;
}

/** Maps the roles 11.0 split off to the holders that need them; returns how many changed. */
async function addSplitOffRoles(
    kc: KeycloakAdminClient,
    holders: Set<string>,
    byName: Map<string, RoleRef>,
): Promise<number> {
    const upgrade = async (id: string) => {
        const names = (await kc.users.listRealmRoleMappings({ id }))
            .map((role) => role.name)
            .filter((name): name is string => isRole(name));
        const roles = upgradeRolesToRoleModel11(names)
            .slice(names.length)
            .map((name) => byName.get(name))
            .filter((role) => role !== undefined);
        if (roles.length === 0) return false;
        await kc.users.addRealmRoleMappings({ id, roles });
        return true;
    };
    const ids = [...holders];
    let changed = 0;
    // A few requests at a time, so a large realm does not flood Keycloak.
    for (let start = 0; start < ids.length; start += UPGRADE_BATCH) {
        const batch = ids.slice(start, start + UPGRADE_BATCH);
        changed += (await Promise.all(batch.map(upgrade))).filter(
            Boolean,
        ).length;
    }
    return changed;
}

/** The names of composite realm roles that contain a narrowed role. */
async function compositesWithNarrowedRoles(
    kc: KeycloakAdminClient,
    realmRoles: { id?: string; name?: string; composite?: boolean }[],
): Promise<string[]> {
    const candidates = realmRoles.filter(
        (role) => role.composite && role.id && !isRole(role.name),
    );
    const contains = await Promise.all(
        candidates.map(async (role) =>
            (await kc.roles.getCompositeRoles({ id: role.id! })).some((child) =>
                NARROWED_ROLES.includes(child.name!),
            ),
        ),
    );
    return candidates
        .filter((_, index) => contains[index])
        .map((role) => role.name!);
}
