import { describe, expect, it } from "vitest";
import { allRoles, effectiveRoles, impliedRoles, Role } from "./role.enum.js";

describe("effectiveRoles", () => {
    it("adds the implied roles transitively", () => {
        expect(effectiveRoles([Role.Issuances]).sort()).toEqual(
            [
                Role.Issuances,
                Role.IssuanceOffer,
                Role.IssuanceRead,
                Role.CredentialStatus,
            ].sort(),
        );
        expect(effectiveRoles([Role.Presentations]).sort()).toEqual(
            [
                Role.Presentations,
                Role.PresentationRequest,
                Role.PresentationRead,
            ].sort(),
        );
        expect(effectiveRoles([Role.KeysExport]).sort()).toEqual(
            [Role.KeysExport, Role.Keys].sort(),
        );
    });

    it("gives tenant:admin every role except tenants:manage", () => {
        expect(effectiveRoles([Role.TenantAdmin]).sort()).toEqual(
            allRoles.filter((role) => role !== Role.Tenants).sort(),
        );
    });

    it("gives tenants:manage every role", () => {
        expect(effectiveRoles([Role.Tenants]).sort()).toEqual(
            [...allRoles].sort(),
        );
    });

    it("keeps names that are no EUDIPLO role and adds nothing for them", () => {
        expect(
            effectiveRoles(["offline_access", Role.AuditRead]).sort(),
        ).toEqual(["offline_access", Role.AuditRead].sort());
    });

    it("implies only known roles and never a reserved one below tenant:admin", () => {
        for (const [role, implied] of Object.entries(impliedRoles)) {
            for (const name of implied) expect(allRoles).toContain(name);
            if (role !== Role.Tenants) {
                expect(effectiveRoles([role])).not.toContain(Role.Tenants);
            }
        }
    });

    it("has an entry for exactly the EUDIPLO roles", () => {
        expect(Object.keys(impliedRoles).sort()).toEqual([...allRoles].sort());
    });

    it("adds nothing for names that are object keys", () => {
        expect(
            effectiveRoles(["constructor", "__proto__", "toString"]),
        ).toEqual(
            expect.arrayContaining(["constructor", "__proto__", "toString"]),
        );
        expect(effectiveRoles(["constructor"])).toHaveLength(1);
    });
});
