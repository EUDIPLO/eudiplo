import type KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import type { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
    ROLE_MODEL_11_MARKER,
    upgradeRealmRolesToRoleModel11,
    upgradeRealmToRoleModel11,
} from "./keycloak-role-model-upgrade.js";

type Mapping = { id: string; name: string };

function fakeKeycloak(
    users: Record<string, string[]>,
    composites: Record<string, string[]> = {},
    groupCount = 0,
) {
    const realmRoles = [
        "clients:manage",
        "issuance:manage",
        "presentation:manage",
        "audit:read",
        "keys:manage",
        "issuance:offer",
        "tenant:admin",
        "default-roles-test",
        ...Object.keys(composites),
    ].map((name) => ({
        id: `id-${name}`,
        name,
        composite: name in composites,
    }));
    const mappings = new Map(
        Object.entries(users).map(([id, roles]) => [
            id,
            roles.map((name) => ({ id: `id-${name}`, name })),
        ]),
    );
    const addRealmRoleMappings = vi.fn(
        async ({ id, roles }: { id: string; roles: Mapping[] }) => {
            mappings.get(id)!.push(...roles);
        },
    );
    const kc = {
        roles: {
            find: async () => realmRoles,
            findUsersWithRole: async ({
                name,
                first,
                max,
            }: {
                name: string;
                first: number;
                max: number;
            }) =>
                [...mappings.entries()]
                    .filter(([, roles]) =>
                        roles.some((role) => role.name === name),
                    )
                    .map(([id]) => ({ id }))
                    .slice(first, first + max),
            create: vi.fn(async ({ name }: { name: string }) => {
                realmRoles.push({ id: `id-${name}`, name, composite: false });
            }),
            findOneByName: async ({ name }: { name: string }) =>
                realmRoles.find((role) => role.name === name),
            getCompositeRoles: async ({ id }: { id: string }) =>
                (composites[id.slice(3)] ?? []).map((name) => ({ name })),
        },
        groups: { count: async () => ({ count: groupCount }) },
        users: {
            listRealmRoleMappings: async ({ id }: { id: string }) =>
                mappings.get(id) ?? [],
            addRealmRoleMappings,
        },
    } as unknown as KeycloakAdminClient;
    const logger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger;
    return { kc, logger, mappings, addRealmRoleMappings, realmRoles };
}

describe("upgradeRealmRolesToRoleModel11", () => {
    it("adds the split-off roles to direct holders of the narrowed roles", async () => {
        const { kc, logger, mappings, addRealmRoleMappings } = fakeKeycloak({
            admin: ["clients:manage", "issuance:manage", "default-roles-test"],
            verifier: ["presentation:manage", "keys:manage"],
            shop: ["issuance:offer"],
            owner: ["tenant:admin", "clients:manage"],
        });

        await upgradeRealmRolesToRoleModel11(kc, logger);

        expect(mappings.get("admin")!.map((role) => role.name)).toEqual([
            "clients:manage",
            "issuance:manage",
            "default-roles-test",
            "audit:read",
            "keys:manage",
        ]);
        expect(addRealmRoleMappings).toHaveBeenCalledTimes(1);
        expect(mappings.get("shop")!.map((role) => role.name)).toEqual([
            "issuance:offer",
        ]);
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining("1 Keycloak user"),
        );
    });

    it("names composite roles that contain a narrowed role", async () => {
        const { kc, logger } = fakeKeycloak(
            {},
            { "issuer-admins": ["issuance:manage"], other: ["issuance:offer"] },
        );

        await upgradeRealmRolesToRoleModel11(kc, logger);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("composite realm role(s) issuer-admins "),
        );
    });

    it("reaches holders beyond the first page", async () => {
        const users = Object.fromEntries(
            Array.from({ length: 150 }, (_, index) => [
                `user-${index}`,
                ["issuance:manage"],
            ]),
        );
        const { kc, logger, mappings } = fakeKeycloak(users);

        await upgradeRealmRolesToRoleModel11(kc, logger);

        for (const roles of mappings.values()) {
            expect(roles.map((role) => role.name)).toContain("keys:manage");
        }
    });

    it("leaves admins and holders of the added roles unchanged", async () => {
        const { kc, logger, mappings } = fakeKeycloak({
            owner: ["tenant:admin", "clients:manage"],
            verifier: ["presentation:manage", "keys:manage"],
        });

        await upgradeRealmRolesToRoleModel11(kc, logger);

        expect(mappings.get("owner")!.map((role) => role.name)).toEqual([
            "tenant:admin",
            "clients:manage",
        ]);
        expect(mappings.get("verifier")!.map((role) => role.name)).toEqual([
            "presentation:manage",
            "keys:manage",
        ]);
    });

    it("warns about groups only when the realm has groups", async () => {
        const empty = fakeKeycloak({});
        await upgradeRealmRolesToRoleModel11(empty.kc, empty.logger);
        expect(empty.logger.warn).not.toHaveBeenCalled();

        const grouped = fakeKeycloak({}, {}, 2);
        await upgradeRealmRolesToRoleModel11(grouped.kc, grouped.logger);
        expect(grouped.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Keycloak groups were not upgraded"),
        );
    });
});

describe("upgradeRealmToRoleModel11", () => {
    it("creates the marker role only after the upgrade", async () => {
        const { kc, logger, addRealmRoleMappings } = fakeKeycloak({
            admin: ["clients:manage"],
        });

        await upgradeRealmToRoleModel11(kc, logger);

        expect(addRealmRoleMappings).toHaveBeenCalledTimes(1);
        expect(kc.roles.create).toHaveBeenCalledWith({
            name: ROLE_MODEL_11_MARKER,
        });
        expect(addRealmRoleMappings.mock.invocationCallOrder[0]).toBeLessThan(
            (kc.roles.create as ReturnType<typeof vi.fn>).mock
                .invocationCallOrder[0],
        );
    });

    it("leaves the marker missing when the upgrade fails, so the next start tries again", async () => {
        const { kc, logger } = fakeKeycloak({ admin: ["clients:manage"] });
        kc.users.listRealmRoleMappings = async () => {
            throw new Error("403 Forbidden");
        };

        await upgradeRealmToRoleModel11(kc, logger);

        expect(kc.roles.create).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });

    it("accepts a marker another replica created at the same time", async () => {
        const { kc, logger, realmRoles } = fakeKeycloak({});
        kc.roles.create = vi.fn(async () => {
            realmRoles.push({
                id: "id-keys:export",
                name: ROLE_MODEL_11_MARKER,
                composite: false,
            });
            throw new Error("409 Conflict");
        }) as never;

        await expect(upgradeRealmToRoleModel11(kc, logger)).resolves.toBe(
            undefined,
        );
    });

    it("logs and goes on when the marker cannot be created", async () => {
        const { kc, logger } = fakeKeycloak({});
        kc.roles.create = vi.fn(async () => {
            throw new Error("403 Forbidden");
        }) as never;

        await expect(upgradeRealmToRoleModel11(kc, logger)).resolves.toBe(
            undefined,
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("could not create the realm role"),
            expect.any(Error),
        );
    });
});
