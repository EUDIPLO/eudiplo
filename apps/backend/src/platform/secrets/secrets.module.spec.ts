import { describe, expect, it } from "vitest";
import { SecretPolicyError } from "./domain/secret-errors.js";
import { createSecretReferences } from "./secrets.module.js";

const config = (path?: string) => ({
    get: <T>(key: string) =>
        (key === "SECRET_POLICY_FILE" ? path : undefined) as T,
});

describe("createSecretReferences", () => {
    it("reads no references without SECRET_POLICY_FILE", () => {
        const read = () => {
            throw new Error("no file is read");
        };
        expect(createSecretReferences(config(), {}, read).enabled).toBe(false);
        expect(createSecretReferences(config(""), {}, read).enabled).toBe(
            false,
        );
    });

    it("reads references under the policy of the file", async () => {
        const secrets = createSecretReferences(
            config("/etc/eudiplo/secret-policy.json"),
            { ACME_SHOP_TOKEN: "s3cret" },
            () => JSON.stringify({ tenants: { acme: { env: ["ACME_*"] } } }),
        );

        expect(secrets.enabled).toBe(true);
        const value = await secrets.valueOf("${env:ACME_SHOP_TOKEN}", {
            scope: { type: "tenant", tenantId: "acme" },
            field: "WebhookEndpoint:auth.config.value",
        });
        expect(value.reveal()).toBe("s3cret");
    });

    it("stops the startup when the file cannot be read or is invalid", () => {
        expect(() =>
            createSecretReferences(config("/missing.json"), {}, () => {
                throw Object.assign(new Error("gone"), { code: "ENOENT" });
            }),
        ).toThrow(/SECRET_POLICY_FILE \/missing\.json cannot be read: ENOENT/);
        expect(() =>
            createSecretReferences(config("/p.json"), {}, () => "[]"),
        ).toThrow(SecretPolicyError);
    });
});
