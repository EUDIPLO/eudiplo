import { describe, expect, it } from "vitest";
import { SecretPolicyError } from "./domain/secret-errors.js";
import { loadSecretSettings } from "./secrets.module.js";

const config = (path?: string) => ({
    get: <T>(key: string) =>
        (key === "SECRET_POLICY_FILE" ? path : undefined) as T,
});

describe("loadSecretSettings", () => {
    it("reads no references without SECRET_POLICY_FILE", () => {
        const read = () => {
            throw new Error("no file is read");
        };
        expect(loadSecretSettings(config(), {}, read).references.enabled).toBe(
            false,
        );
        expect(
            loadSecretSettings(config(""), {}, read).references.enabled,
        ).toBe(false);
    });

    it("reads references under the policy of the file", async () => {
        const { references: secrets } = loadSecretSettings(
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

    it("passes the allow-list for placeholders of tenant folders on", () => {
        const read = () => {
            throw new Error("no file is read");
        };
        // No file, no allow-list: the default rules decide.
        expect(loadSecretSettings(config(), {}, read).templates).toEqual({});
        expect(
            loadSecretSettings(config("/p.json"), {}, () =>
                JSON.stringify({ templates: { tenant: ["A_*"] } }),
            ).templates,
        ).toEqual({ tenant: ["A_*"] });
    });

    it("stops the startup when the file cannot be read or is invalid", () => {
        expect(() =>
            loadSecretSettings(config("/missing.json"), {}, () => {
                throw Object.assign(new Error("gone"), { code: "ENOENT" });
            }),
        ).toThrow(/SECRET_POLICY_FILE \/missing\.json cannot be read: ENOENT/);
        expect(() =>
            loadSecretSettings(config("/p.json"), {}, () => "[]"),
        ).toThrow(SecretPolicyError);
    });
});
