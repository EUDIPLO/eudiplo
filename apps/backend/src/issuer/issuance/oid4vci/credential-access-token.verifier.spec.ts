import {
    type AuthorizationServerMetadata,
    SupportedAuthenticationScheme,
} from "@openid4vc/oauth2";
import type { IssuerMetadataResult } from "@openid4vc/openid4vci";
import { describe, expect, it, vi } from "vitest";
import { CredentialAccessTokenVerifier } from "./credential-access-token.verifier.js";
import type { Oid4vciSdkFactory } from "./oid4vci-sdk.factory.js";

const builtIn = {
    issuer: "https://issuer.example/issuers/acme",
    jwks_uri: "https://issuer.example/.well-known/jwks.json/issuers/acme",
} as AuthorizationServerMetadata;
const external = {
    issuer: "https://external.example",
    jwks_uri: "https://external.example/jwks",
} as AuthorizationServerMetadata;

function setup(internalUrl?: string) {
    const verifyResourceRequest = vi
        .fn()
        .mockResolvedValue({ tokenPayload: { sub: "session" } });
    const sdk = {
        resourceServer: vi.fn(() => ({ verifyResourceRequest })),
    } as unknown as Oid4vciSdkFactory;
    const verifier = new CredentialAccessTokenVerifier(sdk, {
        publicUrl: "https://issuer.example",
        internalUrl,
    });
    return { verifier, verifyResourceRequest };
}

describe("CredentialAccessTokenVerifier", () => {
    it("uses INTERNAL_URL only for the built-in authorization server", () => {
        const { verifier } = setup("http://127.0.0.1:3000/");
        const servers = [builtIn, external];

        expect(verifier.withInternalJwksUri("acme", servers)).toEqual([
            {
                issuer: "https://issuer.example/issuers/acme",
                jwks_uri:
                    "http://127.0.0.1:3000/.well-known/jwks.json/issuers/acme",
            },
            external,
        ]);
        expect(servers[0].jwks_uri).toBe(builtIn.jwks_uri);
    });

    it("verifies against the public URL and allows Bearer unless DPoP is required", async () => {
        const { verifier, verifyResourceRequest } = setup();
        const metadata = {
            authorizationServers: [builtIn],
            credentialIssuer: {
                credential_issuer: "https://issuer.example/issuers/acme",
            },
        } as unknown as IssuerMetadataResult;
        const request = {
            method: "POST",
            url: "/issuers/acme/vci/notification",
            headers: { authorization: "Bearer token" },
            contentType: "application/json",
            body: {},
        };

        await expect(
            verifier.verify(request, "acme", metadata, false),
        ).resolves.toEqual({ sub: "session" });
        expect(verifyResourceRequest).toHaveBeenLastCalledWith(
            expect.objectContaining({
                authorizationServers: [builtIn],
                resourceServer: "https://issuer.example/issuers/acme",
                request: expect.objectContaining({
                    url: "https://issuer.example/issuers/acme/vci/notification",
                    method: "POST",
                }),
                allowedAuthenticationSchemes: [
                    SupportedAuthenticationScheme.DPoP,
                    SupportedAuthenticationScheme.Bearer,
                ],
            }),
        );

        await verifier.verify(request, "acme", metadata, true);
        expect(verifyResourceRequest).toHaveBeenLastCalledWith(
            expect.objectContaining({
                allowedAuthenticationSchemes: [
                    SupportedAuthenticationScheme.DPoP,
                ],
            }),
        );
    });
});
