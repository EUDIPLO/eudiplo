import { describe, expect, it } from "vitest";
import { rolesAllow } from "../../../test/roles-guard.js";
import { Role } from "../../auth/roles/role.enum.js";
import { KeyChainController } from "./key-chain.controller.js";

describe("KeyChainController role checks", () => {
    it.each([
        "getProviders",
        "getProvidersHealth",
        "getAll",
        "getById",
    ] as const)("%s accepts keys:manage and the read roles", (handler) => {
        const allows = (roles: Role[]) =>
            rolesAllow(KeyChainController, handler, roles);
        expect(allows([Role.Keys])).toBe(true);
        expect(allows([Role.IssuanceRead])).toBe(true);
        expect(allows([Role.PresentationRead])).toBe(true);
        expect(allows([Role.Issuances])).toBe(true);
        expect(allows([Role.TenantAdmin])).toBe(true);
        expect(allows([Role.Clients])).toBe(false);
        expect(allows([Role.SessionsRead])).toBe(false);
    });

    it.each([
        "create",
        "import",
        "update",
        "delete",
        "rotate",
        "createCsr",
    ] as const)("%s needs keys:manage", (handler) => {
        const allows = (roles: Role[]) =>
            rolesAllow(KeyChainController, handler, roles);
        expect(allows([Role.Keys])).toBe(true);
        expect(allows([Role.KeysExport])).toBe(true);
        expect(allows([Role.TenantAdmin])).toBe(true);
        expect(allows([Role.Issuances])).toBe(false);
        expect(allows([Role.Presentations])).toBe(false);
        expect(allows([Role.IssuanceRead])).toBe(false);
    });

    it.each([
        "export",
        "getTenantKmsConfig",
        "updateTenantKmsConfig",
        "deleteTenantKmsConfig",
    ] as const)("%s needs keys:export, not keys:manage", (handler) => {
        const allows = (roles: Role[]) =>
            rolesAllow(KeyChainController, handler, roles);
        expect(allows([Role.Keys])).toBe(false);
        expect(allows([Role.Issuances, Role.Presentations])).toBe(false);
        expect(allows([Role.KeysExport])).toBe(true);
        expect(allows([Role.TenantAdmin])).toBe(true);
        expect(allows([Role.Tenants])).toBe(true);
    });
});
