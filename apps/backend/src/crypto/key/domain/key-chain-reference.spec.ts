import { describe, expect, it } from "vitest";
import {
    describeKeyChainReferences,
    isKeyChainReferenceKind,
    KeyChainInUseError,
    type KeyChainReference,
    keyChainIdNamesKeyChain,
    keyChainInUseMessage,
    keyChainReferenceId,
    keyChainReferencesVisibleTo,
} from "./key-chain-reference.js";

const keyChain = { tenantId: "acme", id: "signing" };

describe("keyChainIdNamesKeyChain", () => {
    it("matches the exact key chain ID only", () => {
        expect(keyChainIdNamesKeyChain("signing", keyChain)).toBe(true);
        expect(keyChainIdNamesKeyChain("signing-2", keyChain)).toBe(false);
        expect(keyChainIdNamesKeyChain("", keyChain)).toBe(false);
    });

    it("treats a missing value as the tenant's default key chain, not a reference", () => {
        expect(keyChainIdNamesKeyChain(undefined, keyChain)).toBe(false);
        expect(keyChainIdNamesKeyChain(null, keyChain)).toBe(false);
    });
});

describe("keyChainReferenceId", () => {
    it("carries no ID for the key chain defaults and the issuance configuration", () => {
        expect(
            keyChainReferenceId("KeyChainDefaults", "defaults"),
        ).toBeUndefined();
        expect(keyChainReferenceId("IssuanceConfig", "acme")).toBeUndefined();
        expect(keyChainReferenceId("StatusList", "list")).toBe("list");
    });
});

describe("isKeyChainReferenceKind", () => {
    it("accepts the kinds that can name a key chain", () => {
        expect(isKeyChainReferenceKind("TrustList")).toBe(true);
        expect(isKeyChainReferenceKind("KeyChain")).toBe(false);
    });
});

describe("describeKeyChainReferences", () => {
    it("names the configurations in a fixed kind order", () => {
        const references: KeyChainReference[] = [
            { kind: "TrustList", id: "pid-issuers" },
            { kind: "CredentialConfig", id: "pid" },
            { kind: "CredentialConfig", id: "mdl" },
            { kind: "IssuanceConfig" },
            { kind: "StatusList", id: "shared" },
            { kind: "PresentationConfig", id: "age" },
        ];

        expect(describeKeyChainReferences(references)).toBe(
            'the issuance configuration, 2 credential configs ("pid" and "mdl"), 1 presentation config ("age"), 1 status list ("shared") and 1 trust list ("pid-issuers")',
        );
    });

    it("names the tenant's key chain defaults first", () => {
        expect(
            describeKeyChainReferences([
                { kind: "PresentationConfig", id: "age" },
                { kind: "KeyChainDefaults" },
            ]),
        ).toBe(
            'the tenant\'s key chain defaults and 1 presentation config ("age")',
        );
    });

    it("names at most five IDs of one kind and counts the rest", () => {
        const references = Array.from({ length: 7 }, (_, index) => ({
            kind: "StatusList" as const,
            id: `list-${index}`,
        }));

        expect(describeKeyChainReferences(references)).toBe(
            '7 status lists ("list-0", "list-1", "list-2", "list-3", "list-4" and 2 more)',
        );
    });

    it("counts hidden references and says which roles show them", () => {
        expect(
            describeKeyChainReferences([{ kind: "CredentialConfig" }], () => [
                "issuance:manage",
            ]),
        ).toBe("1 credential config (issuance:manage shows which)");
    });
});

describe("keyChainReferencesVisibleTo", () => {
    it("drops ID and description of kinds the caller may not read", () => {
        expect(
            keyChainReferencesVisibleTo(
                [
                    {
                        kind: "PresentationConfig",
                        id: "age",
                        description: "Age check",
                    },
                    { kind: "CredentialConfig", id: "pid", description: "PID" },
                ],
                (kind) => kind === "PresentationConfig",
            ),
        ).toEqual([
            { kind: "PresentationConfig", id: "age", description: "Age check" },
            { kind: "CredentialConfig" },
        ]);
    });
});

describe("KeyChainInUseError", () => {
    it("carries the references and the message", () => {
        const references: KeyChainReference[] = [{ kind: "IssuanceConfig" }];
        const error = new KeyChainInUseError("signing", references);

        expect(error.references).toBe(references);
        expect(error.message).toBe(keyChainInUseMessage("signing", references));
        expect(error.message).toBe(
            'Key chain "signing" is still used by the issuance configuration. Remove these references before deleting the key chain.',
        );
    });
});
