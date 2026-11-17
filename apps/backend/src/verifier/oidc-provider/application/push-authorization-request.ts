import { v4 } from "uuid";
import type { OidcClient } from "../domain/oidc-client.js";
import { OidcError } from "../domain/oidc-error.js";
import {
    type AuthorizationRequestParameters,
    OidcSignInStatus,
    PUSHED_REQUEST_LIFETIME_SECONDS,
    validateAuthorizationRequest,
} from "../domain/oidc-sign-in.js";
import type { OidcSignInRepository } from "../ports/oidc-sign-in.repository.js";
import type { SignInPresentation } from "../ports/sign-in-presentation.js";

export const REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

/**
 * Pushed authorization request (RFC 9126): validate the request of an
 * authenticated client and store it until the browser arrives.
 */
export class PushAuthorizationRequest {
    constructor(
        private readonly signIns: Pick<OidcSignInRepository, "insert">,
        private readonly presentations: Pick<
            SignInPresentation,
            "unusableReason"
        >,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(
        client: OidcClient,
        params: AuthorizationRequestParameters,
    ): Promise<{ request_uri: string; expires_in: number }> {
        if (params.client_id && params.client_id !== client.id) {
            throw new OidcError(
                "invalid_request",
                "client_id does not match the authenticated client",
            );
        }
        if (params.request_uri !== undefined) {
            throw new OidcError(
                "invalid_request",
                "request_uri must not be pushed",
            );
        }
        let request: ReturnType<typeof validateAuthorizationRequest>;
        try {
            request = validateAuthorizationRequest(client, params);
        } catch (error) {
            // The client gets PAR errors in the response, never by redirect.
            if (error instanceof OidcError) {
                throw new OidcError(error.code, error.description);
            }
            throw error;
        }
        const unusable = await this.presentations.unusableReason(
            client.tenantId,
            request.presentationConfigId,
            client.subject?.credentialId,
        );
        if (unusable) {
            throw new OidcError("invalid_scope", unusable);
        }

        const id = v4();
        await this.signIns.insert({
            id,
            tenantId: client.tenantId,
            clientId: client.id,
            redirectUri: request.redirectUri,
            state: request.state ?? null,
            nonce: request.nonce ?? null,
            scope: request.scope,
            presentationConfigId: request.presentationConfigId,
            codeChallenge: request.codeChallenge,
            requireSameDevice: request.requireSameDevice,
            status: OidcSignInStatus.Pushed,
            walletReturnedElsewhere: false,
            expiresAt: new Date(
                this.now().getTime() + PUSHED_REQUEST_LIFETIME_SECONDS * 1000,
            ),
        });
        return {
            request_uri: `${REQUEST_URI_PREFIX}${id}`,
            expires_in: PUSHED_REQUEST_LIFETIME_SECONDS,
        };
    }
}
