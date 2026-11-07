import { describe, expect, it } from "vitest";
import { claimValue, roleNames } from "./token-claims.js";

describe("claimValue", () => {
    const payload = {
        roles: ["issuance:offer"],
        "https://eudiplo.example.com/roles": ["tenant:admin"],
        "a.b": "exact",
        a: { b: "nested" },
        resource_access: { eudiplo: { roles: ["keys:manage"] } },
    };

    it("reads a top-level claim", () => {
        expect(claimValue(payload, "roles")).toEqual(["issuance:offer"]);
    });

    it("reads a namespaced claim whose name contains dots", () => {
        expect(
            claimValue(payload, "https://eudiplo.example.com/roles"),
        ).toEqual(["tenant:admin"]);
    });

    it("prefers a claim with exactly the name over a path", () => {
        expect(claimValue(payload, "a.b")).toBe("exact");
    });

    it("follows a dot path into nested claims", () => {
        expect(claimValue(payload, "resource_access.eudiplo.roles")).toEqual([
            "keys:manage",
        ]);
    });

    it.each([
        "missing",
        "resource_access.other.roles",
        "roles.0.x",
        "constructor",
        "a.b.constructor",
        "__proto__.polluted",
    ])("finds nothing for %s", (name) => {
        expect(claimValue(payload, name)).toBeUndefined();
    });
});

describe("roleNames", () => {
    it("takes the strings of an array", () => {
        expect(roleNames(["issuance:offer", 7, null, "keys:manage"])).toEqual([
            "issuance:offer",
            "keys:manage",
        ]);
    });

    it("takes the keys of an object, as Zitadel's project roles", () => {
        expect(
            roleNames({
                "issuance:manage": { "123": "acme.zitadel.cloud" },
                "sessions:read": { "123": "acme.zitadel.cloud" },
            }),
        ).toEqual(["issuance:manage", "sessions:read"]);
    });

    it.each([undefined, null, "issuance:offer", 42])(
        "finds no roles in %s",
        (claim) => {
            expect(roleNames(claim)).toEqual([]);
        },
    );
});
