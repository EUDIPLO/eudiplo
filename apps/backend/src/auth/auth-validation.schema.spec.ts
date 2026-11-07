import { describe, expect, it } from "vitest";
import { AUTH_VALIDATION_SCHEMA } from "./auth-validation.schema.js";

describe("AUTH_VALIDATION_SCHEMA OIDC_UI_URL", () => {
    const oidc = {
        OIDC: "https://keycloak.example/realms/eudiplo",
        OIDC_CLIENT_ID: "eudiplo-admin",
        OIDC_CLIENT_SECRET: "secret",
    };

    it("accepts an unset, empty or valid list", () => {
        for (const env of [
            oidc,
            { ...oidc, OIDC_UI_URL: "" },
            {
                ...oidc,
                OIDC_UI_URL:
                    "https://console.example, https://example.com/eudiplo-client/",
            },
        ]) {
            expect(AUTH_VALIDATION_SCHEMA.validate(env).error).toBeUndefined();
        }
    });

    it("rejects wildcards and names the invalid URLs", () => {
        const { error } = AUTH_VALIDATION_SCHEMA.validate({
            ...oidc,
            OIDC_UI_URL: "https://console.example,*",
        });

        expect(error?.message).toContain("invalid URLs: *.");
        expect(error?.message).not.toContain("https://console.example,");
    });
});
