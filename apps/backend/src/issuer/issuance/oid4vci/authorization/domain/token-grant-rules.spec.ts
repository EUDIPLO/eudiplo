import { calculateJwkThumbprint } from "jose";
import { describe, expect, it } from "vitest";
import { assertS256CodeChallenge, checkPkce } from "./pkce.js";
import { assertValidPushedAuthorizationRequest } from "./pushed-authorization-request.js";
import {
    assertIssuedToClient,
    authorizationDetailsForToken,
    clientInstanceKeyThumbprint,
    findBuiltInAuthorizationServer,
    isTxCodeLocked,
    resolveRefreshTokenPolicy,
} from "./token-grant-rules.js";

const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
    `${b64({ alg: "ES256" })}.${b64(payload)}.sig`;

describe("checkPkce", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const s256 = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    it("verifies S256 and plain challenges", () => {
        expect(checkPkce(s256, "S256", verifier)).toBe("valid");
        expect(checkPkce(s256, "S256", "other")).toBe("mismatch");
        expect(checkPkce("abc", "plain", "abc")).toBe("valid");
        expect(checkPkce("abc", undefined, "abc")).toBe("valid");
        expect(checkPkce(verifier, "S256", verifier)).toBe("mismatch");
    });

    it("requires a verifier only when a challenge was stored", () => {
        expect(checkPkce(s256, "S256", undefined)).toBe("missing_verifier");
        expect(checkPkce(s256, "S256", "")).toBe("missing_verifier");
        expect(checkPkce(undefined, undefined, undefined)).toBe("valid");
        expect(checkPkce(undefined, "S256", "anything")).toBe("valid");
    });
});

describe("assertS256CodeChallenge", () => {
    const s256 = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    it("accepts an S256 challenge", () => {
        expect(() => assertS256CodeChallenge(s256, "S256")).not.toThrow();
    });

    it("rejects a missing challenge", () => {
        expect(() => assertS256CodeChallenge(undefined, "S256")).toThrow(
            expect.objectContaining({ code: "invalid_request" }),
        );
        expect(() => assertS256CodeChallenge("", "S256")).toThrow(
            expect.objectContaining({ code: "invalid_request" }),
        );
    });

    it("rejects plain and a missing method", () => {
        expect(() => assertS256CodeChallenge(s256, "plain")).toThrow(
            expect.objectContaining({ code: "invalid_request" }),
        );
        expect(() => assertS256CodeChallenge(s256, undefined)).toThrow(
            expect.objectContaining({ code: "invalid_request" }),
        );
    });
});

describe("resolveRefreshTokenPolicy", () => {
    it("defaults to enabled with 30 days", () => {
        expect(resolveRefreshTokenPolicy({})).toEqual({
            enabled: true,
            expiresInSeconds: 2592000,
        });
    });

    it("uses the first enabled non-external server with token settings", () => {
        expect(
            resolveRefreshTokenPolicy({
                authorizationServers: [
                    { type: "external", token: { refreshTokenEnabled: false } },
                    {
                        type: "built-in",
                        enabled: false,
                        token: { refreshTokenEnabled: false },
                    },
                    {
                        type: "oid4vp",
                        token: { refreshTokenExpiresInSeconds: 60 },
                    },
                ],
            }),
        ).toEqual({ enabled: true, expiresInSeconds: 60 });
    });
});

describe("findBuiltInAuthorizationServer", () => {
    it("returns the enabled built-in entry", () => {
        const builtIn = { type: "built-in", walletAttestationRequired: true };
        expect(
            findBuiltInAuthorizationServer({
                authorizationServers: [
                    { type: "built-in", enabled: false },
                    builtIn,
                ],
            }),
        ).toBe(builtIn);
        expect(findBuiltInAuthorizationServer({})).toBeUndefined();
    });
});

describe("isTxCodeLocked", () => {
    it("locks at the maximum", () => {
        expect(isTxCodeLocked(undefined, 5)).toBe(false);
        expect(isTxCodeLocked(4, 5)).toBe(false);
        expect(isTxCodeLocked(5, 5)).toBe(true);
    });
});

