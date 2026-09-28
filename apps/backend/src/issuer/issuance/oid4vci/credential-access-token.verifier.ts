import { Inject, Injectable } from "@nestjs/common";
import {
    type AuthorizationServerMetadata,
    type HttpMethod,
    type Jwk,
    SupportedAuthenticationScheme,
} from "@openid4vc/oauth2";
import type { IssuerMetadataResult } from "@openid4vc/openid4vci";
import { dpopProofVerification } from "./authorization/shared/dpop.util.js";
import { Oid4vciSdkFactory } from "./oid4vci-sdk.factory.js";
import { OID4VCI_SETTINGS, type Oid4vciSettings } from "./oid4vci-settings.js";
import {
    DPOP_PROOF_REPLAY_REGISTRY,
    type DpopProofReplayRegistry,
} from "./ports/dpop-proof-replay-registry.js";
import type { Oid4vciRequestContext } from "./request-context.js";
import { normalizeRequestHeaders } from "./util.js";

/** OAuth2 access token payload accepted by the credential issuer endpoints. */
export type CredentialAccessTokenPayload = {
    [x: string]: unknown;
    iss: string;
    exp: number;
    iat: number;
    aud: string | string[];
    sub: string;
    jti: string;
    client_id?: string;
    scope?: string;
    nbf?: number;
    nonce?: string;
    cnf?: { jwk?: Jwk };
};

/**
 * Verifies the access token (DPoP, or Bearer when DPoP is not required) sent
 * to the credential, deferred credential and notification endpoints.
 * Throws the SDK's resource-request errors, which carry `WWW-Authenticate`
 * details.
 */
@Injectable()
export class CredentialAccessTokenVerifier {
    constructor(
        private readonly sdk: Oid4vciSdkFactory,
        @Inject(OID4VCI_SETTINGS) private readonly settings: Oid4vciSettings,
        @Inject(DPOP_PROOF_REPLAY_REGISTRY)
        private readonly dpopProofs: DpopProofReplayRegistry,
    ) {}

    async verify(
        request: Oid4vciRequestContext,
        tenantId: string,
        issuerMetadata: IssuerMetadataResult,
        dPopRequired: boolean | undefined,
    ): Promise<CredentialAccessTokenPayload> {
        const allowedAuthenticationSchemes = [
            SupportedAuthenticationScheme.DPoP,
        ];
        if (!dPopRequired) {
            allowedAuthenticationSchemes.push(
                SupportedAuthenticationScheme.Bearer,
            );
        }

        const { tokenPayload } = await this.sdk
            .resourceServer(tenantId)
            .verifyResourceRequest({
                authorizationServers: this.withInternalJwksUri(
                    tenantId,
                    issuerMetadata.authorizationServers,
                ),
                request: {
                    url: `${this.settings.publicUrl}${request.url}`,
                    method: request.method as HttpMethod,
                    headers: normalizeRequestHeaders(request.headers),
                },
                resourceServer:
                    issuerMetadata.credentialIssuer.credential_issuer,
                allowedAuthenticationSchemes,
                dpop: dpopProofVerification(this.dpopProofs),
            });

        return tokenPayload as CredentialAccessTokenPayload;
    }

    /**
     * When `INTERNAL_URL` is set, the built-in authorization server's JWKS is
     * addressed through it instead of the public URL.
     */
    withInternalJwksUri(
        tenantId: string,
        authorizationServers: AuthorizationServerMetadata[],
    ): AuthorizationServerMetadata[] {
        const internalUrl = this.settings.internalUrl;
        if (!internalUrl) {
            return authorizationServers;
        }

        const builtInIssuer = `${this.settings.publicUrl}/issuers/${tenantId}`;
        const jwksUri = `${internalUrl.replace(/\/$/, "")}/.well-known/jwks.json/issuers/${tenantId}`;

        return authorizationServers.map((authorizationServer) =>
            authorizationServer.issuer === builtInIssuer
                ? { ...authorizationServer, jwks_uri: jwksUri }
                : authorizationServer,
        );
    }
}
