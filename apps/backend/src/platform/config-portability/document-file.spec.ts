import { describe, expect, it } from "vitest";
import {
    holdsUnresolvedPlaceholderAt,
    readDocumentFile,
    wholePlaceholderPaths,
} from "./document-file.js";
import { importedKeyProblems } from "./key-chain-document.js";

function document(kind: string, spec: Record<string, unknown>) {
    return { $schema: "x", kind, metadata: {}, spec } as any;
}

describe("readDocumentFile", () => {
    it("reads the escaped form in place and lists the placeholders", () => {
        const file = document("WebhookEndpoint", {
            name: "Hook $${A}",
            url: "https://example.com/?k=${B}",
            auth: { config: { value: "${C}" } },
        });

        expect(readDocumentFile(file)).toEqual([
            { path: "/url", placeholder: "${B}", whole: false },
            { path: "/auth/config/value", placeholder: "${C}", whole: true },
        ]);
        expect(file.spec).toEqual({
            name: "Hook ${A}",
            url: "https://example.com/?k=${B}",
            auth: { config: { value: "${C}" } },
        });
    });

    it("leaves a KMS configuration as it is: its file has no escaped form", () => {
        const spec = { providers: [{ id: "v", vaultToken: "$${A}" }] };
        const file = document("KmsConfig", structuredClone(spec));

        expect(readDocumentFile(file)).toBeUndefined();
        expect(file.spec).toEqual(spec);
    });
});

describe("holdsUnresolvedPlaceholderAt", () => {
    it("tells the text of an escaped form from a placeholder", () => {
        const file = document("PresentationConfig", {
            registration_cert: { jwt: "$${A}" },
            other: { jwt: "${B}" },
            keySource: { jwk: { d: "${C}" } },
        });
        const whole = wholePlaceholderPaths(readDocumentFile(file));
        const spec = file.spec;

        // Both read as "${…}" now; only one is a placeholder.
        expect(spec.registration_cert.jwt).toBe("${A}");
        expect(
            holdsUnresolvedPlaceholderAt(
                whole,
                "/registration_cert/jwt",
                spec.registration_cert.jwt,
            ),
        ).toBe(false);
        expect(
            holdsUnresolvedPlaceholderAt(whole, "/other/jwt", spec.other.jwt),
        ).toBe(true);
        // A placeholder inside the value counts.
        expect(
            holdsUnresolvedPlaceholderAt(
                whole,
                "/keySource/jwk",
                spec.keySource.jwk,
            ),
        ).toBe(true);
    });

    it("keeps the answer for a copy of the spec", () => {
        const file = document("PresentationConfig", {
            registration_cert: { jwt: "$${A}" },
        });
        const whole = wholePlaceholderPaths(readDocumentFile(file));
        const copy = structuredClone(file.spec);

        expect(
            holdsUnresolvedPlaceholderAt(
                whole,
                "/registration_cert/jwt",
                copy.registration_cert.jwt,
            ),
        ).toBe(false);
    });

    it("goes by the value for a spec that was not read as a document file", () => {
        expect(holdsUnresolvedPlaceholderAt(undefined, "/a", "${A}")).toBe(
            true,
        );
        expect(holdsUnresolvedPlaceholderAt(undefined, "/a", "text")).toBe(
            false,
        );
    });

    it("lets the key check see an escaped value as the broken key it is", () => {
        const escaped = document("KeyChain", {
            keySource: { type: "private-jwk", jwk: "$${A}" },
        });
        const escapedWhole = wholePlaceholderPaths(readDocumentFile(escaped));
        expect(importedKeyProblems(escaped.spec, escapedWhole)).not.toEqual([]);

        const placeholder = document("KeyChain", {
            keySource: { type: "private-jwk", jwk: "${A}" },
        });
        const placeholderWhole = wholePlaceholderPaths(
            readDocumentFile(placeholder),
        );
        expect(importedKeyProblems(placeholder.spec, placeholderWhole)).toEqual(
            [],
        );
    });
});
