import { describe, expect, it } from "vitest";
import {
    rolesBeforeRoleModel11,
    upgradeRolesToRoleModel11,
} from "./client-roles.js";

describe("upgradeRolesToRoleModel11", () => {
    it.each([
        [["clients:manage"], ["clients:manage", "audit:read"]],
        [["issuance:manage"], ["issuance:manage", "keys:manage"]],
        [["presentation:manage"], ["presentation:manage", "keys:manage"]],
        [
            ["clients:manage", "presentation:manage"],
            ["clients:manage", "presentation:manage", "audit:read", "keys:manage"],
        ],
        [["clients:manage", "audit:read"], ["clients:manage", "audit:read"]],
        [["issuance:offer"], ["issuance:offer"]],
        [["tenant:admin", "clients:manage"], ["tenant:admin", "clients:manage"]],
        [["tenants:manage", "issuance:manage"], ["tenants:manage", "issuance:manage"]],
        [[], []],
    ])("turns %j into %j", (before, after) => {
        expect(upgradeRolesToRoleModel11(before)).toEqual(after);
    });

    it("adds nothing on a second run", () => {
        const once = upgradeRolesToRoleModel11(["clients:manage", "issuance:manage"]);
        expect(upgradeRolesToRoleModel11(once)).toEqual(once);
    });
});

describe("rolesBeforeRoleModel11", () => {
    it("lists every role list that upgrades to the given one", () => {
        expect(
            rolesBeforeRoleModel11([
                "clients:manage",
                "issuance:manage",
                "audit:read",
                "keys:manage",
            ]),
        ).toEqual([
            ["clients:manage", "issuance:manage", "audit:read"],
            ["clients:manage", "issuance:manage"],
        ]);
        expect(rolesBeforeRoleModel11(["clients:manage", "audit:read"])).toEqual([
            ["clients:manage"],
        ]);
    });

    it("lists nothing when the roles cannot be the result of an upgrade", () => {
        expect(rolesBeforeRoleModel11(["issuance:offer"])).toEqual([]);
        // keys:manage at the end, but nothing that would have added it
        expect(rolesBeforeRoleModel11(["issuance:offer", "keys:manage"])).toEqual(
            [],
        );
        expect(
            rolesBeforeRoleModel11(["tenant:admin", "clients:manage", "audit:read"]),
        ).toEqual([]);
    });
});
