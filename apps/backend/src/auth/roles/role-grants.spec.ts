import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { allRoles, Role } from "./role.enum.js";
import {
    assertMayChangeRoles,
    assertMayGrantRoles,
    assertMayManageRoles,
    grantableRoles,
} from "./role-grants.js";

const unreserved = allRoles.filter(
    (role) => role !== Role.Tenants && role !== Role.TenantAdmin,
);

describe("grantableRoles", () => {
    it("allows every role with tenants:manage", () => {
        expect([...grantableRoles([Role.Tenants])].sort()).toEqual(
            [...allRoles].sort(),
        );
    });

    it("allows every unreserved role with tenant:admin", () => {
        expect([...grantableRoles([Role.TenantAdmin])].sort()).toEqual(
            [...unreserved].sort(),
        );
    });

    it("allows only held roles otherwise", () => {
        expect([
            ...grantableRoles([
                Role.Clients,
                Role.IssuanceOffer,
                "offline_access",
            ]),
        ]).toEqual([Role.IssuanceOffer, Role.IssuanceRead, Role.Clients]);
    });

    it("allows the roles that held roles imply", () => {
        expect([...grantableRoles([Role.Issuances])].sort()).toEqual(
            [
                Role.Issuances,
                Role.IssuanceOffer,
                Role.IssuanceRead,
                Role.CredentialStatus,
            ].sort(),
        );
    });
});

describe("assertMayGrantRoles", () => {
    it("accepts held roles", () => {
        expect(() =>
            assertMayGrantRoles(
                [Role.Clients, Role.IssuanceOffer],
                [Role.IssuanceOffer],
            ),
        ).not.toThrow();
    });

    it("names every role the caller may not grant", () => {
        expect(() =>
            assertMayGrantRoles(
                [Role.Clients],
                [Role.Clients, Role.Registrar, Role.Issuances],
            ),
        ).toThrow(
            new ForbiddenException(
                "Cannot grant registrar:manage, issuance:manage: you can only grant roles you hold, and only tenants:manage grants tenants:manage or tenant:admin",
            ),
        );
    });

    it("keeps tenant:admin reserved even for its holders", () => {
        expect(() =>
            assertMayGrantRoles(
                [Role.Clients, Role.TenantAdmin],
                [Role.TenantAdmin],
            ),
        ).toThrow(ForbiddenException);
    });

    it("lets tenants:manage grant the reserved roles", () => {
        expect(() =>
            assertMayGrantRoles(
                [Role.Tenants],
                [Role.Tenants, Role.TenantAdmin],
            ),
        ).not.toThrow();
    });
});

describe("assertMayManageRoles", () => {
    it("accepts a target whose roles the caller holds", () => {
        expect(() =>
            assertMayManageRoles(
                [Role.Clients, Role.IssuanceOffer],
                [Role.IssuanceOffer, Role.Clients],
                "client a",
            ),
        ).not.toThrow();
    });

    it("refuses a target with a role the caller lacks", () => {
        expect(() =>
            assertMayManageRoles(
                [Role.Clients],
                [Role.Clients, Role.Registrar],
                "client a",
            ),
        ).toThrow(
            new ForbiddenException(
                "Cannot manage client a: it has registrar:manage, which you neither hold nor may grant",
            ),
        );
    });

    it("accepts a reserved role the caller holds", () => {
        expect(() =>
            assertMayManageRoles(
                [Role.Clients, Role.TenantAdmin],
                [Role.Clients, Role.TenantAdmin, Role.Registrar],
                "client a",
            ),
        ).not.toThrow();
    });

    it("refuses tenants:manage targets for tenant:admin callers", () => {
        expect(() =>
            assertMayManageRoles(
                [Role.Clients, Role.TenantAdmin],
                [Role.Tenants],
                "client root",
            ),
        ).toThrow(ForbiddenException);
    });

    it("refuses role names EUDIPLO does not know, such as Keycloak client roles", () => {
        expect(() =>
            assertMayManageRoles(
                [Role.Tenants],
                ["realm-management/realm-admin"],
                "client kc-admin",
            ),
        ).toThrow(ForbiddenException);
    });

    it("accepts an unknown role name the caller holds", () => {
        expect(() =>
            assertMayManageRoles([Role.Users, "custom"], ["custom"], "user a"),
        ).not.toThrow();
    });
});

describe("assertMayChangeRoles", () => {
    it("lets a tenant:admin caller keep tenant:admin on a client", () => {
        expect(() =>
            assertMayChangeRoles(
                [Role.Clients, Role.TenantAdmin],
                [Role.Clients, Role.TenantAdmin],
                [Role.Clients, Role.TenantAdmin, Role.Registrar],
            ),
        ).not.toThrow();
    });

    it("refuses to add a role the caller may not grant", () => {
        expect(() =>
            assertMayChangeRoles(
                [Role.Clients, Role.TenantAdmin],
                [Role.Clients],
                [Role.Clients, Role.TenantAdmin],
            ),
        ).toThrow("Cannot grant tenant:admin");
    });
});
