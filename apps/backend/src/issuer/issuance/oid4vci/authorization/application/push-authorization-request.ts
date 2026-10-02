import { randomUUID } from "node:crypto";
import {
    pushedAuthorizationRequestUriPrefix,
    type RequestLike,
} from "@openid4vc/oauth2";
import { v4 } from "uuid";
import type { CreateSession } from "../../../../../session/application/create-session.js";
import { SessionNotFound } from "../../../../../session/application/session-errors.js";
import type { SessionStore } from "../../../../../session/application/session-store.js";
import type { SessionAuthorization } from "../../../../../session/domain/session-data.js";
import type { DpopProofReplayRegistry } from "../../ports/dpop-proof-replay-registry.js";
import { OAuthError } from "../domain/oauth-error.js";
import { assertOfferRedeemable } from "../domain/offer-redemption.js";
import {
    assertValidPushedAuthorizationRequest,
    PAR_REQUEST_URI_LIFETIME_SECONDS,
} from "../domain/pushed-authorization-request.js";
import { oauthErrorFromLibrary } from "../domain/token-errors.js";
import { findBuiltInAuthorizationServer } from "../domain/token-grant-rules.js";
import { resolveWalletAttestationPolicy } from "../domain/wallet-attestation-policy.js";
import type { BuiltInAuthorizationServerConfiguration } from "../ports/built-in-authorization-server-configuration.js";
import type {
    ClientAttestation,
    ClientAttestationVerifier,
} from "../ports/client-attestation-verifier.js";
import type { OAuthAuthorizationServerFactory } from "../ports/oauth-authorization-server-factory.js";
import { dpopProofVerification } from "../shared/dpop.util.js";
import type { BuildBuiltInAuthorizationServerMetadata } from "./build-built-in-authorization-server-metadata.js";

export interface PushedAuthorizationRequest {
    tenantId: string;
    body: SessionAuthorization;
    /** Request as seen by the client: absolute URL and normalized headers. */
    request: RequestLike;
    dpopJwt?: string;
    clientAttestation?: ClientAttestation;
}

/**
 * Pushed Authorization Request endpoint (RFC 9126): authenticates the client
 * attestation, validates the FAPI 2.0 parameters and the DPoP proof (required
 * when the built-in entry sets `requireDPoP`), and binds a short-lived
 * `request_uri` to the issuance session.
 */
export class PushAuthorizationRequest {
    constructor(
        private readonly servers: OAuthAuthorizationServerFactory,
        private readonly sessions: Pick<
            SessionStore,
            "getForTenant" | "updateForTenant"
        >,
        private readonly createSession: Pick<CreateSession, "execute">,
        private readonly configuration: BuiltInAuthorizationServerConfiguration,
        private readonly metadata: Pick<
            BuildBuiltInAuthorizationServerMetadata,
            "execute"
        >,
        private readonly clientAttestation: ClientAttestationVerifier,
        private readonly dpopProofs: DpopProofReplayRegistry,
    ) {}

    async execute({
        tenantId,
        body,
        request,
        dpopJwt,
        clientAttestation,
    }: PushedAuthorizationRequest): Promise<{
        expires_in: number;
        request_uri: string;
    }> {
        const issuanceConfig =
            await this.configuration.issuanceConfiguration(tenantId);
        const authorizationServerMetadata =
            await this.metadata.execute(tenantId);
        const builtInServer = findBuiltInAuthorizationServer(issuanceConfig);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            builtInServer,
        );

        try {
            await this.clientAttestation.verify(
                tenantId,
                clientAttestation,
                authorizationServerMetadata.issuer,
                walletAttestationPolicy.walletAttestationRequired,
                walletAttestationPolicy.walletProviderTrustLists,
            );
        } catch (err) {
            throw new OAuthError(
                "invalid_client",
                "Client attestation validation failed",
                {
                    logDetail: `Client attestation validation failed for tenant ${tenantId}: ${err instanceof Error ? err.message : "Unknown error"}`,
                },
            );
        }

        assertValidPushedAuthorizationRequest(body);

        const { dpop } = await this.servers
            .forTenant(tenantId)
            .verifyPushedAuthorizationRequest({
                authorizationRequest: body,
                authorizationServerMetadata,
                request,
                dpop: {
                    // `requireDPoP` binds the authorization code to a DPoP key
                    // (RFC 9449 Section 10), as on the chained and OID4VP
                    // servers. Issuance `dPopRequired` applies from the
                    // token endpoint on.
                    required: !!builtInServer?.requireDPoP,
                    jwt: dpopJwt,
                    jwkThumbprint: body.dpop_jkt,
                    allowedSigningAlgs:
                        authorizationServerMetadata.dpop_signing_alg_values_supported,
                    ...dpopProofVerification(this.dpopProofs),
                },
            })
            .catch((err) => {
                throw oauthErrorFromLibrary(err);
            });

        // An issuer_state names the offer this request redeems.
        const offerSession = body.issuer_state
            ? await this.sessions
                  .getForTenant(tenantId, body.issuer_state)
                  .catch((error: unknown) => {
                      if (error instanceof SessionNotFound) return undefined;
                      throw error;
                  })
            : undefined;
        if (offerSession) {
            assertOfferRedeemable(offerSession, new Date(), "invalid_request");
        }

        const request_uri = `${pushedAuthorizationRequestUriPrefix}${randomUUID()}`;
        const parValues = {
            request_uri,
            request_uri_expires_at: new Date(
                Date.now() + PAR_REQUEST_URI_LIFETIME_SECONDS * 1000,
            ),
            auth_queries: body,
            dpop_jkt: dpop?.jwkThumbprint,
        };

        // A PAR request without a known issuer_state session (wallet-initiated
        // flow) gets a dedicated session for the authorization endpoint.
        const bound = body.issuer_state
            ? await this.sessions.updateForTenant(
                  tenantId,
                  body.issuer_state,
                  parValues,
              )
            : false;
        if (!bound) {
            await this.createSession.execute({
                id: v4(),
                tenantId,
                ...parValues,
            });
        }

        return { expires_in: PAR_REQUEST_URI_LIFETIME_SECONDS, request_uri };
    }
}
