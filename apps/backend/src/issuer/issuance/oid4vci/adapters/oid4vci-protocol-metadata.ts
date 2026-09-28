import { createHash } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from "@nestjs/common";
import {
    AuthorizationServerMetadata,
    type Jwk,
    Oauth2ResourceServer,
} from "@openid4vc/oauth2";
import {
    type IssuerMetadataResult,
    Openid4vciIssuer,
    Openid4vciVersion,
} from "@openid4vc/openid4vci";
import { decodeJwt } from "jose";
import { MetricService } from "nestjs-otel";
import { firstValueFrom } from "rxjs";
import { v4 } from "uuid";
import { CryptoService } from "../../../../crypto/crypto.service.js";
import { EncryptionService } from "../../../../crypto/encryption/encryption.service.js";
import { type RegistrationCertificateCreation } from "../../../../registrar/generated/index.js";
import { RegistrarService } from "../../../../registrar/registrar.service.js";
import { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import { FederationTrustSource } from "../../../../trust/types.js";
import { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type {
    IssuanceConfiguration as IssuanceConfig,
    ManagedAuthorizationServerData,
} from "../../../configuration/issuance/domain/issuance-configuration.js";
import { ManagedAuthorizationServerConfig } from "../../../configuration/issuance/dto/authorization-server-config.dto.js";
import {
    IssuerProvidedAttestation,
    IssuerRegistrationCertificateConfig,
    IssuerRegistrationCertificateMode,
} from "../../../configuration/issuance/dto/issuer-registration-certificate.dto.js";
import { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import { AuthorizationServersService } from "../authorization/authorization-servers/authorization-servers.service.js";
import { AuthorizeService } from "../authorization/authorize/authorize.service.js";
import { ChainedAsService } from "../authorization/chained-as/chained-as.service.js";
import { ChainedAsVpService } from "../authorization/chained-as-vp/chained-as-vp.service.js";
import { OID4VCI_SETTINGS, type Oid4vciSettings } from "../oid4vci-settings.js";

/**
 * Type alias for the OAuth2 access token payload returned by resource server verification.
 * This is distinct from the internal TokenPayload used for authenticated API requests.
 */

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

type CachedAsMetadata = {
    metadata: AuthorizationServerMetadata;
    fetchedAt: number;
    expiresAt: number;
};

const AS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AS_METADATA_STALE_TTL_MS = 60 * 60 * 1000; // 1 hour stale grace window

/** SDK construction, issuer metadata, remote discovery and cache adapter. */
@Injectable()
export class Oid4vciProtocolMetadata {
    private readonly logger = new Logger(Oid4vciProtocolMetadata.name);
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
        private readonly credentialsService: CredentialsService,
        @Inject(OID4VCI_SETTINGS) private readonly settings: Oid4vciSettings,
        private readonly issuanceService: IssuanceService,
        private readonly federationTrustService: FederationTrustService,
        private readonly httpService: HttpService,
        private readonly authorizationServersService: AuthorizationServersService,
        private readonly chainedAsService: ChainedAsService,
        private readonly chainedAsVpService: ChainedAsVpService,
        private readonly registrarService: RegistrarService,
        private readonly encryptionService: EncryptionService,
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

    async getAuthorizationServer(tenantId: string): Promise<string> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const publicUrl = this.settings.publicUrl;

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

    async getSelectedAuthorizationServerConfig(
        tenantId: string,
        selectedAuthorizationServer?: string,
    ): Promise<ManagedAuthorizationServerData | undefined> {
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

    async resolveAuthorizationServerSelection(
        tenantId: string,
        selectedAuthorizationServer?: string,
    ): Promise<string | undefined> {
        if (!selectedAuthorizationServer) {
            return undefined;
        }

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const publicUrl = this.settings.publicUrl;

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

        const credential_issuer = `${this.settings.publicUrl}/issuers/${tenantId}`;

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
}
