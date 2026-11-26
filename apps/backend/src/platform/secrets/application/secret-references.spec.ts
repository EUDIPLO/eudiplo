import { describe, expect, it } from "vitest";
import { stubSecretReferences } from "../../../../test/secrets/secret-test-sources.js";
import {
    SecretMissingError,
    SecretReferenceInvalidError,
    SecretReferenceRefusedError,
} from "../domain/secret-errors.js";
import type { SecretUse } from "../domain/secret-use.js";
import { SecretReferences } from "./secret-references.js";

const use: SecretUse = {
    scope: { type: "tenant", tenantId: "acme" },
    field: "WebhookEndpoint:auth.config.value",
    destination: "https://shop.example/hook",
};
const own = "${vault:kv/eudiplo/acme/shop#token}";

describe("SecretReferences", () => {
    it("treats every value as a literal without a policy", async () => {
        const secrets = new SecretReferences();

        expect(secrets.enabled).toBe(false);
        expect(secrets.isReference(own)).toBe(false);
        expect(() =>
            secrets.assertAllowed("${vault:kv/other#x}", use),
        ).not.toThrow();
        expect((await secrets.valueOf(own, use)).reveal()).toBe(own);
    });

    it("resolves a granted reference and passes a literal through", async () => {
        const { secrets, vault } = stubSecretReferences();
        vault.values.set("kv/eudiplo/acme/shop#token", "s3cret");

        expect(secrets.enabled).toBe(true);
        expect(secrets.isReference(own)).toBe(true);
        expect(secrets.isReference("plain-key")).toBe(false);
        expect((await secrets.valueOf(own, use)).reveal()).toBe("s3cret");
        expect((await secrets.valueOf("plain-key", use)).reveal()).toBe(
            "plain-key",
        );
    });

    it("shows only well-formed references", () => {
        expect(new SecretReferences().isShown(own)).toBe(false);
        const { secrets } = stubSecretReferences();
        expect(secrets.isShown(own)).toBe(true);
        expect(secrets.isShown("${vault:kv}")).toBe(false);
        expect(secrets.isShown("${foo:bar}")).toBe(false);
        expect(secrets.isShown("plain-key")).toBe(false);
    });

    it("checks references before they are stored, without reading them", () => {
        const { secrets, vault } = stubSecretReferences();

        expect(() => secrets.assertAllowed(own, use)).not.toThrow();
        expect(() => secrets.assertAllowed("plain-key", use)).not.toThrow();
        expect(() =>
            secrets.assertAllowed("${vault:kv/eudiplo/bob/shop#token}", use),
        ).toThrow(SecretReferenceRefusedError);
        // A malformed reference is refused rather than kept as text.
        expect(() => secrets.assertAllowed("${vault:kv}", use)).toThrow(
            SecretReferenceInvalidError,
        );
        expect(() => secrets.assertAllowed("${foo:bar}", use)).toThrow(
            SecretReferenceInvalidError,
        );
        expect(vault.reads).toBe(0);
    });

    it("reports a granted reference without a value as missing", async () => {
        const { secrets } = stubSecretReferences();

        await expect(secrets.valueOf(own, use)).rejects.toBeInstanceOf(
            SecretMissingError,
        );
    });
});
