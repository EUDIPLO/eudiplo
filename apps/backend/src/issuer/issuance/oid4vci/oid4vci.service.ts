import { createHash } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
    AuthorizationServerMetadata,
    authorizationCodeGrantIdentifier,
    type HttpMethod,
    type Jwk,
    Oauth2ResourceServer,
    preAuthorizedCodeGrantIdentifier,
    SupportedAuthenticationScheme,
} from "@openid4vc/oauth2";
import {
    CreateCredentialResponseReturn,
    CredentialOfferAuthorizationCodeGrant,
    CredentialOfferObject,
    CredentialOfferPreAuthorizedCodeGrant,
    type CredentialRequest,
    type CredentialResponse,
    DeferredCredentialResponse,
    type IssuerMetadataResult,
    Openid4vciIssuer,
    Openid4vciVersion,
    ParseCredentialRequestReturn,
} from "@openid4vc/openid4vci";
import type { Request } from "express";
import { decodeJwt } from "jose";
import { MetricService, Span, TraceService } from "nestjs-otel";
import { firstValueFrom } from "rxjs";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { CryptoService } from "../../../crypto/crypto.service.js";
import { EncryptionService } from "../../../crypto/encryption/encryption.service.js";
import { type RegistrationCertificateCreation } from "../../../registrar/generated/index.js";
import { RegistrarService } from "../../../registrar/registrar.service.js";
import {
    Session,
    SessionStatus,
} from "../../../session/entities/session.entity.js";
import { AuditLogContext } from "../../../session/logging/session-audit.service.js";
import { SessionLoggerService } from "../../../session/logging/session-logger.service.js";
import { SessionService } from "../../../session/session.service.js";
import { FederationTrustService } from "../../../trust/federation-trust.service.js";
import { TrustStoreService } from "../../../trust/trust-store.service.js";
import { FederationTrustSource } from "../../../trust/types.js";
import { X509ValidationService } from "../../../trust/x509-validation.service.js";
import { WebhookService } from "../../../webhook/webhook.service.js";
import { CredentialsService } from "../../configuration/credentials/credentials.service.js";
import { AuthorizationIdentity } from "../../configuration/credentials/dto/authorization-identity.js";
import { ClaimsWebhookResult } from "../../configuration/credentials/dto/claims-webhook-result.js";
import { CredentialProofType } from "../../configuration/credentials/entities/credential.entity.js";
import { ManagedAuthorizationServerConfig } from "../../configuration/issuance/dto/authorization-server-config.dto.js";
import {
    IssuerProvidedAttestation,
    IssuerRegistrationCertificateConfig,
    IssuerRegistrationCertificateMode,
} from "../../configuration/issuance/dto/issuer-registration-certificate.dto.js";
import { IssuanceConfig } from "../../configuration/issuance/entities/issuance-config.entity.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import { WebhookEndpointEntity } from "../../configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { SubjectKeyService } from "../../status-list/subject-key.service.js";
import {
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "./attestation-proof-trust.util.js";
import { AuthorizationServersService } from "./authorization/authorization-servers/authorization-servers.service.js";
import { AuthorizeService } from "./authorization/authorize/authorize.service.js";
import { ChainedAsService } from "./authorization/chained-as/chained-as.service.js";
import { ChainedAsVpService } from "./authorization/chained-as-vp/chained-as-vp.service.js";
import { DPOP_PROOF_FRESHNESS } from "./authorization/shared/dpop.util.js";
import { DeferredCredentialService } from "./deferred-credential.service.js";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import { NotificationRequestDto } from "./dto/notification-request.dto.js";
import {
    FlowType,
    OfferRequestDto,
    OfferResponse,
} from "./dto/offer-request.dto.js";
import { DeferredTransactionEntity } from "./entities/deferred-transaction.entity.js";
import { CredentialRequestException } from "./exceptions/index.js";
import { NonceService } from "./nonce.service.js";
import { getHeadersFromRequest } from "./util.js";

/**
 * Type alias for the OAuth2 access token payload returned by resource server verification.
 * This is distinct from the internal TokenPayload used for authenticated API requests.
 */
type OAuth2TokenPayload = {
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

type Oid4vpServerConfig = ManagedAuthorizationServerConfig & {
    type: "oid4vp";
    id: string;
    presentationConfigId: string;
};

type ExternalServerConfig = ManagedAuthorizationServerConfig & {
    type: "external";
    id: string;
    issuer: string;
    sessionBinding?: {
        method: "access_token_claim";
        claim: string;
    };
};

type ChainedServerConfig = ManagedAuthorizationServerConfig & {
    type: "chained";
    id: string;
    upstream?: unknown;
    vp?: { enabled?: boolean };
};

interface IssuerInfo {
    format: string;
    data: string;
}

type SupportedCredentialProofType = "jwt" | "attestation";

interface ParsedCredentialProofs {
    proofType: SupportedCredentialProofType;
    values: string[];
}

type CachedAsMetadata = {
    metadata: AuthorizationServerMetadata;
    fetchedAt: number;
    expiresAt: number;
};

const AS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AS_METADATA_STALE_TTL_MS = 60 * 60 * 1000; // 1 hour stale grace window

/**
 * Service for handling OID4VCI (OpenID 4 Verifiable Credential Issuance) operations.
 */
@Injectable()
export class Oid4vciService {
    private readonly logger = new Logger(Oid4vciService.name);
    private readonly asMetadataCache = new Map<string, CachedAsMetadata>();
    private readonly inFlightAsMetadataRequests = new Map<
        string,
        Promise<AuthorizationServerMetadata>
    >();

    private readonly asMetadataHitsCounter;
    private readonly asMetadataMissesCounter;
    private readonly asMetadataStaleCounter;
    private readonly asMetadataFetchesCounter;

    clearAsMetadataCache(): void {
        this.asMetadataCache.clear();
        this.inFlightAsMetadataRequests.clear();
    }

    constructor(
        private readonly authzService: AuthorizeService,
        private readonly cryptoService: CryptoService,
        public readonly credentialsService: CredentialsService,
        private readonly configService: ConfigService,
        private readonly sessionService: SessionService,
        private readonly auditLogger: SessionLoggerService,
        private readonly issuanceService: IssuanceService,
        private readonly federationTrustService: FederationTrustService,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
        private readonly webhookService: WebhookService,
        private readonly httpService: HttpService,
        private readonly authorizationServersService: AuthorizationServersService,
        private readonly chainedAsService: ChainedAsService,
        private readonly chainedAsVpService: ChainedAsVpService,
        private readonly deferredCredentialService: DeferredCredentialService,
        private readonly registrarService: RegistrarService,
        private readonly traceService: TraceService,
        @InjectRepository(WebhookEndpointEntity)
        private readonly webhookEndpointRepo: Repository<WebhookEndpointEntity>,
        private readonly encryptionService: EncryptionService,
        private readonly nonceService: NonceService,
        private readonly subjectKeyService: SubjectKeyService,
        @Optional() private readonly metricService?: MetricService,
    ) {
        this.asMetadataHitsCounter = this.metricService?.getCounter(
            "oid4vci_as_metadata_cache_hits_total",
            { description: "Total hits on OID4VCI AS metadata cache" },
        );
        this.asMetadataMissesCounter = this.metricService?.getCounter(
            "oid4vci_as_metadata_cache_misses_total",
            { description: "Total misses on OID4VCI AS metadata cache" },
        );
        this.asMetadataStaleCounter = this.metricService?.getCounter(
            "oid4vci_as_metadata_cache_stale_total",
            { description: "Total stale hits on OID4VCI AS metadata cache" },
        );
        this.asMetadataFetchesCounter = this.metricService?.getCounter(
            "oid4vci_as_metadata_fetches_total",
            { description: "Total outbound AS metadata fetches" },
        );
    }

    /**
     * Get the authorization server URL for credential offers.
     * Uses the first enabled authorization server in configured order.
     */
    private async getAuthorizationServer(tenantId: string): Promise<string> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");

        const configuredServer =
            await this.getSelectedAuthorizationServerConfig(tenantId);

        if (configuredServer) {
            const externalServer =
                configuredServer as Partial<ExternalServerConfig>;
            const oid4vpServer =
                configuredServer as Partial<Oid4vpServerConfig>;
            const chainedServer =
                configuredServer as Partial<ChainedServerConfig>;

            if (
                configuredServer.type === "external" &&
                typeof externalServer.issuer === "string" &&
                externalServer.issuer.length > 0
            ) {
                return externalServer.issuer;
            }

            if (
                configuredServer.type === "oid4vp" &&
                typeof oid4vpServer.id === "string" &&
                oid4vpServer.id.length > 0
            ) {
                return this.authorizationServersService.getAuthorizationServerBaseUrl(
                    tenantId,
                    oid4vpServer.id,
                );
            }

            if (configuredServer.type === "built-in") {
                return this.authzService.getAuthzIssuer(tenantId);
            }

            if (configuredServer.type === "chained") {
                if (chainedServer.upstream) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as`;
                }

                if (chainedServer.vp?.enabled) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as-vp`;
                }
            }
        }

        for (const server of issuanceConfig.authorizationServers ?? []) {
            const externalServer = server as Partial<ExternalServerConfig>;
            const oid4vpServer = server as Partial<Oid4vpServerConfig>;
            const chainedServer = server as Partial<ChainedServerConfig>;

            if (server.enabled === false) {
                continue;
            }

            if (
                server.type === "external" &&
                typeof externalServer.issuer === "string" &&
                externalServer.issuer.length > 0
            ) {
                return externalServer.issuer;
            }

            if (
                server.type === "oid4vp" &&
                typeof oid4vpServer.id === "string" &&
                oid4vpServer.id.length > 0
            ) {
                return this.authorizationServersService.getAuthorizationServerBaseUrl(
                    tenantId,
                    oid4vpServer.id,
                );
            }

            if (server.type === "built-in") {
                return this.authzService.getAuthzIssuer(tenantId);
            }

            if (server.type === "chained") {
                if (chainedServer.upstream) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as`;
                }

                if (chainedServer.vp?.enabled) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as-vp`;
                }
            }
        }

        throw new BadRequestException(
            "No enabled authorization server configured",
        );
    }

    private async getSelectedAuthorizationServerConfig(
        tenantId: string,
        selectedAuthorizationServer?: string,
    ) {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        const enabledServers = (
            issuanceConfig.authorizationServers ?? []
        ).filter((server) => server.enabled !== false);

        if (selectedAuthorizationServer) {
            return enabledServers.find(
                (server) => server.id === selectedAuthorizationServer,
            );
        }

        return enabledServers[0];
    }

    private async resolveAuthorizationServerSelection(
        tenantId: string,
        selectedAuthorizationServer?: string,
    ): Promise<string | undefined> {
        if (!selectedAuthorizationServer) {
            return undefined;
        }

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");

        for (const server of issuanceConfig.authorizationServers ?? []) {
            const externalServer = server as Partial<ExternalServerConfig>;
            const oid4vpServer = server as Partial<Oid4vpServerConfig>;
            const chainedServer = server as Partial<ChainedServerConfig>;

            if (
                server.enabled === false ||
                typeof server.id !== "string" ||
                server.id !== selectedAuthorizationServer
            ) {
                continue;
            }

            if (
                server.type === "external" &&
                typeof externalServer.issuer === "string" &&
                externalServer.issuer.length > 0
            ) {
                return externalServer.issuer;
            }

            if (
                server.type === "oid4vp" &&
                typeof oid4vpServer.id === "string" &&
                oid4vpServer.id.length > 0
            ) {
                return this.authorizationServersService.getAuthorizationServerBaseUrl(
                    tenantId,
                    oid4vpServer.id,
                );
            }

            if (server.type === "built-in") {
                return this.authzService.getAuthzIssuer(tenantId);
            }

            if (server.type === "chained") {
                if (chainedServer.upstream) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as`;
                }

                if (chainedServer.vp?.enabled) {
                    return `${publicUrl}/issuers/${tenantId}/chained-as-vp`;
                }
            }
        }

        throw new BadRequestException(
            `Authorization server '${selectedAuthorizationServer}' is not configured or enabled`,
        );
    }

    /**
     * Get the OID4VCI issuer instance for a specific tenant.
     * @param tenantId The ID of the tenant.
     * @returns The OID4VCI issuer instance.
     */
    getIssuer(tenantId: string, sessionId?: string) {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Openid4vciIssuer({
            callbacks,
        });
    }

    /**
     * Get the OID4VCI resource server instance for a specific tenant.
     * @param tenantId The ID of the tenant.
     * @returns The OID4VCI resource server instance.
     */
    getResourceServer(tenantId: string, sessionId?: string) {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Oauth2ResourceServer({
            callbacks: {
                ...callbacks,
                getJwks: (jwksUri) => this.resolveLocalJwks(tenantId, jwksUri),
            },
        });
    }

    /**
     * Resolves the JWK set of the built-in authorization server from the local
     * key chain, so no loopback HTTP call to our own JWKS endpoint is needed.
     * Returns undefined for foreign JWKS URIs so the library fetches them.
     */
    private async resolveLocalJwks(tenantId: string, jwksUri: string) {
        if (!jwksUri.endsWith(`/.well-known/jwks.json/issuers/${tenantId}`)) {
            return undefined;
        }

        const issuanceConfig = await this.issuanceService
            .getIssuanceConfiguration(tenantId)
            .catch(() => null);
        const signingKeyId =
            issuanceConfig?.signingKeyId ||
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

    private async assertFederationTrustForAuthorizationServer(
        authorizationServer: string,
        federationTrustSource?: FederationTrustSource,
    ): Promise<void> {
        if (!federationTrustSource) {
            return;
        }

        const mode = this.federationTrustService.getMode(federationTrustSource);
        if (mode === "lote-only") {
            return;
        }

        const trustEvaluation =
            await this.federationTrustService.evaluateAuthorizationServerTrust(
                authorizationServer,
                federationTrustSource,
            );

        if (!trustEvaluation.trusted) {
            throw new BadRequestException(
                `Authorization server is not trusted by OpenID Federation policy: ${trustEvaluation.reason}`,
            );
        }
    }

    private async fetchAuthorizationServerMetadata(
        authServerUrl: string,
    ): Promise<AuthorizationServerMetadata> {
        const now = Date.now();
        const cached = this.asMetadataCache.get(authServerUrl);

        if (cached && cached.expiresAt > now) {
            this.asMetadataHitsCounter?.add(1, { auth_server: authServerUrl });
            this.logger.debug(`AS metadata cache hit for ${authServerUrl}`);
            return cached.metadata;
        }

        const inFlight = this.inFlightAsMetadataRequests.get(authServerUrl);
        if (inFlight) {
            this.logger.debug(
                `Deduplicating in-flight AS metadata fetch for ${authServerUrl}`,
            );
            return inFlight;
        }

        this.asMetadataMissesCounter?.add(1, { auth_server: authServerUrl });

        const fetchPromise = (async () => {
            this.asMetadataFetchesCounter?.add(1, {
                auth_server: authServerUrl,
            });
            try {
                const metadata = await firstValueFrom(
                    this.httpService.get(
                        `${authServerUrl}/.well-known/oauth-authorization-server`,
                    ),
                ).then(
                    (response) => response.data,
                    async () => {
                        // Retry fetching from OIDC metadata endpoint.
                        return await firstValueFrom(
                            this.httpService.get(
                                `${authServerUrl}/.well-known/openid-configuration`,
                            ),
                        ).then(
                            (response) => response.data,
                            () => {
                                throw new BadRequestException(
                                    "Failed to fetch authorization server metadata",
                                );
                            },
                        );
                    },
                );

                this.asMetadataCache.set(authServerUrl, {
                    metadata,
                    fetchedAt: Date.now(),
                    expiresAt: Date.now() + AS_METADATA_CACHE_TTL_MS,
                });

                return metadata;
            } catch (error) {
                if (
                    cached &&
                    now - cached.fetchedAt <= AS_METADATA_STALE_TTL_MS
                ) {
                    this.asMetadataStaleCounter?.add(1, {
                        auth_server: authServerUrl,
                    });
                    this.logger.warn(
                        `Failed to fetch authorization server metadata for ${authServerUrl}, returning stale cached metadata: ${String(error)}`,
                    );
                    return cached.metadata;
                }
                throw error;
            }
        })();

        this.inFlightAsMetadataRequests.set(authServerUrl, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            this.inFlightAsMetadataRequests.delete(authServerUrl);
        }
    }

    private async appendConfiguredAuthorizationServersInOrder(
        tenantId: string,
        credentialIssuer: string,
        issuanceConfig: IssuanceConfig,
        federationTrustSource: FederationTrustSource | undefined,
        authServers: string[],
        authorizationServers: AuthorizationServerMetadata[],
    ): Promise<void> {
        const seenAuthServers = new Set<string>();

        for (const configuredServer of issuanceConfig.authorizationServers ??
            []) {
            const externalServer =
                configuredServer as Partial<ExternalServerConfig>;
            const oid4vpServer =
                configuredServer as Partial<Oid4vpServerConfig>;
            const chainedServer =
                configuredServer as Partial<ChainedServerConfig>;

            if (configuredServer.enabled === false) {
                continue;
            }

            if (
                configuredServer.type === "external" &&
                typeof externalServer.issuer === "string" &&
                externalServer.issuer.length > 0
            ) {
                const authServerUrl = externalServer.issuer;
                if (seenAuthServers.has(authServerUrl)) {
                    continue;
                }

                await this.assertFederationTrustForAuthorizationServer(
                    authServerUrl,
                    federationTrustSource,
                );

                seenAuthServers.add(authServerUrl);
                authServers.push(authServerUrl);
                authorizationServers.push(
                    await this.fetchAuthorizationServerMetadata(authServerUrl),
                );
                continue;
            }

            if (
                configuredServer.type === "oid4vp" &&
                typeof oid4vpServer.id === "string" &&
                oid4vpServer.id.length > 0
            ) {
                const authServerUrl =
                    this.authorizationServersService.getAuthorizationServerBaseUrl(
                        tenantId,
                        oid4vpServer.id,
                    );
                if (seenAuthServers.has(authServerUrl)) {
                    continue;
                }

                seenAuthServers.add(authServerUrl);
                authServers.push(authServerUrl);
                authorizationServers.push(
                    (await this.authorizationServersService.getMetadata(
                        tenantId,
                        oid4vpServer.id,
                    )) as AuthorizationServerMetadata,
                );
                continue;
            }

            if (configuredServer.type === "chained") {
                if (chainedServer.upstream) {
                    const chainedAsIssuer = `${credentialIssuer}/chained-as`;
                    if (seenAuthServers.has(chainedAsIssuer)) {
                        continue;
                    }

                    seenAuthServers.add(chainedAsIssuer);
                    authServers.push(chainedAsIssuer);
                    authorizationServers.push(
                        (await this.chainedAsService.getMetadata(
                            tenantId,
                        )) as AuthorizationServerMetadata,
                    );
                    continue;
                }

                if (chainedServer.vp?.enabled) {
                    const chainedAsVpIssuer = `${credentialIssuer}/chained-as-vp`;
                    if (seenAuthServers.has(chainedAsVpIssuer)) {
                        continue;
                    }

                    seenAuthServers.add(chainedAsVpIssuer);
                    authServers.push(chainedAsVpIssuer);
                    authorizationServers.push(
                        (await this.chainedAsVpService.getMetadata(
                            tenantId,
                        )) as AuthorizationServerMetadata,
                    );
                }
            }

            if (configuredServer.type === "built-in") {
                const builtInIssuer =
                    this.authzService.getAuthzIssuer(tenantId);
                if (seenAuthServers.has(builtInIssuer)) {
                    continue;
                }

                seenAuthServers.add(builtInIssuer);
                authServers.push(builtInIssuer);
                authorizationServers.push(
                    await this.authzService.authzMetadata(tenantId),
                );
            }
        }
    }

    /**
     * Build the `credential_request_encryption` metadata object if enabled.
     * Fetches the tenant's encryption public key and returns the metadata block
     * advertising that the issuer can receive encrypted credential requests.
     */
    private async getCredentialRequestEncryptionMetadata(
        tenantId: string,
        issuanceConfig: { credentialRequestEncryption?: boolean } | null,
    ): Promise<
        | {
              jwks: { keys: object[] };
              //alg_values_supported: string[];
              enc_values_supported: string[];
              encryption_required: boolean;
          }
        | undefined
    > {
        const encPublicKey =
            await this.encryptionService.getEncryptionPublicKey(tenantId);

        return {
            jwks: { keys: [encPublicKey] },
            //alg_values_supported: ["ECDH-ES"],
            enc_values_supported: ["A128GCM", "A256GCM"],
            encryption_required: issuanceConfig?.credentialRequestEncryption
                ? true
                : false,
        };
    }

    private normalizeSchemaMetadataIds(
        ids: Array<string | null | undefined>,
    ): string[] {
        return Array.from(
            new Set(
                ids
                    .filter(
                        (id): id is string =>
                            typeof id === "string" && id.trim().length > 0,
                    )
                    .map((id) => id.trim()),
            ),
        ).sort((left, right) => left.localeCompare(right));
    }

    private async deriveRegistrationCertificateMaterialFromCredentialConfigs(
        tenantId: string,
    ): Promise<{
        schemaMetadataIds: string[];
        providedAttestations: IssuerProvidedAttestation[];
    }> {
        const credentialConfigs =
            await this.credentialsService.getCredentialConfigsForTenant(
                tenantId,
            );

        const providedAttestations: IssuerProvidedAttestation[] = [];

        for (const credentialConfig of credentialConfigs) {
            const schemaMetadataId = credentialConfig.schemaMeta?.id;
            if (!schemaMetadataId || schemaMetadataId.trim().length === 0) {
                continue;
            }

            const format = credentialConfig.config?.format;
            if (format !== "dc+sd-jwt" && format !== "mso_mdoc") {
                continue;
            }

            const schemaMetadataVersion =
                typeof credentialConfig.schemaMeta?.version === "string" &&
                credentialConfig.schemaMeta.version.trim().length > 0
                    ? credentialConfig.schemaMeta.version.trim()
                    : undefined;

            providedAttestations.push({
                credentialConfigId: credentialConfig.id,
                format,
                meta: {
                    schema_metadata_id: schemaMetadataId.trim(),
                    ...(schemaMetadataVersion
                        ? {
                              schema_metadata_version: schemaMetadataVersion,
                          }
                        : {}),
                },
            });
        }

        providedAttestations.sort((left, right) => {
            const leftId =
                typeof left.meta?.["schema_metadata_id"] === "string"
                    ? left.meta["schema_metadata_id"]
                    : "";
            const rightId =
                typeof right.meta?.["schema_metadata_id"] === "string"
                    ? right.meta["schema_metadata_id"]
                    : "";

            if (leftId !== rightId) {
                return leftId.localeCompare(rightId);
            }

            return (left.format ?? "").localeCompare(right.format ?? "");
        });

        const schemaMetadataIds = this.normalizeSchemaMetadataIds(
            providedAttestations.map((attestation) => {
                const value = attestation.meta?.["schema_metadata_id"];
                return typeof value === "string" ? value : undefined;
            }),
        );

        return {
            schemaMetadataIds,
            providedAttestations,
        };
    }

    private computeRegistrationCertificateFingerprint(
        registrationCertificateConfig: IssuerRegistrationCertificateConfig,
        resolvedSchemaMetadataIds: string[],
        derivedProvidedAttestations: IssuerProvidedAttestation[],
    ): string {
        const material = {
            mode: registrationCertificateConfig.mode,
            schemaMetadataIds: resolvedSchemaMetadataIds,
            privacyPolicy: registrationCertificateConfig.privacyPolicy,
            supportUri: registrationCertificateConfig.supportUri,
            providedAttestations: derivedProvidedAttestations,
        };

        return createHash("sha256")
            .update(JSON.stringify(material))
            .digest("hex");
    }

    private isJwtActive(jwt: string): boolean {
        try {
            const payload = decodeJwt(jwt);
            const now = Math.floor(Date.now() / 1000);
            const skewSeconds = 30;

            if (
                typeof payload.nbf === "number" &&
                now + skewSeconds < payload.nbf
            ) {
                return false;
            }

            if (
                typeof payload.exp === "number" &&
                now - skewSeconds >= payload.exp
            ) {
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    private async resolveIssuerRegistrationCertificateJwt(
        tenantId: string,
        registrationCertificateConfig: IssuerRegistrationCertificateConfig,
    ): Promise<string | undefined> {
        const mode =
            registrationCertificateConfig.mode ??
            IssuerRegistrationCertificateMode.GENERATE;

        if (mode === IssuerRegistrationCertificateMode.IMPORT) {
            if (!registrationCertificateConfig.jwt) {
                this.logger.warn(
                    `[${tenantId}] registrationCertificate is enabled in import mode but no jwt is configured`,
                );
                return undefined;
            }

            if (!this.isJwtActive(registrationCertificateConfig.jwt)) {
                this.logger.warn(
                    `[${tenantId}] configured registration certificate jwt is expired or not active`,
                );
                return undefined;
            }

            return registrationCertificateConfig.jwt;
        }

        const { schemaMetadataIds, providedAttestations } =
            await this.deriveRegistrationCertificateMaterialFromCredentialConfigs(
                tenantId,
            );

        if (providedAttestations.length === 0) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate generate mode requires credential configs with schema metadata`,
            );
            return undefined;
        }

        const fingerprint = this.computeRegistrationCertificateFingerprint(
            registrationCertificateConfig,
            schemaMetadataIds,
            providedAttestations,
        );

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const cache = issuanceConfig.registrationCertificateCache;
        if (
            cache?.jwt &&
            cache.fingerprint === fingerprint &&
            this.isJwtActive(cache.jwt)
        ) {
            return cache.jwt;
        }

        if (schemaMetadataIds.length === 0) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate generate mode resolved no schema metadata IDs from credential configs; generated certificate will not include provides_attestations`,
            );
        }

        const creationBody: Partial<RegistrationCertificateCreation> = {
            ...(schemaMetadataIds.length > 0
                ? {
                      provides_attestations:
                          schemaMetadataIds as RegistrationCertificateCreation["provides_attestations"],
                  }
                : {}),
            ...(registrationCertificateConfig.privacyPolicy
                ? {
                      privacy_policy:
                          registrationCertificateConfig.privacyPolicy,
                  }
                : {}),
            ...(registrationCertificateConfig.supportUri
                ? { support_uri: registrationCertificateConfig.supportUri }
                : {}),
        };

        const resolved =
            await this.registrarService.resolveRegistrationCertificate(
                { body: creationBody },
                {},
                v4(),
                tenantId,
            );

        const previousJwt = cache?.jwt;
        if (
            previousJwt &&
            previousJwt !== resolved.jwt &&
            this.isJwtActive(previousJwt)
        ) {
            try {
                const revoked =
                    await this.registrarService.revokeRegistrationCertificateByJwt(
                        tenantId,
                        previousJwt,
                    );
                if (!revoked) {
                    this.logger.warn(
                        `[${tenantId}] Previous issuer registration certificate was not found as active during replacement`,
                    );
                }
            } catch (error) {
                this.logger.warn(
                    `[${tenantId}] Failed to revoke previous issuer registration certificate during replacement: ${error instanceof Error ? error.message : "unknown error"}`,
                );
            }
        }

        await this.issuanceService.updateRegistrationCertificateCache(
            tenantId,
            {
                jwt: resolved.jwt,
                fingerprint,
                issuedAt:
                    typeof resolved.payload.iat === "number"
                        ? resolved.payload.iat
                        : undefined,
                expiresAt:
                    typeof resolved.payload.exp === "number"
                        ? resolved.payload.exp
                        : undefined,
            },
        );

        return resolved.jwt;
    }

    private async appendIssuerRegistrationCertificateInfo(
        tenantId: string,
        registrationCertificateConfig:
            | IssuerRegistrationCertificateConfig
            | null
            | undefined,
        issuerInfo: IssuerInfo[],
    ): Promise<void> {
        if (!registrationCertificateConfig?.enabled) {
            return;
        }

        try {
            const registrationCertificateJwt =
                await this.resolveIssuerRegistrationCertificateJwt(
                    tenantId,
                    registrationCertificateConfig,
                );

            if (registrationCertificateJwt) {
                issuerInfo.push({
                    format: "registration_cert",
                    data: registrationCertificateJwt,
                });
            }
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Failed to resolve issuer registration certificate: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        }
    }

    /**
     * Get the OID4VCI issuer metadata for a specific session.
     * @param session The session for which to retrieve the issuer metadata.
     * @returns The OID4VCI issuer metadata.
     */
    async issuerMetadata(
        tenantId: string,
        issuer?: Openid4vciIssuer,
    ): Promise<IssuerMetadataResult> {
        issuer ??= this.getIssuer(tenantId);

        const credential_issuer = `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}`;

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        const authorizationServers: AuthorizationServerMetadata[] = [];
        let authServers: string[] = [];

        const federationTrustSource =
            issuanceConfig.federation &&
            issuanceConfig.federation.trustAnchors?.length
                ? ({
                      mode: issuanceConfig.federation.mode,
                      entityId: issuanceConfig.federation.entityId,
                      trustAnchors: issuanceConfig.federation.trustAnchors,
                      cacheTtlSeconds:
                          issuanceConfig.federation.cacheTtlSeconds,
                      enforceSigningPolicy:
                          issuanceConfig.federation.enforceSigningPolicy,
                  } as FederationTrustSource)
                : undefined;

        await this.appendConfiguredAuthorizationServersInOrder(
            tenantId,
            credential_issuer,
            issuanceConfig,
            federationTrustSource,
            authServers,
            authorizationServers,
        );

        const issuer_info: IssuerInfo[] = [];
        await this.appendIssuerRegistrationCertificateInfo(
            tenantId,
            issuanceConfig.registrationCertificate,
            issuer_info,
        );

        const notificationEndpoint =
            issuanceConfig.notificationEndpointEnabled !== false
                ? `${credential_issuer}/vci/notification`
                : undefined;

        const credentialIssuer = issuer.createCredentialIssuerMetadata({
            credential_issuer,
            credential_configurations_supported:
                await this.credentialsService.getCredentialConfigurationSupported(
                    tenantId,
                ),
            credential_endpoint: `${credential_issuer}/vci/credential`,
            deferred_credential_endpoint: `${credential_issuer}/vci/deferred_credential`,
            authorization_servers: authServers,
            notification_endpoint: notificationEndpoint,
            nonce_endpoint: `${credential_issuer}/vci/nonce`,
            display:
                issuanceConfig.display !== null
                    ? issuanceConfig.display
                    : undefined,
            credential_request_encryption:
                await this.getCredentialRequestEncryptionMetadata(
                    tenantId,
                    issuanceConfig,
                ),
            credential_response_encryption: {
                alg_values_supported: ["ECDH-ES"],
                enc_values_supported: ["A128GCM", "A256GCM"],
                encryption_required:
                    issuanceConfig?.credentialResponseEncryption ? true : false,
            },
            batch_credential_issuance:
                issuanceConfig?.batchSize && issuanceConfig?.batchSize > 1
                    ? {
                          batch_size: issuanceConfig?.batchSize,
                      }
                    : undefined,
            issuer_info: issuer_info.length > 0 ? issuer_info : undefined,
        });
        return {
            credentialIssuer,
            authorizationServers,
            originalDraftVersion: Openid4vciVersion.V1,
        } as IssuerMetadataResult;
    }

    /**
     * Create a credential offer for a specific user and tenant.
     * @param body The request body containing the offer details.
     * @param user The user for whom the offer is being created.
     * @param tenantId The ID of the tenant.
     * @returns The created credential offer.
     */
    @Span("oid4vci.createOffer")
    async createOffer(
        body: OfferRequestDto,
        user: TokenPayload,
        tenantId: string,
    ): Promise<OfferResponse> {
        const credentialConfigurationIds = body.credentialConfigurationIds;

        let authorization_code: string | undefined;
        let grants: any;
        const issuer_state = v4();
        const selectedAuthorizationServer =
            await this.resolveAuthorizationServerSelection(
                tenantId,
                body.authorization_server,
            );
        if (body.flow === FlowType.PRE_AUTH_CODE) {
            //check if tx_code is a number
            authorization_code = v4();
            const authServer =
                selectedAuthorizationServer ??
                (await this.getAuthorizationServer(tenantId));

            grants = {
                [preAuthorizedCodeGrantIdentifier]: {
                    "pre-authorized_code": authorization_code,
                    tx_code: body.tx_code
                        ? {
                              input_mode: Number(body.tx_code)
                                  ? "numeric"
                                  : "text",
                              length: body.tx_code.length,
                              description: body.tx_code_description,
                          }
                        : undefined,
                    authorization_server: authServer,
                } as CredentialOfferPreAuthorizedCodeGrant,
            };
        } else {
            // For authorization code flow, use Chained AS if configured
            const authServer =
                selectedAuthorizationServer ??
                (await this.getAuthorizationServer(tenantId));
            grants = {
                [authorizationCodeGrantIdentifier]: {
                    issuer_state,
                    authorization_server: authServer,
                } as CredentialOfferAuthorizationCodeGrant,
            };
        }

        //if claims are provided, check them against the schemas when provided
        if (body.credentialClaims) {
            await Promise.all(
                Object.entries(body.credentialClaims).map(
                    ([credentialConfigId, claimSource]) => {
                        if (claimSource.type === "inline") {
                            return this.credentialsService.validateClaimsForCredential(
                                credentialConfigId,
                                claimSource.claims,
                                tenantId,
                            );
                        }
                        return Promise.resolve();
                    },
                ),
            );
        }

        const session = await this.sessionService.create({
            id: issuer_state,
            credentialPayload: body,
            tenantId: user.entity!.id,
            authorization_code,
            webhookEndpointId: body.webhookEndpointId,
            authorizationServerId:
                selectedAuthorizationServer ??
                (
                    await this.getSelectedAuthorizationServerConfig(
                        tenantId,
                        undefined,
                    )
                )?.id,
        });

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.flow": body.flow,
            "oid4vci.credentialConfigurationIds":
                credentialConfigurationIds.join(","),
        });

        const issuer = this.getIssuer(session.tenantId, session.id);
        const issuerMetadata = await this.issuerMetadata(tenantId, issuer);
        const credentialOfferUri = `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}/vci/credential-offers/${session.id}`;

        return issuer
            .createCredentialOffer({
                credentialConfigurationIds,
                grants,
                issuerMetadata,
                credentialOfferUri,
            })
            .then(
                async (offer) => {
                    await this.sessionService.add(issuer_state, {
                        offer: offer.credentialOfferObject as any,
                        offerUrl: offer.credentialOffer,
                    });
                    return {
                        session: session.id,
                        uri: offer.credentialOffer,
                    } as OfferResponse;
                },
                (err) => {
                    console.log(err);
                    throw new ConflictException(
                        `Invalid credential configuration ID`,
                    );
                },
            );
    }

    /**
     * Resolve credential offers sent by reference (credential_offer_uri).
     */
    async getCredentialOfferByReference(
        tenantId: string,
        sessionId: string,
    ): Promise<CredentialOfferObject> {
        const session = await this.sessionService
            .getBy({ id: sessionId, tenantId })
            .catch(() => {
                throw new NotFoundException("Credential offer not found");
            });

        if (
            !this.configService.getOrThrow<boolean>("ISSUER_MULTI_CONSUMPTION")
        ) {
            if (!session.offer) {
                throw new NotFoundException("Credential offer not found");
            }

            const consumed = await this.sessionService.consumeOfferByReference(
                sessionId,
                tenantId,
            );
            if (!consumed) {
                throw new NotFoundException("Credential offer not found");
            }
        }

        return session.offer as CredentialOfferObject;
    }

    /**
     * Create a nonce an store it in the session entity
     * @param session
     * @returns
     */
    async nonceRequest(tenantId: string) {
        return this.nonceService.issue(tenantId);
    }

    /**
     * Verify the resource access token from the request.
     * Supports both DPoP and Bearer authentication schemes based on configuration.
     */
    private async verifyResourceAccessToken(
        req: Request,
        tenantId: string,
        issuerMetadata: IssuerMetadataResult,
        issuanceConfig: Awaited<
            ReturnType<IssuanceService["getIssuanceConfiguration"]>
        >,
    ): Promise<OAuth2TokenPayload> {
        const resourceServer = this.getResourceServer(tenantId);
        const headers = getHeadersFromRequest(req);

        const allowedAuthenticationSchemes = [
            SupportedAuthenticationScheme.DPoP,
        ];

        if (!issuanceConfig.dPopRequired) {
            allowedAuthenticationSchemes.push(
                SupportedAuthenticationScheme.Bearer,
            );
        }

        const { tokenPayload } = await resourceServer.verifyResourceRequest({
            authorizationServers:
                this.getAuthorizationServersForResourceVerification(
                    tenantId,
                    issuerMetadata.authorizationServers,
                ),
            request: {
                url: `${this.configService.getOrThrow<string>("PUBLIC_URL")}${req.url}`,
                method: req.method as HttpMethod,
                headers,
            },
            resourceServer: issuerMetadata.credentialIssuer.credential_issuer,
            allowedAuthenticationSchemes,
            dpop: DPOP_PROOF_FRESHNESS,
        });

        return tokenPayload as OAuth2TokenPayload;
    }

    private getAuthorizationServersForResourceVerification(
        tenantId: string,
        authorizationServers: AuthorizationServerMetadata[],
    ): AuthorizationServerMetadata[] {
        const internalUrl = this.configService.get<string>("INTERNAL_URL");
        if (!internalUrl) {
            return authorizationServers;
        }

        const builtInIssuer = this.authzService.getAuthzIssuer(tenantId);
        const jwksUri = `${internalUrl.replace(/\/$/, "")}/.well-known/jwks.json/issuers/${tenantId}`;

        return authorizationServers.map((authorizationServer) =>
            authorizationServer.issuer === builtInIssuer
                ? { ...authorizationServer, jwks_uri: jwksUri }
                : authorizationServer,
        );
    }

    /**
     * Enforce that the requested `credential_configuration_id` is covered by
     * the `authorization_details` bound to the presented access token, per
     * OID4VCI Section 6. If the token does not carry `authorization_details`
     * (e.g. scope-only external AS integrations), the check is skipped.
     *
     * @throws CredentialRequestException with `invalid_credential_request`
     *   when the requested credential is not authorized by the token.
     */
    private enforceAuthorizationDetails(
        tokenPayload: OAuth2TokenPayload,
        requestedCredentialConfigurationId: string,
    ): void {
        const raw = tokenPayload.authorization_details;
        if (!Array.isArray(raw) || raw.length === 0) {
            // No authorization_details bound to the token - nothing to enforce
            // here (scope-based authorization or legacy tokens).
            return;
        }

        const authorized = raw
            .filter(
                (ad): ad is Record<string, unknown> =>
                    typeof ad === "object" &&
                    ad !== null &&
                    (ad as Record<string, unknown>).type ===
                        "openid_credential",
            )
            .map((ad) => ad.credential_configuration_id as string | undefined)
            .filter((id): id is string => typeof id === "string");

        if (authorized.length === 0) {
            // Token carries authorization_details but none of type
            // `openid_credential` - treat as unauthorized for any credential.
            throw new CredentialRequestException(
                "invalid_credential_request",
                "Access token is not authorized for any credential configuration",
            );
        }

        if (!authorized.includes(requestedCredentialConfigurationId)) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                `Access token is not authorized for credential_configuration_id '${requestedCredentialConfigurationId}'`,
            );
        }
    }

    /**
     * Resolve the session and claims based on the token source.
     * Handles Local AS, Chained AS, and External AS flows.
     */
    private async resolveSessionAndClaims(
        tokenPayload: OAuth2TokenPayload,
        tenantId: string,
        credentialConfigurationId: string,
        issuanceConfig: Awaited<
            ReturnType<IssuanceService["getIssuanceConfiguration"]>
        >,
    ): Promise<{
        session: Session;
        claimsResult: ClaimsWebhookResult | undefined;
        isExternalAsToken: boolean;
        isChainedAsToken: boolean;
    }> {
        const localIssuer = this.authzService.getAuthzIssuer(tenantId);
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        const chainedAsIssuer = `${publicUrl}/issuers/${tenantId}/chained-as`;
        const hasChainedAuthorizationServer =
            await this.authorizationServersService.hasEnabledChainedAuthorizationServer(
                tenantId,
            );
        const managedAuthorizationServerIssuers = new Set(
            await this.authorizationServersService.getAuthorizationServerIssuerUrls(
                tenantId,
            ),
        );

        const isLocalAsToken = tokenPayload.iss === localIssuer;
        const isChainedAsToken =
            (hasChainedAuthorizationServer &&
                tokenPayload.iss === chainedAsIssuer) ||
            managedAuthorizationServerIssuers.has(tokenPayload.iss);
        const isExternalAsToken = !isLocalAsToken && !isChainedAsToken;

        let session: Session;
        let claimsResult: ClaimsWebhookResult | undefined;

        if (isChainedAsToken) {
            // Chained AS flow - EUDIPLO-issued token with issuer_state for session correlation
            const issuerState = tokenPayload.issuer_state as string | undefined;
            if (!issuerState) {
                throw new CredentialRequestException(
                    "credential_request_denied",
                    "Chained AS token is missing issuer_state claim",
                );
            }

            session = await this.sessionService.getBy({ id: issuerState });

            const upstreamIdentity =
                tokenPayload.iss === chainedAsIssuer
                    ? await this.chainedAsService.getUpstreamIdentityByIssuerState(
                          issuerState,
                      )
                    : undefined;

            const identity: AuthorizationIdentity = upstreamIdentity ?? {
                iss: tokenPayload.iss,
                sub: (tokenPayload.upstream_sub as string) ?? tokenPayload.sub,
                token_claims: tokenPayload as unknown as Record<
                    string,
                    unknown
                >,
            };

            claimsResult = await this.credentialsService.getClaimsFromWebhook(
                credentialConfigurationId,
                session,
                { identity },
            );
        } else if (isExternalAsToken) {
            // External AS flow (e.g., Keycloak)
            const configuredAuthServers =
                await this.authorizationServersService.getExternalAuthorizationServerUrls(
                    tenantId,
                );
            if (!configuredAuthServers.includes(tokenPayload.iss)) {
                throw new CredentialRequestException(
                    "credential_request_denied",
                    `Token issuer '${tokenPayload.iss}' is not a configured authorization server`,
                );
            }

            const externalConfig = (
                await this.issuanceService.getIssuanceConfiguration(tenantId)
            ).authorizationServers?.find(
                (server) =>
                    server.type === "external" &&
                    server.enabled !== false &&
                    (server as Partial<ExternalServerConfig>).issuer ===
                        tokenPayload.iss,
            );

            if (!externalConfig) {
                throw new CredentialRequestException(
                    "credential_request_denied",
                    `Token issuer '${tokenPayload.iss}' is not a configured external authorization server`,
                );
            }

            const bindingClaim = (
                externalConfig as Partial<ExternalServerConfig>
            ).sessionBinding?.claim;
            const bindingValue = tokenPayload[bindingClaim ?? ""] as
                | string
                | undefined;

            if (!bindingClaim || !bindingValue) {
                throw new CredentialRequestException(
                    "credential_request_denied",
                    `External authorization server '${tokenPayload.iss}' is missing the configured session-binding claim '${bindingClaim ?? "<unset>"}'`,
                );
            }

            session =
                await this.sessionService.resolveExternalAuthorizationServerSession(
                    tenantId,
                    tokenPayload.iss,
                    tokenPayload.sub,
                    externalConfig.id,
                    bindingClaim,
                    bindingValue,
                );

            const identity: AuthorizationIdentity = {
                iss: tokenPayload.iss,
                sub: tokenPayload.sub,
                token_claims: tokenPayload as unknown as Record<
                    string,
                    unknown
                >,
            };

            claimsResult = await this.credentialsService.getClaimsFromWebhook(
                credentialConfigurationId,
                session,
                { identity, requireWebhook: true },
            );
        } else {
            // Local AS flow - existing behavior
            session = await this.sessionService.getBy({
                id: tokenPayload.sub,
            });

            if (tokenPayload.sub !== session.id) {
                throw new CredentialRequestException(
                    "credential_request_denied",
                    "The access token is not associated with a valid session",
                );
            }

            const identity: AuthorizationIdentity = {
                iss: tokenPayload.iss,
                sub: tokenPayload.sub,
                token_claims: tokenPayload as unknown as Record<
                    string,
                    unknown
                >,
            };

            claimsResult = await this.credentialsService.getClaimsFromWebhook(
                credentialConfigurationId,
                session,
                { identity },
            );
        }

        return { session, claimsResult, isExternalAsToken, isChainedAsToken };
    }

    /**
     * Extract and validate nonces from JWT proofs.
     * Ensures all proofs contain valid, non-expired nonces and consumes them.
     */
    /** Verify proofs and issue credentials for each provided proof. */
    private async issueCredentialsForProofs(
        proofs: string[],
        proofType: SupportedCredentialProofType,
        issuer: Openid4vciIssuer,
        session: Session,
        credentialConfigurationId: string,
        claimsResult: ClaimsWebhookResult | undefined,
        logContext: AuditLogContext,
        issuanceConfig: IssuanceConfig,
        issuanceSetId: string,
    ): Promise<{ credential: string }[]> {
        const credentials: { credential: string }[] = [];

        const issuerMetadata = await this.issuerMetadata(session.tenantId);

        for (const proofValue of proofs) {
            const payload = decodeJwt(proofValue);
            const expectedNonce = payload.nonce! as string;

            if (proofType === "jwt") {
                const verifiedProof =
                    await issuer.verifyCredentialRequestJwtProof({
                        expectedNonce,
                        issuerMetadata,
                        jwt: proofValue,
                    });

                await validateJwtProofAttestationTrust(
                    proofValue,
                    issuanceConfig.walletProviderTrustLists ?? [],
                    {
                        tenantId: session.tenantId,
                        trustStoreService: this.trustStoreService,
                        x509ValidationService: this.x509ValidationService,
                    },
                );

                const cnf = verifiedProof.signer.publicJwk;
                const cred = await this.credentialsService.getCredential(
                    credentialConfigurationId,
                    cnf,
                    session,
                    claimsResult?.claims,
                    issuanceSetId,
                );

                credentials.push({ credential: cred });

                this.auditLogger.logCredentialIssuance(
                    logContext,
                    credentialConfigurationId,
                    {
                        credentialSize: cred.length,
                        proofVerified: true,
                    },
                );
                continue;
            }

            const verifiedAttestation =
                await issuer.verifyCredentialRequestAttestationProof({
                    expectedNonce,
                    issuerMetadata,
                    keyAttestationJwt: proofValue,
                });

            await validateAttestationProofTrust(
                proofValue,
                issuanceConfig.walletProviderTrustLists ?? [],
                {
                    tenantId: session.tenantId,
                    trustStoreService: this.trustStoreService,
                    x509ValidationService: this.x509ValidationService,
                },
            );

            const attestedKeys = verifiedAttestation.payload
                .attested_keys as Jwk[];
            if (!Array.isArray(attestedKeys) || attestedKeys.length === 0) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Attestation proof does not contain any attested keys",
                );
            }
            if (
                attestedKeys.length > Math.max(issuanceConfig.batchSize ?? 1, 1)
            ) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Attestation proof contains more attested keys than the supported batch size",
                );
            }

            // OID4VCI 1.0 Appendix F.3: one credential per attested key.
            for (const cnf of attestedKeys) {
                const cred = await this.credentialsService.getCredential(
                    credentialConfigurationId,
                    cnf,
                    session,
                    claimsResult?.claims,
                    issuanceSetId,
                );

                credentials.push({ credential: cred });

                this.auditLogger.logCredentialIssuance(
                    logContext,
                    credentialConfigurationId,
                    {
                        credentialSize: cred.length,
                        proofVerified: true,
                    },
                );
            }
        }

        return credentials;
    }

    private async deriveIssuanceSetId(req: Request): Promise<string> {
        const authorization = req.headers.authorization;
        const header = Array.isArray(authorization)
            ? authorization[0]
            : authorization;
        const accessToken = header?.trim().split(/\s+/, 2)[1];
        if (!accessToken) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                "Credential request is missing an access token",
            );
        }
        return this.subjectKeyService.deriveIssuanceSetId(accessToken);
    }

    /**
     * Resolve supported key proofs from the parsed credential request.
     * We currently support JWT proof-of-possession and attestation proof types.
     */
    private resolveParsedCredentialProofs(
        parsedCredentialRequest: ParseCredentialRequestReturn,
    ): ParsedCredentialProofs {
        const jwtProofs = parsedCredentialRequest?.proofs?.jwt;
        const attestationProofs = parsedCredentialRequest?.proofs?.attestation;

        const hasJwtProofs = Array.isArray(jwtProofs) && jwtProofs.length > 0;
        const hasAttestationProofs =
            Array.isArray(attestationProofs) && attestationProofs.length > 0;

        if (hasJwtProofs && hasAttestationProofs) {
            throw new CredentialRequestException(
                "invalid_proof",
                "Credential request must include exactly one supported proof type (jwt or attestation)",
            );
        }

        if (hasJwtProofs) {
            return {
                proofType: "jwt",
                values: jwtProofs,
            };
        }

        if (hasAttestationProofs) {
            if (attestationProofs.length !== 1) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Attestation proof type requires exactly one key attestation JWT",
                );
            }

            return {
                proofType: "attestation",
                values: attestationProofs,
            };
        }

        throw new CredentialRequestException(
            "invalid_proof",
            "The proofs parameter is missing or does not contain supported proof types (jwt, attestation)",
        );
    }

    /**
     * Map generic errors to OID4VCI-compliant credential request exceptions.
     */
    private mapToCredentialRequestException(error: unknown): never {
        if (error instanceof CredentialRequestException) {
            throw error;
        }

        if (
            error instanceof ConflictException &&
            (error.message?.includes("not found") ||
                error.message?.includes("Credential configuration"))
        ) {
            throw new CredentialRequestException(
                "unknown_credential_configuration",
                error.message,
            );
        }

        if (
            error instanceof Error &&
            (error.message?.toLowerCase().includes("proof") ||
                error.message?.toLowerCase().includes("signature") ||
                error.message?.toLowerCase().includes("jwt"))
        ) {
            throw new CredentialRequestException(
                "invalid_proof",
                error.message,
            );
        }

        throw new CredentialRequestException(
            "credential_request_denied",
            error instanceof Error
                ? error.message
                : "An unexpected error occurred",
        );
    }

    private async enforceProofTypePolicy(
        tenantId: string,
        credentialConfigurationId: string,
        proofType: SupportedCredentialProofType,
    ): Promise<void> {
        const supportedProofTypes =
            await this.credentialsService.getSupportedProofTypesForCredentialConfig(
                tenantId,
                credentialConfigurationId,
            );

        if (!supportedProofTypes.includes(proofType as CredentialProofType)) {
            throw new CredentialRequestException(
                "invalid_proof",
                `Proof type '${proofType}' is not supported for credential_configuration_id '${credentialConfigurationId}'`,
            );
        }
    }

    /**
     * Get a credential for a specific session.
     * @param req The incoming HTTP request
     * @param tenantId The tenant identifier
     * @returns The credential response or deferred response
     */
    @Span("oid4vci.getCredential")
    async getCredential(
        req: Request,
        tenantId: string,
    ): Promise<CreateCredentialResponseReturn | DeferredCredentialResponse> {
        const issuer = this.getIssuer(tenantId);
        const issuerMetadata = await this.issuerMetadata(tenantId, issuer);
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        // Parse and validate the credential request
        const known = issuer.getKnownCredentialConfigurationsSupported(
            issuerMetadata.credentialIssuer,
        );
        issuerMetadata.knownCredentialConfigurations = known;

        // Decrypt encrypted credential request (JWE) if Content-Type is application/jwt
        const rawBody = req.body as
            | Record<string, unknown>
            | string
            | undefined;

        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        const isJwtContentType =
            contentType.startsWith("application/jwt") ||
            contentType.startsWith(
                "application/openid4vci-credential-request+jwt",
            );

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request received: encrypted=${isJwtContentType || typeof rawBody === "string"}, contentType=${contentType || "missing"}`,
        );

        let requestBody: CredentialRequest;
        if (isJwtContentType || typeof rawBody === "string") {
            // Encrypted credential request - need to read and decrypt JWE
            let jweString: string;
            if (typeof rawBody === "string") {
                // Text body parser successfully set req.body as string
                jweString = rawBody;
            } else {
                // Body parser did not consume the stream for non-JSON content types;
                // read raw body from the request stream directly as a fallback.
                try {
                    jweString = await new Promise<string>((resolve, reject) => {
                        const chunks: Buffer[] = [];
                        req.on("data", (chunk: Buffer) => chunks.push(chunk));
                        req.on("end", () =>
                            resolve(Buffer.concat(chunks).toString("utf8")),
                        );
                        req.on("error", reject);
                    });
                } catch {
                    throw new CredentialRequestException(
                        "invalid_encryption_parameters",
                        "Failed to read encrypted credential request body",
                    );
                }
                if (!jweString) {
                    throw new CredentialRequestException(
                        "invalid_encryption_parameters",
                        "Encrypted credential request body is empty",
                    );
                }
            }
            try {
                requestBody =
                    await this.encryptionService.decryptJweToJson<CredentialRequest>(
                        jweString,
                        tenantId,
                    );
            } catch {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    "Failed to decrypt encrypted credential request",
                );
            }
        } else if (rawBody && typeof rawBody === "object") {
            requestBody = rawBody as CredentialRequest;
        } else {
            throw new CredentialRequestException(
                "invalid_credential_request",
                "Credential request body is missing or malformed",
            );
        }

        // Validate credential_configuration_id before parsing to return spec-compliant error code
        const requestedConfigId = requestBody.credential_configuration_id as
            | string
            | undefined;
        if (requestedConfigId && !known[requestedConfigId]) {
            throw new CredentialRequestException(
                "unknown_credential_configuration",
                `Credential configuration '${requestedConfigId}' is not supported`,
            );
        }

        // Validate encryption parameters before parsing to return spec-compliant error code
        const encryptionParams = requestBody.credential_response_encryption;
        if (encryptionParams) {
            const supportedAlg =
                issuerMetadata.credentialIssuer.credential_response_encryption
                    ?.alg_values_supported ?? [];
            const supportedEnc =
                issuerMetadata.credentialIssuer.credential_response_encryption
                    ?.enc_values_supported ?? [];

            if (
                typeof encryptionParams.jwk.alg !== "string" ||
                !supportedAlg.includes(encryptionParams.jwk.alg)
            ) {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    `Unsupported credential response encryption algorithm '${encryptionParams.jwk.alg ?? "undefined"}'. Supported: ${supportedAlg.join(", ")}`,
                );
            }
            if (
                typeof encryptionParams.enc !== "string" ||
                !supportedEnc.includes(encryptionParams.enc)
            ) {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    `Unsupported credential response encryption encoding '${encryptionParams.enc ?? "undefined"}'. Supported: ${supportedEnc.join(", ")}`,
                );
            }
        }

        //TODO: temporary fix to satify parsing
        if (requestBody.credential_response_encryption) {
            requestBody.credential_response_encryption.alg = requestBody
                .credential_response_encryption?.jwk.alg as string;
        }

        let parsedCredentialRequest: ParseCredentialRequestReturn;
        try {
            parsedCredentialRequest = issuer.parseCredentialRequest({
                issuerMetadata,
                credentialRequest: requestBody,
            });
        } catch (err) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                err instanceof Error
                    ? err.message
                    : "The Credential Request is malformed or missing required parameters",
            );
        }

        const parsedProofs = this.resolveParsedCredentialProofs(
            parsedCredentialRequest,
        );

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request parsed: proofType=${parsedProofs.proofType}, proofCount=${parsedProofs.values.length}, hasResponseEncryption=${!!requestBody.credential_response_encryption}`,
        );

        // Verify access token
        const tokenPayload = await this.verifyResourceAccessToken(
            req,
            tenantId,
            issuerMetadata,
            issuanceConfig,
        );
        const issuanceSetId = await this.deriveIssuanceSetId(req);

        // Resolve credentialConfigurationId from either:
        //  - credential_identifier (OID4VCI Final Section 8.2): look it up in the
        //    token's authorization_details[].credential_identifiers to find the
        //    matching credential_configuration_id.
        //  - credential_configuration_id (direct)
        let credentialConfigurationId: string;
        if (parsedCredentialRequest.credentialIdentifier) {
            const credentialIdentifier =
                parsedCredentialRequest.credentialIdentifier as string;
            const authDetails =
                (tokenPayload.authorization_details as
                    | Array<Record<string, unknown>>
                    | undefined) ?? [];
            const matching = authDetails.find(
                (ad) =>
                    Array.isArray(ad.credential_identifiers) &&
                    (ad.credential_identifiers as string[]).includes(
                        credentialIdentifier,
                    ),
            );
            if (
                !matching ||
                typeof matching.credential_configuration_id !== "string"
            ) {
                throw new CredentialRequestException(
                    "unknown_credential_identifier",
                    `Credential identifier '${credentialIdentifier}' is unknown`,
                );
            }
            credentialConfigurationId = matching.credential_configuration_id;
        } else {
            credentialConfigurationId =
                parsedCredentialRequest.credentialConfigurationId as string;
        }

        // Enforce that the access token is actually authorized to request
        // this credential_configuration_id. Per OID4VCI Section 6, the
        // `authorization_details` on the token define the authorized
        // Credential Configurations. If the claim is present, the requested
        // configuration MUST be one of them.
        this.enforceAuthorizationDetails(
            tokenPayload,
            credentialConfigurationId,
        );

        try {
            await this.enforceProofTypePolicy(
                tenantId,
                credentialConfigurationId,
                parsedProofs.proofType,
            );
        } catch (error) {
            this.mapToCredentialRequestException(error);
        }

        const { session, claimsResult, isExternalAsToken, isChainedAsToken } =
            await this.resolveSessionAndClaims(
                tokenPayload,
                tenantId,
                credentialConfigurationId,
                issuanceConfig,
            );

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request authorized: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, deferred=${!!claimsResult?.deferred}, externalAs=${isExternalAsToken}, chainedAs=${isChainedAsToken}`,
        );

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.credentialConfigurationId": credentialConfigurationId,
            "oid4vci.proofCount": parsedProofs.values.length,
            "oid4vci.proofType": parsedProofs.proofType,
            "oid4vci.isExternalAs": isExternalAsToken,
            "oid4vci.isChainedAs": isChainedAsToken,
        });

        // Create session logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId,
            flowType: "OID4VCI",
            stage: "credential_request",
        };

        this.auditLogger.logFlowStart(logContext, {
            credentialConfigurationId,
            proofCount: parsedProofs.values.length,
            proofType: parsedProofs.proofType,
            isExternalAs: isExternalAsToken,
            isChainedAs: isChainedAsToken,
        });

        try {
            // Check if the webhook indicated deferred issuance
            if (claimsResult?.deferred) {
                return this.deferredCredentialService.createDeferredTransaction(
                    {
                        parsedCredentialRequest: {
                            proofs: parsedProofs.values,
                            proofType: parsedProofs.proofType,
                            credentialConfigurationId,
                        },
                        session,
                        tenantId,
                        interval: claimsResult.interval,
                        issuerMetadata,
                        issuanceSetId,
                    },
                );
            }

            // Validate and consume nonces
            await this.nonceService.validateAndConsume(
                parsedProofs.values,
                parsedProofs.proofType,
                tenantId,
                logContext,
                credentialConfigurationId,
            );

            // Issue credentials for each proof
            const credentials = await this.issueCredentialsForProofs(
                parsedProofs.values,
                parsedProofs.proofType,
                issuer,
                session,
                credentialConfigurationId,
                claimsResult,
                logContext,
                issuanceConfig,
                issuanceSetId,
            );

            this.logger.debug(
                `[${tenantId}] OID4VCI credentials issued: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, credentialCount=${credentials.length}`,
            );

            // Update session with notification
            const notificationId = v4();
            session.notifications.push({
                id: notificationId,
                credentialConfigurationId,
            });
            await this.sessionService.add(session.id, {
                notifications: session.notifications,
                status: SessionStatus.Fetched,
            });

            this.auditLogger.logFlowComplete(logContext, {
                credentialsIssued: credentials.length,
                notificationId,
            });

            return issuer.createCredentialResponse({
                credentials,
                credentialRequest: parsedCredentialRequest,
                cNonce: tokenPayload.nonce as string,
                notificationId,
                credentialResponseEncryption:
                    parsedCredentialRequest.credentialResponseEncryption,
            });
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] OID4VCI credential request failed: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, error=${error instanceof Error ? error.message : "unknown"}`,
            );
            this.auditLogger.logFlowError(logContext, error as Error, {
                credentialConfigurationId,
            });
            this.mapToCredentialRequestException(error);
        }
    }

    /**
     * Store the notification in the session based on the notitification id.
     * @param req
     * @param body
     */
    @Span("oid4vci.handleNotification")
    async handleNotification(
        req: Request,
        body: NotificationRequestDto,
        tenantId: string,
    ) {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        if (issuanceConfig.notificationEndpointEnabled === false) {
            throw new NotFoundException(
                "Notification endpoint is disabled for this issuance config",
            );
        }

        const issuer = this.getIssuer(tenantId);
        const resourceServer = this.getResourceServer(tenantId);
        const issuerMetadata = await this.issuerMetadata(tenantId, issuer);
        const headers = getHeadersFromRequest(req);

        const allowedAuthenticationSchemes: SupportedAuthenticationScheme[] = [
            SupportedAuthenticationScheme.DPoP,
        ];
        if (!issuanceConfig.dPopRequired) {
            allowedAuthenticationSchemes.push(
                SupportedAuthenticationScheme.Bearer,
            );
        }

        const { tokenPayload } = await resourceServer.verifyResourceRequest({
            authorizationServers: issuerMetadata.authorizationServers,
            request: {
                url: `${this.configService.getOrThrow<string>("PUBLIC_URL")}${req.url}`,
                method: req.method as HttpMethod,
                headers,
            },
            resourceServer: issuerMetadata.credentialIssuer.credential_issuer,
            allowedAuthenticationSchemes,
            dpop: DPOP_PROOF_FRESHNESS,
        });

        const session = await this.sessionService.getBy({
            id: tokenPayload.sub,
        });

        if (session.id !== tokenPayload.sub) {
            throw new BadRequestException("Session not found");
        }

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.notificationId": body.notification_id,
            "oid4vci.event": body.event ?? "",
        });

        // Create session logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId,
            flowType: "OID4VCI",
            stage: "notification",
        };

        try {
            const index = session.notifications.findIndex(
                (notification) => notification.id === body.notification_id,
            );
            if (index === -1) {
                throw new BadRequestException(
                    "No notifications found in session",
                );
            }

            session.notifications[index].event = body.event;
            await this.sessionService.add(session.id, {
                notifications: session.notifications,
            });

            //check for the webhook and send it.
            //TODO: in case multiple batches are included, check if each time the notification endpoint is triggered. Also when multiple credentials got offered in the request, try to bundle them maybe?
            if (session.webhookEndpointId) {
                const endpoint = await this.webhookEndpointRepo.findOneBy({
                    id: session.webhookEndpointId,
                    tenantId: session.tenantId,
                });
                if (endpoint) {
                    await this.webhookService.sendWebhookNotification(
                        { url: endpoint.url, auth: endpoint.auth },
                        session,
                        session.notifications[index],
                    );
                }
            }
            const state: SessionStatus =
                body.event === "credential_accepted"
                    ? SessionStatus.Completed
                    : SessionStatus.Failed;
            await this.sessionService.setState(session, state);
        } catch (error) {
            this.auditLogger.logError(
                logContext,
                error as Error,
                "Failed to handle notification",
                {
                    notificationId: body.notification_id,
                },
            );
            throw error;
        }
    }

    /**
     * Handle deferred credential request.
     * Called when wallet polls with transaction_id.
     * @param req The request
     * @param body The deferred credential request DTO
     * @param tenantId The tenant ID
     * @returns Credential response or issuance_pending error
     */
    @Span("oid4vci.getDeferredCredential")
    async getDeferredCredential(
        req: Request,
        body: DeferredCredentialRequestDto,
        tenantId: string,
    ): Promise<CredentialResponse> {
        // Add context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "oid4vci.transactionId": body.transaction_id,
            "session.tenantId": tenantId,
        });

        const issuer = this.getIssuer(tenantId);
        const issuerMetadata = await this.issuerMetadata(tenantId, issuer);
        return this.deferredCredentialService.getDeferredCredential(
            req,
            body,
            tenantId,
            issuerMetadata,
        );
    }

    /**
     * Mark a deferred transaction as ready with the issued credential.
     * @param tenantId The tenant ID
     * @param transactionId The transaction ID
     * @param claims The claims to include in the credential
     * @returns The updated deferred transaction
     */
    async completeDeferredTransaction(
        tenantId: string,
        transactionId: string,
        claims: Record<string, unknown>,
    ): Promise<DeferredTransactionEntity | null> {
        return this.deferredCredentialService.completeDeferredTransaction(
            tenantId,
            transactionId,
            claims,
        );
    }

    /**
     * Mark a deferred transaction as failed.
     * @param tenantId The tenant ID
     * @param transactionId The transaction ID
     * @param errorMessage Optional error message
     * @returns The updated deferred transaction
     */
    async failDeferredTransaction(
        tenantId: string,
        transactionId: string,
        errorMessage?: string,
    ): Promise<DeferredTransactionEntity | null> {
        return this.deferredCredentialService.failDeferredTransaction(
            tenantId,
            transactionId,
            errorMessage,
        );
    }
}
