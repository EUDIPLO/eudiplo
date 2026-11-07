import { describe, expect, it } from "vitest";
import { AUTH_VALIDATION_SCHEMA } from "./auth-validation.schema.js";

const KEYCLOAK = {
    OIDC: "https://keycloak.example.com/realms/eudiplo",
    OIDC_CLIENT_ID: "eudiplo-admin",
    OIDC_CLIENT_SECRET: "secret",
};

const GENERIC = {
    OIDC: "https://auth.example.com/application/o/eudiplo/",
    OIDC_PROVIDER: "generic",
    OIDC_AUDIENCE: "eudiplo-api",
};

function validate(env: Record<string, string>) {
    return AUTH_VALIDATION_SCHEMA.validate(env, { abortEarly: false });
}

describe("AUTH_VALIDATION_SCHEMA", () => {
    it("defaults to Keycloak in OIDC mode, as before OIDC_PROVIDER existed", () => {
        const { error, value } = validate(KEYCLOAK);

        expect(error).toBeUndefined();
        expect(value.OIDC_PROVIDER).toBe("keycloak");
        expect(value.OIDC_AUDIENCE).toBeUndefined();
    });

    it("still requires the admin client for Keycloak", () => {
        const { error } = validate({ OIDC: KEYCLOAK.OIDC });

        expect(error?.details.map((detail) => detail.path[0])).toEqual([
            "OIDC_CLIENT_ID",
            "OIDC_CLIENT_SECRET",
        ]);
    });

    it("accepts another provider without an admin client", () => {
        const { error, value } = validate(GENERIC);

        expect(error).toBeUndefined();
        expect(value.OIDC_INTERNAL_ISSUER_URL).toBe(GENERIC.OIDC);
    });

    it("requires an audience for another provider", () => {
        const { OIDC_AUDIENCE: _, ...withoutAudience } = GENERIC;

        expect(validate(withoutAudience).error?.message).toBe(
            '"OIDC_AUDIENCE" is required',
        );
    });

    it("rejects an unknown provider", () => {
        expect(
            validate({ ...GENERIC, OIDC_PROVIDER: "auth0" }).error?.message,
        ).toBe('"OIDC_PROVIDER" must be one of [keycloak, generic]');
    });

    it("still accepts empty admin client settings without OIDC", () => {
        const { error } = validate({
            MASTER_SECRET: "x".repeat(32),
            AUTH_CLIENT_ID: "root",
            AUTH_CLIENT_SECRET: "root",
            OIDC_CLIENT_ID: "",
            OIDC_CLIENT_SECRET: "",
        });

        expect(error).toBeUndefined();
    });

    it.each(["keycloak", "generic"])(
        "names the missing OIDC when OIDC_PROVIDER=%s is set without it",
        (provider) => {
            const { error } = validate({
                MASTER_SECRET: "x".repeat(32),
                AUTH_CLIENT_ID: "root",
                AUTH_CLIENT_SECRET: "root",
                OIDC_PROVIDER: provider,
            });

            expect(error?.details.map((detail) => detail.message)).toContain(
                '"OIDC_PROVIDER" needs "OIDC"',
            );
        },
    );

    it("leaves the provider settings alone without OIDC", () => {
        const { error, value } = validate({
            MASTER_SECRET: "x".repeat(32),
            AUTH_CLIENT_ID: "root",
            AUTH_CLIENT_SECRET: "root",
        });

        expect(error).toBeUndefined();
        expect(value.OIDC_PROVIDER).toBeUndefined();
    });
});

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
