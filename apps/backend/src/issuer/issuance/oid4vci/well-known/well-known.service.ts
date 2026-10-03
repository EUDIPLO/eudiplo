import { HttpStatus, Injectable } from "@nestjs/common";
import { CertService } from "../../../../crypto/key/cert/cert.service.js";
import { CryptoImplementationService } from "../../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { KeyChainService } from "../../../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../../../crypto/key/types/key-usage-type.js";
import { MediaType } from "../../../../shared/utils/media-type/media-type.enum.js";
import { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import { BuildIssuerMetadata } from "../application/build-issuer-metadata.js";
import { AuthorizationServersService } from "../authorization/authorization-servers/authorization-servers.service.js";
import { AuthorizeService } from "../authorization/authorize/authorize.service.js";
import { ChainedAsService } from "../authorization/chained-as/chained-as.service.js";
import { builtInAccessTokenSettings } from "../authorization/domain/token-grant-rules.js";
import { WellKnownException } from "../exceptions/index.js";
import { Oid4vciSdkFactory } from "../oid4vci-sdk.factory.js";
import { CredentialIssuerMetadataDto } from "./dto/credential-issuer-metadata.dto.js";
import { EC_Public, JwksResponseDto } from "./dto/jwks-response.dto.js";

/**
 * Service to handle well-known endpoints and metadata retrieval.
 */
@Injectable()
export class WellKnownService {
    /**
     * Constructor for WellKnownService.
     * @param buildIssuerMetadata
     * @param certService
     * @param authorizeService
     */
    constructor(
        private readonly buildIssuerMetadata: BuildIssuerMetadata,
        private readonly sdk: Oid4vciSdkFactory,
        private readonly certService: CertService,
        public readonly keyChainService: KeyChainService,
        private readonly authorizeService: AuthorizeService,
        private readonly cryptoImplementationService: CryptoImplementationService,
        private readonly authorizationServersService: AuthorizationServersService,
        private readonly chainedAsService: ChainedAsService,
        private readonly issuanceService: IssuanceService,
    ) {}

    /**
     * Retrieves the issuer metadata for a given tenant for the specified content type.
     * The metadata can be returned in two formats:
     * - an unsigned JSON document using the media type application/json, or
     * - a signed JSON Web Token (JWT) containing the Credential Issuer Metadata in its payload using the media type application/jwt.
     * @param tenantId
     * @param contentType
     * @returns
     */
    async getIssuerMetadata(tenantId: string, contentType: MediaType) {
        try {
            const metadata = (
                await this.buildIssuerMetadata.execute(
                    tenantId,
                    this.sdk.issuer(tenantId),
                )
            ).credentialIssuer as unknown as CredentialIssuerMetadataDto;

            if (contentType === MediaType.APPLICATION_JWT) {
                const cert = await this.certService.find({
                    tenantId,
                    type: KeyUsageType.Access,
                });
                return this.keyChainService.signJWT(
                    {
                        ...metadata,
                        iss: metadata.credential_issuer,
                        sub: metadata.credential_issuer,
                        iat: Math.floor(Date.now() / 1000),
                        // [Review]: should we add `exp` value here?
                        //MM: the value makes sense when we cache the issuer metadata so it must not be signed on every request. Like when it is issued every hour, its lifetime is 1 hour and the jwt is in the cache.
                    },
                    {
                        typ: "openidvci-issuer-metadata+jwt",
                        alg: this.cryptoImplementationService.getAlg(),
                        x5c: this.certService.getCertChain(cert),
                    },
                    tenantId,
                    cert.keyId,
                );
            }

            return metadata;
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve issuer metadata for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Returns the OAuth 2.0 Authorization Server metadata for a given tenant.
     * @returns
     */
    async getAuthzMetadata(tenantId: string) {
        try {
            return await this.authorizeService.authzMetadata(tenantId);
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve authorization server metadata for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Returns the JSON Web Key Set (JWKS) for a given tenant.
     * Resolves the access token signing key of the built-in authorization
     * server (or the default) and includes the `kid` so that JWT
     * verification can match keys.
     * @returns
     */
    async getJwks(tenantId: string): Promise<JwksResponseDto> {
        try {
            const issuanceConfig =
                await this.issuanceService.getIssuanceConfiguration(tenantId);

            const signingKeyId =
                builtInAccessTokenSettings(issuanceConfig).signingKeyId ||
                (await this.keyChainService.getKid(tenantId));

            const publicKey = await this.keyChainService.getPublicKey(
                "jwk",
                tenantId,
                signingKeyId,
            );

            const keyWithKid = {
                ...publicKey,
                kid: (publicKey as { kid?: string }).kid || signingKeyId,
            };

            return { keys: [keyWithKid as EC_Public] };
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve JWKS for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Returns the OAuth 2.0 Authorization Server metadata for the Chained AS.
     * This supports the RFC 8414 alternative discovery path format:
     * `/.well-known/oauth-authorization-server/:tenantId/chained-as`
     * @param tenantId
     * @returns
     */
    async getChainedAsMetadata(
        tenantId: string,
    ): Promise<Record<string, unknown>> {
        try {
            return await this.chainedAsService.getMetadata(tenantId);
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve Chained AS metadata for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Returns the JSON Web Key Set (JWKS) for the Chained Authorization Server.
     * @param tenantId
     * @returns
     */
    async getChainedAsJwks(
        tenantId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        try {
            return await this.chainedAsService.getJwks(tenantId);
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve Chained AS JWKS for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    async getManagedAuthorizationServerMetadata(
        tenantId: string,
        authorizationServerId: string,
    ): Promise<Record<string, unknown>> {
        try {
            return await this.authorizationServersService.getMetadata(
                tenantId,
                authorizationServerId,
            );
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve managed authorization server metadata for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    async getManagedAuthorizationServerJwks(
        tenantId: string,
        authorizationServerId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        try {
            return await this.authorizationServersService.getJwks(
                tenantId,
                authorizationServerId,
            );
        } catch (error) {
            if (error instanceof WellKnownException) {
                throw error;
            }
            throw new WellKnownException(
                `Failed to retrieve managed authorization server JWKS for tenant ${tenantId}: ${error instanceof Error ? error.message : "Unknown error"}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}
