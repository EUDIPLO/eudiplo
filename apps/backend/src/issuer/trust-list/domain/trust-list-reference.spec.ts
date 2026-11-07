import { describe, expect, it } from "vitest";
import {
    isTrustListReferenceKind,
    managedTrustListAt,
    referencesVisibleTo,
    TrustListInUseError,
    type TrustListReference,
    trustListInUseMessage,
    trustListReferenceId,
    trustListRefNamesList,
    urlNamesTrustList,
} from "./trust-list-reference.js";

const list = { tenantId: "acme", id: "pid-issuers" };

describe("urlNamesTrustList", () => {
    it.each([
        "<TENANT_URL>/trust-list/pid-issuers",
        "https://eudiplo.example/issuers/acme/trust-list/pid-issuers",
        "https://eudiplo.example/issuers/acme/trust-list/pid-issuers/",
        "https://eudiplo.example/issuers/acme/trust-list/pid-issuers?v=2#x",
        "https://other.example/base/issuers/acme/trust-list/pid-issuers",
        "https://eudiplo.example/issuers/%61cme/trust-list/pid%2Dissuers",
    ])("matches %s", (url) => {
        expect(urlNamesTrustList(url, list)).toBe(true);
    });

    it.each([
        "https://eudiplo.example/issuers/other/trust-list/pid-issuers",
        "https://eudiplo.example/issuers/acme/trust-list/pid-issuers-old",
        "<TENANT_URL>/trust-list/pid-issuers-old",
        "https://lists.example/trust-list/pid-issuers",
        "https://eudiplo.example/issuers/acme/trust-list/%E0%A4%A",
        "pid-issuers",
        "",
    ])("does not match %s", (url) => {
        expect(urlNamesTrustList(url, list)).toBe(false);
    });

    it("ignores values that are not strings", () => {
        expect(urlNamesTrustList(undefined, list)).toBe(false);
        expect(urlNamesTrustList(42, list)).toBe(false);
    });
});

describe("trustListRefNamesList", () => {
    it("matches a trustListId, trimmed, or a URL", () => {
        expect(
            trustListRefNamesList({ trustListId: "pid-issuers" }, list),
        ).toBe(true);
        expect(
            trustListRefNamesList({ trustListId: " pid-issuers " }, list),
        ).toBe(true);
        expect(
            trustListRefNamesList(
                { url: "<TENANT_URL>/trust-list/pid-issuers" },
                list,
            ),
        ).toBe(true);
    });

    it("does not match other lists or malformed entries", () => {
        expect(trustListRefNamesList({ trustListId: "other" }, list)).toBe(
            false,
        );
        expect(trustListRefNamesList("pid-issuers", list)).toBe(false);
        expect(trustListRefNamesList(null, list)).toBe(false);
        expect(trustListRefNamesList({ trustListId: 1 }, list)).toBe(false);
    });
});

describe("TrustListInUseError", () => {
    it("names each kind with its IDs", () => {
        const references: TrustListReference[] = [
            { kind: "CredentialConfig", id: "membership" },
            { kind: "PresentationConfig", id: "pid" },
            { kind: "PresentationConfig", id: "age-over-18" },
            { kind: "IssuanceConfig" },
        ];

        expect(new TrustListInUseError("pid-issuers", references).message).toBe(
            'Trust list "pid-issuers" is still referenced by 2 presentation configs ("pid" and "age-over-18"), 1 credential config ("membership") and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.',
        );
    });

    it("names the first five IDs of a kind and counts the rest", () => {
        const references: TrustListReference[] = [
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
            "g",
        ].map((id) => ({ kind: "PresentationConfig", id }));

        expect(new TrustListInUseError("list", references).message).toBe(
            'Trust list "list" is still referenced by 7 presentation configs ("a", "b", "c", "d", "e" and 2 more). Remove these references before deleting the trust list.',
        );
    });

    it("keeps the references", () => {
        const references: TrustListReference[] = [{ kind: "IssuanceConfig" }];
        const error = new TrustListInUseError("list", references);

        expect(error.references).toBe(references);
        expect(error.trustListId).toBe("list");
        expect(error.message).toBe(
            'Trust list "list" is still referenced by the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.',
        );
    });
});

