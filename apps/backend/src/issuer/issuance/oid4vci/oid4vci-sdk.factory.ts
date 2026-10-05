import { HttpService } from "@nestjs/axios";
import { Inject, Injectable } from "@nestjs/common";
import { type Jwk, Oauth2ResourceServer } from "@openid4vc/oauth2";
import { Openid4vciIssuer } from "@openid4vc/openid4vci";
import { CryptoService } from "../../../crypto/crypto.service.js";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import {
    authorizationServerFetch,
    getAuthorizationServerJson,
} from "./adapters/authorization-server-http.js";
import { builtInAccessTokenSettings } from "./authorization/domain/token-grant-rules.js";
import { OID4VCI_SETTINGS, type Oid4vciSettings } from "./oid4vci-settings.js";

/**
 * Creates tenant-scoped `@openid4vc` SDK instances wired to EUDIPLO's crypto
 * callbacks.
 */
@Injectable()
export class Oid4vciSdkFactory {
    private readonly ownOrigins: string[];
    private readonly fetch: typeof fetch;

    constructor(
        private readonly cryptoService: CryptoService,
        private readonly issuanceService: IssuanceService,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
        http: HttpService,
        @Inject(OID4VCI_SETTINGS) settings: Oid4vciSettings,
    ) {
        this.ownOrigins = [settings.publicUrl, settings.internalUrl].filter(
            (url): url is string => Boolean(url),
        );
        this.fetch = authorizationServerFetch(http, outboundUrlPolicy);
    }

    issuer(tenantId: string, sessionId?: string): Openid4vciIssuer {
        return new Openid4vciIssuer({
            callbacks: this.cryptoService.getCallbackContext(
                tenantId,
                sessionId,
            ),
        });
    }

    /**
     * Resource server for access-token checks. JWKS of the built-in
     * authorization server are read from the local key chain, so no loopback
     * HTTP call to our own JWKS endpoint is needed. Other JWKS and token
     * introspection requests go through the outbound URL policy.
     */
    resourceServer(tenantId: string, sessionId?: string): Oauth2ResourceServer {
        return new Oauth2ResourceServer({
            callbacks: {
                ...this.cryptoService.getCallbackContext(tenantId, sessionId),
                getJwks: async (jwksUri) =>
                    (await this.resolveLocalJwks(tenantId, jwksUri)) ??
                    this.fetchJwks(jwksUri),
                fetch: this.fetch,
            },
        });
    }

    /**
     * JWKS of the other authorization servers. EUDIPLO's own origins skip the
     * outbound URL policy: the chained and OID4VP-based authorization servers
     * publish their keys under `PUBLIC_URL`.
     */
    private fetchJwks(jwksUri: string): Promise<{ keys: Jwk[] }> {
        return getAuthorizationServerJson(this.outboundUrlPolicy, jwksUri, {
            accept: "application/jwk-set+json, application/json",
            trustedOrigins: this.ownOrigins,
        });
    }

    /** Returns undefined for foreign JWKS URIs. */
    private async resolveLocalJwks(tenantId: string, jwksUri: string) {
        if (!jwksUri.endsWith(`/.well-known/jwks.json/issuers/${tenantId}`)) {
            return undefined;
        }

        const issuanceConfig = await this.issuanceService
            .getIssuanceConfiguration(tenantId)
            .catch(() => null);
        const signingKeyId =
            (issuanceConfig &&
                builtInAccessTokenSettings(issuanceConfig).signingKeyId) ||
            (await this.cryptoService.keyChainService.getKid(tenantId));
        const publicJwk = await this.cryptoService.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            signingKeyId,
        );

        return {
            keys: [{ ...publicJwk, kid: publicJwk.kid ?? signingKeyId } as Jwk],
        };
    }
}
