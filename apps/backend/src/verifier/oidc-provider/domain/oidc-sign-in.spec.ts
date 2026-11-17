import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { OidcClient } from "./oidc-client.js";
import { OidcError } from "./oidc-error.js";
import {
    ACR_CROSS_DEVICE,
    ACR_SAME_DEVICE,
    type AuthorizationRequestParameters,
    hashOpaqueSecret,
    matchesOpaqueSecret,
    validateAuthorizationRequest,
} from "./oidc-sign-in.js";

const client: OidcClient = {
    id: "client",
    tenantId: "tenant",
    name: "Portal",
    redirectUris: ["https://rp.example.com/cb"],
    profile: "secure",
    scopes: [{ scope: "pid", presentationConfigId: "pid-config" }],
    secrets: [],
};

const challenge = createHash("sha256").update("verifier").digest("base64url");

const valid: AuthorizationRequestParameters = {
    response_type: "code",
    client_id: "client",
    redirect_uri: "https://rp.example.com/cb",
    scope: "openid pid",
    state: "xyz",
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
};

function errorOf(params: AuthorizationRequestParameters): OidcError {
    try {
        validateAuthorizationRequest(client, params);
    } catch (error) {
        if (error instanceof OidcError) return error;
        throw error;
    }
    throw new Error("expected an error");
}

describe("validateAuthorizationRequest", () => {
    test("accepts a valid request and maps the scope", () => {
        expect(validateAuthorizationRequest(client, valid)).toEqual({
            redirectUri: "https://rp.example.com/cb",
            state: "xyz",
            nonce: "n-1",
            scope: "openid pid",
            presentationConfigId: "pid-config",
            codeChallenge: challenge,
            requireSameDevice: false,
        });
    });

    test("an unregistered redirect URI is not redirected to", () => {
        const error = errorOf({
            ...valid,
            redirect_uri: "https://attacker.example/cb",
        });
        expect(error.code).toBe("invalid_request");
        expect(error.redirect).toBeUndefined();
    });

    test.each<[string, AuthorizationRequestParameters, string]>([
        ["no openid", { ...valid, scope: "pid" }, "invalid_scope"],
        [
            "two scopes",
            { ...valid, scope: "openid pid email" },
            "invalid_scope",
        ],
        ["only openid", { ...valid, scope: "openid" }, "invalid_scope"],
        ["unknown scope", { ...valid, scope: "openid email" }, "invalid_scope"],
        [
            "response type",
            { ...valid, response_type: "token" },
            "unsupported_response_type",
        ],
        [
            "request object",
            { ...valid, request: "eyJ..." },
            "request_not_supported",
        ],
        ["no PKCE", { ...valid, code_challenge: undefined }, "invalid_request"],
        [
            "plain PKCE",
            { ...valid, code_challenge_method: "plain" },
            "invalid_request",
        ],
        [
            "fragment response mode",
            { ...valid, response_mode: "fragment" },
            "invalid_request",
        ],
        ["prompt none", { ...valid, prompt: "none" }, "login_required"],
    ])("%s is redirected with the client's state", (_, params, code) => {
        const error = errorOf(params);
        expect(error.code).toBe(code);
        expect(error.redirect).toEqual({
            redirectUri: "https://rp.example.com/cb",
            state: "xyz",
        });
    });

    test("accepts prompt login and repeated openid", () => {
        expect(
            validateAuthorizationRequest(client, {
                ...valid,
                scope: "openid pid openid",
                prompt: "login consent",
            }).scope,
        ).toBe("openid pid");
    });

    test("acr_values naming only the same-device value requires it", () => {
        expect(
            validateAuthorizationRequest(client, {
                ...valid,
                acr_values: ACR_SAME_DEVICE,
            }).requireSameDevice,
        ).toBe(true);
        expect(
            validateAuthorizationRequest(client, {
                ...valid,
                acr_values: `${ACR_SAME_DEVICE} ${ACR_CROSS_DEVICE}`,
            }).requireSameDevice,
        ).toBe(false);
    });
});

test("matchesOpaqueSecret compares with the stored hash", () => {
    const hash = hashOpaqueSecret("cookie");
    expect(matchesOpaqueSecret(hash, "cookie")).toBe(true);
    expect(matchesOpaqueSecret(hash, "other")).toBe(false);
    expect(matchesOpaqueSecret(hash, undefined)).toBe(false);
    expect(matchesOpaqueSecret(null, "cookie")).toBe(false);
});
