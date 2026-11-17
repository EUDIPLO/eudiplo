import { checkS256Pkce } from "../../../issuer/issuance/oid4vci/authorization/domain/pkce.js";
import type { OidcClient } from "../domain/oidc-client.js";
import { OidcError } from "../domain/oidc-error.js";
import {
    ID_TOKEN_LIFETIME_SECONDS,
    OidcSignInStatus,
} from "../domain/oidc-sign-in.js";
import {
    generateOpaqueSecret,
    hashOpaqueSecret,
} from "../domain/opaque-secret.js";
import { topLevelClaims } from "../domain/presented-claims.js";
import { oidcIssuer } from "../oidc-provider-settings.js";
import type { IdTokenSigner } from "../ports/id-token-signer.js";
import type { OidcSignInRepository } from "../ports/oidc-sign-in.repository.js";
import type { SignInPresentation } from "../ports/sign-in-presentation.js";

export interface TokenRequestParameters {
    grant_type?: string;
    code?: string;
    redirect_uri?: string;
    code_verifier?: string;
}

export interface OidcTokenResponse {
    /** Opaque; no endpoint of EUDIPLO accepts it. */
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    id_token: string;
    scope: string;
}

/**
 * Token endpoint (OpenID Connect Core 1.0 Section 3.1.3): exchange an
 * authorization code once for an ID token with the verified claims.
 */
export class RedeemAuthorizationCode {
    constructor(
        private readonly signIns: Pick<
            OidcSignInRepository,
            "findAuthorizedByCode" | "transition"
        >,
        private readonly presentations: Pick<SignInPresentation, "result">,
        private readonly signer: IdTokenSigner,
        private readonly publicUrl: string,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(
        client: OidcClient,
        params: TokenRequestParameters,
    ): Promise<OidcTokenResponse> {
        if (params.grant_type !== "authorization_code") {
            throw new OidcError(
                "unsupported_grant_type",
                "grant_type must be 'authorization_code'",
            );
        }
        if (!params.code) {
            throw new OidcError("invalid_request", "code is required");
        }
        const invalidGrant = () =>
            new OidcError(
                "invalid_grant",
                "The authorization code is invalid, expired or already used",
            );
        const signIn = await this.signIns.findAuthorizedByCode(
            client.tenantId,
            hashOpaqueSecret(params.code),
        );
        const now = this.now();
        if (
            !signIn ||
            signIn.clientId !== client.id ||
            !signIn.codeExpiresAt ||
            signIn.codeExpiresAt.getTime() <= now.getTime() ||
            !signIn.presentationSessionId
        ) {
            throw invalidGrant();
        }
        if (params.redirect_uri !== signIn.redirectUri) {
            throw new OidcError(
                "invalid_grant",
                "redirect_uri does not match the authorization request",
            );
        }
        if (
            checkS256Pkce(
                signIn.codeChallenge,
                "S256",
                params.code_verifier,
            ) !== "valid"
        ) {
            throw new OidcError("invalid_grant", "Invalid code_verifier");
        }
        // Single use: only one request can move the code to redeemed.
        const redeemed = await this.signIns.transition(
            client.tenantId,
            signIn.id,
            OidcSignInStatus.Authorized,
            { status: OidcSignInStatus.Redeemed, codeHash: null },
        );
        if (!redeemed) throw invalidGrant();

        const result = await this.presentations.result(
            client.tenantId,
            signIn.presentationSessionId,
        );
        if (result.status !== "completed") throw invalidGrant();

        const iat = Math.floor(now.getTime() / 1000);
        const claims: Record<string, unknown> = {
            // The token's own claims below always win over presented ones.
            ...(client.claimsFrom &&
                topLevelClaims(result.credentials, client.claimsFrom)),
            iss: oidcIssuer(this.publicUrl, client.tenantId),
            // A pairwise hash of the client's subject claim; without one,
            // new for every sign-in, since EUDIPLO keeps no account.
            sub: signIn.subject ?? signIn.presentationSessionId,
            aud: client.id,
            iat,
            exp: iat + ID_TOKEN_LIFETIME_SECONDS,
            auth_time: Math.floor((signIn.authTime ?? now).getTime() / 1000),
            ...(signIn.nonce && { nonce: signIn.nonce }),
            ...(signIn.acr && { acr: signIn.acr }),
            credentials: result.credentials ?? [],
        };
        const idToken = await this.signer.sign(client.tenantId, claims);
        return {
            access_token: generateOpaqueSecret(),
            token_type: "Bearer",
            expires_in: ID_TOKEN_LIFETIME_SECONDS,
            id_token: idToken,
            scope: signIn.scope,
        };
    }
}
