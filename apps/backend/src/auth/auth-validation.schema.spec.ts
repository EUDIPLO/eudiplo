import { describe, expect, it } from "vitest";
import { AUTH_VALIDATION_SCHEMA } from "./auth-validation.schema.js";

const keycloak = {
    OIDC: "https://keycloak.example.com/realms/eudiplo",
    OIDC_CLIENT_ID: "eudiplo-admin",
    OIDC_CLIENT_SECRET: "secret",
};
const builtIn = {
    MASTER_SECRET: "x".repeat(32),
    AUTH_CLIENT_ID: "root",
    AUTH_CLIENT_SECRET: "secret",
};

describe("OIDC_AUDIENCE", () => {
    it("is optional in OIDC mode", () => {
        expect(AUTH_VALIDATION_SCHEMA.validate(keycloak).error).toBeUndefined();
        expect(
            AUTH_VALIDATION_SCHEMA.validate({
                ...keycloak,
                OIDC_AUDIENCE: "https://eudiplo.example.com/api",
            }).error,
        ).toBeUndefined();
    });

    it("is refused without OIDC, where it would check nothing", () => {
        expect(
            AUTH_VALIDATION_SCHEMA.validate({
                ...builtIn,
                OIDC_AUDIENCE: "https://eudiplo.example.com/api",
            }).error?.message,
        ).toBe(
            "OIDC_AUDIENCE only applies in OIDC mode: set OIDC or remove it",
        );
        expect(AUTH_VALIDATION_SCHEMA.validate(builtIn).error).toBeUndefined();
    });
});