describe("assertIssuedToClient", () => {
    const attestation = jwt({ sub: "wallet" });

    it("rejects a client_id that contradicts the attestation", () => {
        expect(() =>
            assertIssuedToClient(undefined, "other", attestation),
        ).toThrow(
            expect.objectContaining({
                code: "invalid_client",
                description: "client_id does not match the client attestation",
            }),
        );
    });

    it("rejects a code redeemed by another client", () => {
        expect(() => assertIssuedToClient("a", "b", undefined)).toThrow(
            expect.objectContaining({ code: "invalid_grant" }),
        );
        expect(() => assertIssuedToClient("a", undefined, attestation)).toThrow(
            expect.objectContaining({ code: "invalid_grant" }),
        );
    });

    it("accepts matching or absent identifiers", () => {
        expect(() =>
            assertIssuedToClient("wallet", "wallet", attestation),
        ).not.toThrow();
        expect(() =>
            assertIssuedToClient("a", undefined, undefined),
        ).not.toThrow();
        expect(() =>
            assertIssuedToClient(undefined, "x", undefined),
        ).not.toThrow();
    });
});

describe("clientInstanceKeyThumbprint", () => {
    it("hashes cnf.jwk of the attestation", async () => {
        const jwk = {
            kty: "OKP",
            crv: "Ed25519",
            x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
        };
        expect(await clientInstanceKeyThumbprint(jwt({ cnf: { jwk } }))).toBe(
            await calculateJwkThumbprint(jwk, "sha256"),
        );
        expect(await clientInstanceKeyThumbprint(jwt({}))).toBeUndefined();
        expect(await clientInstanceKeyThumbprint(undefined)).toBeUndefined();
    });
});

describe("authorizationDetailsForToken", () => {
    it("keeps openid_credential entries of the authorization request", () => {
        expect(
            authorizationDetailsForToken({
                auth_queries: {
                    authorization_details: [
                        {
                            type: "openid_credential",
                            credential_configuration_id: "pid",
                        },
                        {
                            type: "openid_credential",
                            credential_configuration_id: "",
                        },
                        { type: "other", credential_configuration_id: "x" },
                    ],
                },
                credentialPayload: { credentialConfigurationIds: ["ignored"] },
            }),
        ).toEqual([
            {
                type: "openid_credential",
                credential_configuration_id: "pid",
                credential_identifiers: ["pid"],
            },
        ]);
    });

    it("falls back to the offer for malformed or empty requests", () => {
        const offer = { credentialConfigurationIds: ["a"] };
        const expected = [
            {
                type: "openid_credential",
                credential_configuration_id: "a",
                credential_identifiers: ["a"],
            },
        ];
        expect(
            authorizationDetailsForToken({
                auth_queries: { authorization_details: "{not json" },
                credentialPayload: offer,
            }),
        ).toEqual(expected);
        expect(
            authorizationDetailsForToken({
                auth_queries: { authorization_details: "[]" },
                credentialPayload: offer,
            }),
        ).toEqual(expected);
        expect(authorizationDetailsForToken({})).toBeUndefined();
    });
});

describe("assertValidPushedAuthorizationRequest", () => {
    it("accepts a FAPI 2.0 request", () => {
        expect(() =>
            assertValidPushedAuthorizationRequest({
                response_type: "code",
                client_id: "c",
                redirect_uri: "https://c/cb",
                code_challenge: "x",
                code_challenge_method: "S256",
            }),
        ).not.toThrow();
    });

    it("reports the first violated rule", () => {
        expect(() =>
            assertValidPushedAuthorizationRequest({ request_uri: "urn:x" }),
        ).toThrow(
            expect.objectContaining({
                code: "invalid_request",
                description:
                    "The request_uri parameter must not be sent to the PAR endpoint",
            }),
        );
        expect(() => assertValidPushedAuthorizationRequest({})).toThrow(
            expect.objectContaining({ code: "unsupported_response_type" }),
        );
    });
});