describe("referencesVisibleTo", () => {
    const readRoles = (kind: string) =>
        kind === "PresentationConfig"
            ? ["presentation:manage", "presentation:request"]
            : ["issuance:manage"];

    const references: TrustListReference[] = [
        { kind: "PresentationConfig", id: "pid", description: "PID check" },
        { kind: "CredentialConfig", id: "membership", description: "Card" },
        { kind: "CredentialConfig", id: "badge" },
        { kind: "IssuanceConfig" },
    ];

    it("drops ID and description of kinds the caller may not read and keeps the count", () => {
        const visible = referencesVisibleTo(
            references,
            (kind) => kind === "PresentationConfig",
        );

        expect(visible).toEqual([
            { kind: "PresentationConfig", id: "pid", description: "PID check" },
            { kind: "CredentialConfig" },
            { kind: "CredentialConfig" },
            { kind: "IssuanceConfig" },
        ]);
        expect(trustListInUseMessage("list", visible, readRoles)).toBe(
            'Trust list "list" is still referenced by 1 presentation config ("pid"), 2 credential configs (issuance:manage shows which) and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.',
        );
    });

    it("names hidden presentation configs with the roles that read them", () => {
        const visible = referencesVisibleTo(references, () => false);

        expect(trustListInUseMessage("list", visible, readRoles)).toContain(
            "1 presentation config (presentation:manage or presentation:request shows which)",
        );
        expect(trustListInUseMessage("list", visible)).toContain(
            "1 presentation config,",
        );
        expect(JSON.stringify(visible)).not.toContain("membership");
    });
});

describe("trustListReferenceId", () => {
    it("keeps configuration IDs and drops the one of the issuance configuration", () => {
        expect(trustListReferenceId("PresentationConfig", "pid")).toBe("pid");
        expect(trustListReferenceId("CredentialConfig", "pid")).toBe("pid");
        expect(
            trustListReferenceId("IssuanceConfig", "issuance"),
        ).toBeUndefined();
    });
});

describe("isTrustListReferenceKind", () => {
    it("accepts only kinds that can reference a trust list", () => {
        expect(isTrustListReferenceKind("IssuanceConfig")).toBe(true);
        expect(isTrustListReferenceKind("TrustList")).toBe(false);
    });
});

describe("managedTrustListAt", () => {
    const bases = ["https://public.example/eudiplo/", "http://127.0.0.1:3000"];

    it.each([
        [
            "below PUBLIC_URL with a path",
            "https://public.example/eudiplo/issuers/acme/trust-list/list-1",
        ],
        [
            "below INTERNAL_URL",
            "http://127.0.0.1:3000/issuers/acme/trust-list/list-1",
        ],
        [
            "with a trailing slash, a query and a fragment",
            "https://PUBLIC.example/eudiplo/issuers/acme/trust-list/list-1/?a=b#c",
        ],
    ])("names the managed list for a URL %s", (_case, url) => {
        expect(managedTrustListAt(url, bases)).toEqual({
            tenantId: "acme",
            id: "list-1",
        });
    });

    it("decodes the tenant and list ID", () => {
        expect(
            managedTrustListAt(
                "http://127.0.0.1:3000/issuers/a%2Fb/trust-list/list%201",
                bases,
            ),
        ).toEqual({ tenantId: "a/b", id: "list 1" });
    });

    it.each([
        [
            "on another host",
            "https://other.example/eudiplo/issuers/acme/trust-list/list-1",
        ],
        [
            "on another port",
            "http://127.0.0.1:3001/issuers/acme/trust-list/list-1",
        ],
        [
            "outside the base path",
            "https://public.example/issuers/acme/trust-list/list-1",
        ],
        [
            "for another resource",
            "http://127.0.0.1:3000/issuers/acme/status-list/list-1",
        ],
        [
            "with more segments",
            "http://127.0.0.1:3000/issuers/acme/trust-list/list-1/versions",
        ],
        ["without an ID", "http://127.0.0.1:3000/issuers/acme/trust-list/"],
        ["that cannot be parsed", "<TENANT_URL>/trust-list/list-1"],
    ])("names no managed list for a URL %s", (_case, url) => {
        expect(managedTrustListAt(url, bases)).toBeUndefined();
    });
});
