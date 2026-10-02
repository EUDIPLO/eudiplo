import { Injectable } from "@nestjs/common";
import { type Jwk, Oauth2ResourceServer } from "@openid4vc/oauth2";
import { Openid4vciIssuer } from "@openid4vc/openid4vci";
import { CryptoService } from "../../../crypto/crypto.service.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import { builtInAccessTokenSettings } from "./authorization/domain/token-grant-rules.js";

/**
 * Creates tenant-scoped `@openid4vc` SDK instances wired to EUDIPLO's crypto
 * callbacks.
 */
@Injectable()
export class Oid4vciSdkFactory {
    constructor(
        private readonly cryptoService: CryptoService,
        private readonly issuanceService: IssuanceService,
    ) {}

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
     * HTTP call to our own JWKS endpoint is needed.
     */
    resourceServer(tenantId: string, sessionId?: string): Oauth2ResourceServer {
        return new Oauth2ResourceServer({
            callbacks: {
                ...this.cryptoService.getCallbackContext(tenantId, sessionId),
                getJwks: (jwksUri) => this.resolveLocalJwks(tenantId, jwksUri),
            },
        });
    }

    /** Returns undefined for foreign JWKS URIs so the library fetches them. */
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
