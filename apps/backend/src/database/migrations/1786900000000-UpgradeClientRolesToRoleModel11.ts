import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The 11.0 rule, copied so this released migration never changes: a client
 * without `tenant:admin` or `tenants:manage` gets `audit:read` for
 * `clients:manage` and `keys:manage` for `issuance:manage` or
 * `presentation:manage`, appended in that order. `upgradeRolesToRoleModel11`
 * in `@eudiplo/config-format` applies the same rule to files and Keycloak.
 */
function upgradeRoles(roles: string[]): string[] {
    if (roles.includes("tenant:admin") || roles.includes("tenants:manage")) {
        return roles;
    }
    const result = [...roles];
    if (!result.includes("audit:read") && result.includes("clients:manage")) {
        result.push("audit:read");
    }
    if (
        !result.includes("keys:manage") &&
        (result.includes("issuance:manage") ||
            result.includes("presentation:manage"))
    ) {
        result.push("keys:manage");
    }
    return result;
}

/**
 * Adds the roles that 11.0 split off to the stored clients that need them to
 * keep their access: `audit:read` for `clients:manage`, and `keys:manage` for
 * `issuance:manage` and `presentation:manage`. Mirrors the Client v2 to v3
 * config-file migration. With Keycloak the rows
 * are a mirror; the realm roles are upgraded at startup.
 */
export class UpgradeClientRolesToRoleModel111786900000000
    implements MigrationInterface
{
    name = "UpgradeClientRolesToRoleModel111786900000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("client_entity");
        if (!table?.columns.some((c) => c.name === "roles")) {
            return;
        }

        const escape = (identifier: string) =>
            queryRunner.connection.driver.escape(identifier);
        // Use driver-appropriate SQL placeholders (Postgres: $1,$2 / SQLite: ?,?)
        const param = (n: number) =>
            queryRunner.connection.options.type === "postgres" ? `$${n}` : "?";

        const rows: Array<{ clientId: string; roles: unknown }> =
            await queryRunner.query(
                `SELECT ${escape("clientId")}, ${escape("roles")} FROM ${escape("client_entity")}`,
            );

        let migrated = 0;
        for (const row of rows) {
            const roles =
                typeof row.roles === "string"
                    ? JSON.parse(row.roles)
                    : row.roles;
            if (!Array.isArray(roles)) continue;
            const upgraded = upgradeRoles(roles);
            if (upgraded.length === roles.length) continue;
            await queryRunner.query(
                `UPDATE ${escape("client_entity")} SET ${escape("roles")} = ${param(1)} WHERE ${escape("clientId")} = ${param(2)}`,
                [JSON.stringify(upgraded), row.clientId],
            );
            migrated++;
        }

        if (migrated > 0) {
            console.log(
                `[Migration] Added audit:read or keys:manage to ${migrated} client(s) so they keep their access under the 11.0 role model; remove the roles where they are not needed.`,
            );
        }
    }

    public async down(): Promise<void> {
        // The added roles cannot be told apart from roles assigned on purpose.
    }
}
