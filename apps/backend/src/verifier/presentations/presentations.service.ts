import { createHash, createVerify, X509Certificate } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import * as eudiAttestationSchema from "@owf/eudi-attestation-schema";
import { type AttestationFormat } from "@owf/eudi-attestation-schema";
import * as x509 from "@peculiar/x509";
import { Request } from "express";
import { base64url, decodeJwt, decodeProtectedHeader } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { PinoLogger } from "nestjs-pino";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service.js";
import {
    extractRequestMeta,
    getChangedFields,
    resolveAuditActor,
} from "../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../auth/token.decorator.js";
import {
    ServiceTypeIdentifier,
    TrustListService,
} from "../../issuer/trust-list/trustlist.service.js";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import { RegistrarService } from "../../registrar/registrar.service.js";
import type { SessionData as Session } from "../../session/domain/session-data.js";
import { loadJsonFile } from "../../shared/utils/config-file-loader.util.js";
import { revocationModeToPolicy } from "../../trust/revocation-policy.util.js";
import {
    DEFAULT_VERIFIER_SKEW_SECONDS,
    VerifierOptions,
} from "../../trust/types.js";
import { CredentialVerifierFormatRegistry } from "./credential/credential-verifier-format-registry.js";
import {
    MdocSessionDataDcApi,
    MdocSessionDataOid4vp,
} from "./credential/mdocverifier/mdocverifier.service.js";
import type { VerificationFailureType } from "./credential/verification-failure.js";
import { AuthResponse } from "./dto/auth-response.dto.js";
import { PresentationConfigCreateDto } from "./dto/presentation-config-create.dto.js";
import { PresentationConfigUpdateDto } from "./dto/presentation-config-update.dto.js";
import type { RegistrationCertificateRequest } from "./dto/vp-request.dto.js";
import {
    ClaimsQuery,
    CredentialQueryValue,
    CredentialSetQuery,
    PresentationConfig,
    TrustedAuthorityQueryEtsiTl,
    TrustedAuthorityQueryOpenIdFederation,
    TrustedAuthorityType,
    TrustListRef,
} from "./entities/presentation-config.entity.js";
import { IncompletePresentationException } from "./exceptions/incomplete-presentation.exception.js";
import { MetadataFetchService } from "./metadata-fetch.service.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "./presentation-settings.js";

type CredentialType = "dc+sd-jwt" | "mso_mdoc";

type RegistrationCertificateFormFields = {
    registrationCertImportJwt?: string | null;
    registrationCertImportId?: string | null;
    registrationCertBodyPrivacyPolicy?: string | null;
    registrationCertBodySupportUri?: string | null;
    registrationCertBodyIntermediary?: string | null;
    registrationCertBodyPurpose?: Array<{
        lang?: string | null;
        content?: string | null;
    }> | null;
};

const registrationCertificateFormFieldKeys = [
    "registrationCertImportJwt",
    "registrationCertImportId",
    "registrationCertBodyPrivacyPolicy",
    "registrationCertBodySupportUri",
    "registrationCertBodyIntermediary",
    "registrationCertBodyPurpose",
] as const;

type ResolvedSchemaMetadataPayload = {
    id: string;
    version?: string;
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    supportedFormats: string[];
    schemaURIs: Array<{
        formatIdentifier?: string;
        format?: string;
        uri?: string;
    }>;
    trustedAuthorities: Array<{
        frameworkType?: string;
        value?: string;
        isLoTE?: boolean;
    }>;
    resolvedReferences: Array<{
        format: string;
        uri: string;
        integrity?: string;
        meta?: Record<string, unknown>;
        parsedSchema?: Record<string, unknown>;
    }>;
    dcqlQuery: BuildDcqlFromSchemaMetaResult;
};

type BuildDcqlFromSchemaMetaResult = {
    credentials: Array<Record<string, unknown>>;
};

type SchemaMetadataVerifier = (
    data: string,
    signature: string,
) => Promise<boolean>;

type SchemaMetaSdkCompat = {
    verifyResolveAndBuildDcql?: (options: {
        jws: string;
        verifier: SchemaMetadataVerifier;
        selectedFormats: AttestationFormat[];
        resolve: (uri: string) => Promise<{ content: string | object }>;
        verifyIntegrity?: boolean;
        includeTrustedAuthorities?: boolean;
    }) => Promise<{
        verified: {
            payload: {
                id?: string;
                version?: string;
                schemaURIs: Array<{ formatIdentifier?: string; uri: string }>;
                trustedAuthorities?: Array<{
                    frameworkType?: string;
                    value?: string;
                    isLOTE?: boolean;
                }>;
            };
        };
        resolvedReferences: Array<{
            format: string;
            uri: string;
            integrity?: string;
            meta?: unknown;
            parsedSchema?: Record<string, unknown>;
        }>;
        dcql: BuildDcqlFromSchemaMetaResult;
    }>;
    verifySchemaMeta?: (options: {
        jws: string;
        verifier: SchemaMetadataVerifier;
    }) => Promise<{
        payload: {
            id?: string;
            version?: string;
            schemaURIs: Array<{ formatIdentifier?: string; uri: string }>;
            trustedAuthorities?: Array<{
                frameworkType?: string;
                value?: string;
                isLOTE?: boolean;
            }>;
        };
    }>;
    resolveSchemaReferences?: (options: {
        schemaMeta: unknown;
        selectedFormats: AttestationFormat[];
        resolve: (uri: string) => Promise<{ content: string | object }>;
    }) => Promise<
        Array<{
            format: string;
            uri: string;
            integrity?: string;
            meta?: unknown;
            parsedSchema?: Record<string, unknown>;
        }>
    >;
    buildDcqlFromSchemaMeta?: (options: {
        schemaMeta: unknown;
        selectedFormats: AttestationFormat[];
        resolvedReferences?: Array<{
            format: string;
            uri: string;
            integrity?: string;
            meta?: unknown;
            parsedSchema?: Record<string, unknown>;
        }>;
        includeTrustedAuthorities?: boolean;
    }) => BuildDcqlFromSchemaMetaResult;
};

/**
 * Service for managing Verifiable Presentations (VPs) and handling SD-JWT-VCs.
 */
@Injectable()
export class PresentationsService {
    /**
     * Constructor for the PresentationsService.
     * @param httpService - Instance of HttpService for making HTTP requests.
     * @param resolverService - Instance of ResolverService for resolving DID documents.
     * @param vpRequestRepository - Repository for managing VP request configurations.
     */
    constructor(
        @InjectRepository(PresentationConfig)
        private readonly vpRequestRepository: Repository<PresentationConfig>,
        private readonly configImportService: ConfigImportService,
        private readonly configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly credentialVerifierFormats: CredentialVerifierFormatRegistry,
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
        private readonly registrarService: RegistrarService,
        private readonly trustListService: TrustListService,
        private readonly tenantActionLogService: AuditLogService,
        private readonly logger: PinoLogger,
        private readonly traceService: TraceService,
        private readonly metadataFetchService: MetadataFetchService,
    ) {
        this.logger.setContext(PresentationsService.name);
        // Register presentation config import in REFERENCES phase
        // This runs after CORE (keys, certs) and CONFIGURATION phases
        this.configImportOrchestrator.register(
            "presentation-configs",
            ImportPhase.REFERENCES,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Imports presentation configurations for a specific tenant.
     */
    private async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<PresentationConfigCreateDto>(
            tenantId,
            {
                subfolder: "presentation",
                fileExtension: ".json",
                validationSchema: PresentationConfigCreateDto,
                resourceType: "presentation config",
                loadData: (filePath) => {
                    const payload =
                        loadJsonFile<Record<string, unknown>>(filePath);
                    const id = (filePath.split("/").pop() || "").replace(
                        ".json",
                        "",
                    );
                    payload.id = id;
                    return payload as unknown as PresentationConfigCreateDto;
                },
                checkExists: (tid, data) => {
                    return this.getPresentationConfig(data.id, tid)
                        .then(() => true)
                        .catch(() => false);
                },
                deleteExisting: async (tid, data) => {
                    await this.vpRequestRepository.delete({
                        id: data.id,
                        tenantId: tid,
                    });
                },
                processItem: async (tid, config) => {
                    await this.storePresentationConfig(tid, config);
                },
            },
        );
    }

    /**
     * Retrieves all presentation configurations for a given tenant.
     * @param tenantId - The ID of the tenant for which to retrieve configurations.
     * @returns A promise that resolves to an array of PresentationConfig entities.
     */
    getPresentationConfigs(tenantId: string): Promise<PresentationConfig[]> {
        return this.vpRequestRepository.find({
            where: { tenantId },
            order: { createdAt: "DESC" },
        });
    }

    /**
     * Transform `trusted_authorities` in a DCQL query from internal `etsi_tl`
     * format (TrustListRef objects) to the DCQL-compliant `aki` format
     * (base64url-encoded Subject Key Identifier strings).
     *
     * Per OID4VP 1.0 Final §6 / trusted-authorities-query, `aki` values must be
     * an array of strings. This ensures wallets receive a spec-compliant DCQL query
     * rather than the internal representation with TrustListRef objects.
     *
     * For each `etsi_tl` entry the Subject Key Identifier (SKI, OID 2.5.29.14)
     * of the trust anchor certificate is extracted and base64url-encoded. The
     * SKI equals the AKI field in any credential signed by that CA, so a wallet
     * can match credentials locally without fetching external resources.
     */
    async transformDcqlTrustedAuthoritiesToAki(
        dcqlQuery: any,
        tenantId: string,
    ): Promise<any> {
        const credentials = dcqlQuery?.credentials;
        if (!Array.isArray(credentials)) {
            return dcqlQuery;
        }

        const transformedCredentials = await Promise.all(
            credentials.map(async (cred: any) => {
                const trustedAuthorities = cred?.trusted_authorities;
                if (!Array.isArray(trustedAuthorities)) {
                    return cred;
                }

                const transformedAuthorities = await Promise.all(
                    trustedAuthorities.map(async (ta: any) => {
                        if (ta?.type !== TrustedAuthorityType.ETSI_TL) {
                            return ta;
                        }

                        const akiValues: string[] = [];
                        for (const ref of ta.values ?? []) {
                            const derB64 = await this.resolveTrustAnchorDer(
                                ref,
                                tenantId,
                            );
                            if (!derB64) continue;

                            const aki = this.extractSkiAsBase64url(derB64);
                            if (aki) {
                                akiValues.push(aki);
                            }
                        }

                        if (akiValues.length === 0) {
                            this.logger.warn(
                                { tenantId },
                                "Could not extract any AKI values from etsi_tl trusted_authorities; leaving entry unchanged",
                            );
                            return ta;
                        }

                        return { type: "aki", values: akiValues };
                    }),
                );

                return { ...cred, trusted_authorities: transformedAuthorities };
            }),
        );

        return { ...dcqlQuery, credentials: transformedCredentials };
    }

    /**
     * Resolve the base64-encoded DER trust anchor certificate for a TrustListRef.
     * For managed trust lists (trustListId), fetches the verifier certificate from
     * the trust list service. For external refs, uses the supplied verifierX509Der.
     */
    private async resolveTrustAnchorDer(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<string | undefined> {
        if (ref.verifierX509Der) {
            return ref.verifierX509Der;
        }
        if (ref.trustListId) {
            try {
                return await this.trustListService.getVerifierX509Der(
                    tenantId,
                    ref.trustListId,
                );
            } catch (err: any) {
                this.logger.warn(
                    { tenantId, trustListId: ref.trustListId, err },
                    "Failed to resolve verifier certificate for trust list; skipping AKI extraction",
                );
                return undefined;
            }
        }
        return undefined;
    }

    /**
     * Extract the Subject Key Identifier (SKI, OID 2.5.29.14) from a
     * base64-encoded DER certificate and return it as a base64url string.
     *
     * Wallets check that a credential's certificate chain contains a cert whose
     * AKI matches this SKI, enabling local credential matching without fetching
     * external trust-list resources.
     */
    private extractSkiAsBase64url(derB64: string): string | undefined {
        try {
            const certBytes = Buffer.from(derB64, "base64");
            const cert = new x509.X509Certificate(certBytes);
            const skiExt = cert.getExtension("2.5.29.14") as
                | { keyId?: string }
                | undefined;
            const keyId = skiExt?.keyId;
            if (!keyId) {
                return undefined;
            }
            // @peculiar/x509 returns keyId as a lowercase hex string;
            // convert to bytes and base64url-encode per OID4VP spec.
            const skiBytes = Buffer.from(keyId.replaceAll(":", ""), "hex");
            return base64url.encode(skiBytes);
        } catch {
            return undefined;
        }
    }

    async resolveTrustListRefsForTenant(
        refs: TrustListRef[] | undefined,
        tenantId: string,
        tenantHost: string,
    ): Promise<TrustListRef[]> {
        if (!Array.isArray(refs) || refs.length === 0) {
            return [];
        }

        return Promise.all(
            refs.map(async (ref) => {
                if (ref.trustListId) {
                    const trustListId = ref.trustListId.trim();
                    if (trustListId.length === 0) {
                        throw new BadRequestException(
                            "trusted_authorities values trustListId must not be empty",
                        );
                    }

                    const verifierX509Der =
                        await this.trustListService.getVerifierX509Der(
                            tenantId,
                            trustListId,
                        );

                    return {
                        trustListId,
                        url: `${tenantHost}/trust-list/${encodeURIComponent(trustListId)}`,
                        verifierX509Der,
                    };
                }

                const url = ref.url?.replaceAll("<TENANT_URL>", tenantHost);
                if (!url) {
                    throw new BadRequestException(
                        "trusted_authorities values url is required when trustListId is not set",
                    );
                }

                return {
                    ...ref,
                    url,
                    trustListId: undefined,
                };
            }),
        );
    }

    /**
     * Stores a new presentation configuration.
     * @param tenantId - The ID of the tenant for which to store the configuration.
     * @param vprequest - The PresentationConfig entity to store.
     * @returns A promise that resolves to the stored PresentationConfig entity.
     */
    async storePresentationConfig(
        tenantId: string,
        vprequest: PresentationConfigCreateDto,
        actorToken?: TokenPayload,
        req?: Request,
    ) {
        const normalizedRequest =
            this.normalizeRegistrationCertFormFields(vprequest);
        const merged = {
            ...normalizedRequest,
            tenantId,
        } as PresentationConfig;

        // Persist first for fast UI response; cache is resolved asynchronously.
        merged.registrationCertCache = null;
        const saved = await this.vpRequestRepository.save(merged);

        if (saved.registration_cert) {
            this.scheduleRegistrationCertRefresh(saved.id, tenantId);
        }

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "presentation_config_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    undefined,
                    this.sanitizePresentationConfigForLog(saved),
                ),
                after: this.sanitizePresentationConfigForLog(saved),
                requestMeta: extractRequestMeta(req),
            });
        }

        return saved;
    }

    /**
     * Updates an existing presentation configuration.
     * @param id
     * @param tenantId
     * @param vprequest
     * @returns
     */
    async updatePresentationConfig(
        id: string,
        tenantId: string,
        vprequest: PresentationConfigUpdateDto,
        actorToken?: TokenPayload,
        req?: Request,
    ) {
        // Verify the config exists
        const existing = await this.getPresentationConfig(id, tenantId);
        const normalizedRequest =
            this.normalizeRegistrationCertFormFields(vprequest);

        // Merge existing with updates - client must explicitly set fields to null to clear them
        // Omitted fields keep their existing values
        const merged: PresentationConfig = {
            ...existing,
            ...normalizedRequest,
            id,
            tenantId,
        } as PresentationConfig;

        // Return quickly; resolve registration-certificate cache asynchronously.
        const cacheRelevantChanged =
            Object.prototype.hasOwnProperty.call(
                normalizedRequest,
                "registration_cert",
            ) || Object.prototype.hasOwnProperty.call(vprequest, "dcql_query");

        if (!merged.registration_cert) {
            merged.registrationCertCache = null;
        } else if (cacheRelevantChanged) {
            // Mark pending in UI while async refresh runs.
            merged.registrationCertCache = null;
        }

        const saved = await this.vpRequestRepository.save(merged);

        if (saved.registration_cert && cacheRelevantChanged) {
            this.scheduleRegistrationCertRefresh(saved.id, tenantId);
        }

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "presentation_config_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    this.sanitizePresentationConfigForLog(existing),
                    this.sanitizePresentationConfigForLog(saved),
                ),
                before: this.sanitizePresentationConfigForLog(existing),
                after: this.sanitizePresentationConfigForLog(saved),
                requestMeta: extractRequestMeta(req),
            });
        }

        return saved;
    }

    private normalizeRegistrationCertFormFields<
        T extends PresentationConfigCreateDto | PresentationConfigUpdateDto,
    >(vprequest: T): T {
        const normalized = { ...vprequest } as T &
            RegistrationCertificateFormFields & {
                registration_cert?: RegistrationCertificateRequest | null;
            };

        if (
            !Object.prototype.hasOwnProperty.call(
                normalized,
                "registration_cert",
            )
        ) {
            const registrationCert =
                this.buildRegistrationCertFromFormFields(normalized);
            if (registrationCert !== undefined) {
                normalized.registration_cert = registrationCert;
            }
        }

        for (const key of registrationCertificateFormFieldKeys) {
            delete normalized[key];
        }

        return normalized;
    }

    private buildRegistrationCertFromFormFields(
        fields: RegistrationCertificateFormFields,
    ): RegistrationCertificateRequest | null | undefined {
        const jwt = this.trimOptionalString(fields.registrationCertImportJwt);
        if (jwt) {
            return { jwt };
        }

        const id = this.trimOptionalString(fields.registrationCertImportId);
        if (id) {
            return { id };
        }

        const purpose = (fields.registrationCertBodyPurpose ?? [])
            .map((entry) => ({
                lang: this.trimOptionalString(entry.lang),
                content: this.trimOptionalString(entry.content),
            }))
            .filter((entry): entry is { lang: string; content: string } =>
                Boolean(entry.lang && entry.content),
            );

        const body: NonNullable<RegistrationCertificateRequest["body"]> = {};
        const privacyPolicy = this.trimOptionalString(
            fields.registrationCertBodyPrivacyPolicy,
        );
        const supportUri = this.trimOptionalString(
            fields.registrationCertBodySupportUri,
        );
        const intermediary = this.trimOptionalString(
            fields.registrationCertBodyIntermediary,
        );

        if (privacyPolicy) {
            body.privacy_policy = privacyPolicy;
        }
        if (supportUri) {
            body.support_uri = supportUri;
        }
        if (intermediary) {
            body.intermediary = intermediary;
        }
        if (purpose.length > 0) {
            body.purpose = purpose;
        }

        return Object.keys(body).length > 0 ? { body } : undefined;
    }

    private trimOptionalString(value: string | null | undefined): string {
        return typeof value === "string" ? value.trim() : "";
    }

    /**
     * Force-reissue the registration certificate for a presentation config,
     * bypassing the cache. Used by the management UI's "Reissue now" action.
     *
     * Throws if the config has no `registrationCert` spec or the registrar is
     * not enabled for this tenant.
     */
    async reissueRegistrationCertificate(
        id: string,
        tenantId: string,
    ): Promise<PresentationConfig> {
        const presentationConfig = await this.getPresentationConfig(
            id,
            tenantId,
        );
        if (!presentationConfig.registration_cert) {
            throw new BadRequestException(
                "Presentation config has no registrationCert spec",
            );
        }
        if (!(await this.registrarService.isEnabledForTenant(tenantId))) {
            throw new BadRequestException(
                "Registrar is not enabled for this tenant",
            );
        }

        // Resolve `<TENANT_URL>` placeholders so registrar validation/issuance
        // sees the same DCQL the runtime path will see.
        const host = this.settings.publicUrl;
        const tenantHost = `${host}/issuers/${tenantId}`;
        const resolvedDcql = JSON.parse(
            JSON.stringify(presentationConfig.dcql_query).replaceAll(
                "<TENANT_URL>",
                tenantHost,
            ),
        );

        // Force a fresh resolve by clearing the cache first.
        presentationConfig.registrationCertCache = null;
        const reissueConfig = {
            ...presentationConfig,
            registration_cert: presentationConfig.registration_cert?.body
                ? {
                      body: presentationConfig.registration_cert.body,
                      ...(presentationConfig.registration_cert.id
                          ? { id: presentationConfig.registration_cert.id }
                          : {}),
                  }
                : presentationConfig.registration_cert,
        } as PresentationConfig;
        const jwt = await this.getOrIssueRegistrationCertificate(
            reissueConfig,
            resolvedDcql,
            `reissue-${id}`,
        );
        if (!jwt) {
            throw new BadRequestException(
                "Failed to reissue registration certificate",
            );
        }
        return this.getPresentationConfig(id, tenantId);
    }

    /**
     * Resolve the registration-certificate JWT to attach to a VP request,
     * using the embedded {@link PresentationConfig.registrationCertCache}
     * when it is still valid. On a cache miss/expiry the cert is freshly
     * resolved via {@link RegistrarService} and the cache is persisted.
     *
     * Returns `undefined` when the config has no `registrationCert` spec or
     * the registrar is not enabled for this tenant.
     */
    async getOrIssueRegistrationCertificate(
        presentationConfig: PresentationConfig,
        resolvedDcqlQuery: any,
        requestId: string,
    ): Promise<string | undefined> {
        if (!presentationConfig.registration_cert) {
            return undefined;
        }
        if (
            !(await this.registrarService.isEnabledForTenant(
                presentationConfig.tenantId,
            ))
        ) {
            return undefined;
        }

        const dcqlFingerprint = this.registrarService.computeDcqlFingerprint(
            presentationConfig.dcql_query,
        );
        const specFingerprint = this.registrarService.computeSpecFingerprint(
            presentationConfig.registration_cert,
        );

        const cache = presentationConfig.registrationCertCache;
        const now = Math.floor(Date.now() / 1000);
        const skew = 60;
        if (
            cache &&
            cache.dcqlFingerprint === dcqlFingerprint &&
            cache.specFingerprint === specFingerprint &&
            (typeof cache.expiresAt !== "number" ||
                cache.expiresAt - skew > now)
        ) {
            return cache.jwt;
        }

        const resolved =
            await this.registrarService.resolveRegistrationCertificate(
                presentationConfig.registration_cert as any,
                resolvedDcqlQuery,
                requestId,
                presentationConfig.tenantId,
            );

        const newCache = {
            jwt: resolved.jwt,
            fingerprint:
                this.registrarService.computeAuthorizedCredentialsFingerprint(
                    resolved.payload.credentials,
                ),
            dcqlFingerprint,
            specFingerprint,
            issuedAt:
                typeof resolved.payload.iat === "number"
                    ? resolved.payload.iat
                    : undefined,
            expiresAt:
                typeof resolved.payload.exp === "number"
                    ? resolved.payload.exp
                    : undefined,
            source: resolved.source,
        };

        await this.vpRequestRepository.update(
            {
                id: presentationConfig.id,
                tenantId: presentationConfig.tenantId,
            },
            { registrationCertCache: newCache },
        );
        presentationConfig.registrationCertCache = newCache;

        return resolved.jwt;
    }

    /**
     * Recompute (or invalidate) the embedded registration-certificate cache on
     * the about-to-be-saved presentation config.
     *
     * Behavior:
     *  - If `registrationCert` is unset → clears any stale cache.
     *  - If a cache exists for an unchanged `registrationCert` spec, unchanged
     *    `dcql_query`, and is not expired → keeps the existing cache.
     *  - Otherwise eagerly resolves the certificate via {@link RegistrarService}
     *    and stores the new cache. On registrar/network failure the cache is
     *    cleared and the save proceeds; the runtime path will retry.
     *
     * Errors raised by the registrar that indicate user-config problems
     * (`BadRequestException`) propagate to fail the save.
     */
    private async refreshRegistrationCertCache(
        next: PresentationConfig,
        existing: PresentationConfig | undefined,
    ): Promise<void> {
        const spec = next.registration_cert;
        if (!spec) {
            next.registrationCertCache = null;
            return;
        }

        const dcqlFingerprint = this.registrarService.computeDcqlFingerprint(
            next.dcql_query,
        );
        const specFingerprint =
            this.registrarService.computeSpecFingerprint(spec);

        const now = Math.floor(Date.now() / 1000);
        const skew = 60;
        const cache = existing?.registrationCertCache;
        const cacheStillValid =
            cache &&
            cache.dcqlFingerprint === dcqlFingerprint &&
            cache.specFingerprint === specFingerprint &&
            (typeof cache.expiresAt !== "number" ||
                cache.expiresAt - skew > now);

        if (cacheStillValid) {
            next.registrationCertCache = cache;
            return;
        }

        // Resolve `<TENANT_URL>` placeholders so registrar validation/issuance
        // sees the same DCQL the runtime path will see.
        let resolvedDcql: any;
        try {
            const host = this.settings.publicUrl;
            const tenantHost = `${host}/issuers/${next.tenantId}`;
            resolvedDcql = JSON.parse(
                JSON.stringify(next.dcql_query).replaceAll(
                    "<TENANT_URL>",
                    tenantHost,
                ),
            );
        } catch {
            // No PUBLIC_URL in this context — fall back to the templated form.
            resolvedDcql = next.dcql_query;
        }

        try {
            const resolved =
                await this.registrarService.resolveRegistrationCertificate(
                    spec as any,
                    resolvedDcql,
                    next.id ?? "presentation-config-save",
                    next.tenantId,
                );
            const payload = resolved.payload;
            next.registrationCertCache = {
                jwt: resolved.jwt,
                fingerprint:
                    this.registrarService.computeAuthorizedCredentialsFingerprint(
                        payload.credentials,
                    ),
                dcqlFingerprint,
                specFingerprint,
                issuedAt:
                    typeof payload.iat === "number" ? payload.iat : undefined,
                expiresAt:
                    typeof payload.exp === "number" ? payload.exp : undefined,
                source: resolved.source,
            };
        } catch (err) {
            if (err instanceof BadRequestException) {
                // User-config error — fail the save so the user sees the issue.
                throw err;
            }
            this.logger.warn(
                { err, tenantId: next.tenantId, configId: next.id },
                "Failed to eagerly resolve registration certificate at save time; cache cleared, runtime will retry",
            );
            next.registrationCertCache = null;
        }
    }

    /**
     * Trigger registration-certificate cache refresh in the background.
     * This keeps create/update endpoints responsive while cert issuance
     * happens asynchronously.
     */
    private scheduleRegistrationCertRefresh(
        id: string,
        tenantId: string,
    ): void {
        void this.refreshRegistrationCertCacheAsync(id, tenantId);
    }

    private async refreshRegistrationCertCacheAsync(
        id: string,
        tenantId: string,
    ): Promise<void> {
        try {
            const latest = await this.vpRequestRepository.findOneBy({
                id,
                tenantId,
            });

            if (!latest || !latest.registration_cert) {
                return;
            }

            const refreshed = {
                ...latest,
            } as PresentationConfig;

            await this.refreshRegistrationCertCache(refreshed, latest);
            await this.vpRequestRepository.save(refreshed);
        } catch (err) {
            this.logger.warn(
                { err, tenantId, configId: id },
                "Asynchronous registration-certificate cache refresh failed; runtime will retry",
            );
        }
    }

    /**
     * Deletes a presentation configuration by its ID and tenant ID.
     * @param id - The ID of the presentation configuration to delete.
     * @param tenantId - The ID of the tenant for which to delete the configuration.
     * @returns A promise that resolves when the deletion is complete.
     */
    async deletePresentationConfig(
        id: string,
        tenantId: string,
        actorToken?: TokenPayload,
        req?: Request,
    ) {
        const existing = await this.getPresentationConfig(id, tenantId);
        const result = await this.vpRequestRepository.delete({ id, tenantId });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "presentation_config_deleted",
                actor: resolveAuditActor(actorToken),
                before: this.sanitizePresentationConfigForLog(existing),
                requestMeta: extractRequestMeta(req),
            });
        }

        return result;
    }

    private sanitizePresentationConfigForLog(
        config: PresentationConfig,
    ): Record<string, unknown> {
        return {
            id: config.id,
            description: config.description,
            lifeTime: config.lifeTime,
            dcql_query: config.dcql_query,
            transaction_data: config.transaction_data,
            skewSeconds: config.skewSeconds,
            registration_cert: config.registration_cert,
            registrationCertCache: config.registrationCertCache,
            attached: config.attached,
            redirectUri: config.redirectUri,
            accessKeyChainId: config.accessKeyChainId,
        };
    }

    /**
     * Retrieves a presentation configuration by its ID and tenant ID.
     * @param id - The ID of the presentation configuration to retrieve.
     * @param tenantId - The ID of the tenant for which to retrieve the configuration.
     * @returns A promise that resolves to the requested PresentationConfig entity.
     */
    getPresentationConfig(
        id: string,
        tenantId: string,
    ): Promise<PresentationConfig> {
        return this.vpRequestRepository
            .findOneByOrFail({
                id,
                tenantId,
            })
            .catch(() => {
                throw new ConflictException(`Request ID ${id} not found`);
            });
    }

    /**
     * Resolve OID4VCI credential issuer metadata server-side.
     * This is used by the web client to avoid browser CORS restrictions.
     */
    async resolveCredentialIssuerMetadata(issuerUrl: string) {
        const metadataUrl =
            this.metadataFetchService.buildCredentialIssuerMetadataUrl(
                issuerUrl,
            );
        const metadata = await this.metadataFetchService.fetch(metadataUrl);

        if (!metadata || typeof metadata !== "object") {
            throw new BadRequestException(
                `Issuer metadata response from ${metadataUrl} is invalid`,
            );
        }

        return metadata;
    }

    /**
     * Resolve schema metadata from a URL and decode its signed JWT payload.
     * Returns normalized fields that can be used to build a DCQL query.
     */
    /**
     * List schema metadata entries from the connected registrar catalog.
     * Returns an empty array when the registrar is not enabled for the tenant.
     */
    async listSchemaMetadataCatalog(tenantId: string) {
        const enabled =
            await this.registrarService.isEnabledForTenant(tenantId);
        if (!enabled) {
            return [];
        }
        return this.registrarService.findAllSchemaMetadata(tenantId, {});
    }

    private deriveSchemaMetadataFormatsFromJwt(signedJwt: string): string[] {
        let payload: Record<string, unknown>;

        try {
            payload = decodeJwt(signedJwt) as Record<string, unknown>;
        } catch {
            throw new BadRequestException(
                "signedJwt in schema metadata response is not a valid JWT",
            );
        }

        const supportedFormats = Array.isArray(payload.supportedFormats)
            ? payload.supportedFormats.filter(
                  (format): format is string => typeof format === "string",
              )
            : [];

        const schemaURIs = Array.isArray(payload.schemaURIs)
            ? (payload.schemaURIs as Array<{
                  formatIdentifier?: string;
                  format?: string;
              }>)
            : [];

        const schemaUriFormats = schemaURIs
            .map((entry) => entry.formatIdentifier ?? entry.format)
            .filter((format): format is string => typeof format === "string");

        return Array.from(new Set([...supportedFormats, ...schemaUriFormats]));
    }

    private async buildSchemaMetadataVerifier(
        signedJwt: string,
    ): Promise<SchemaMetadataVerifier> {
        const header = decodeProtectedHeader(signedJwt);
        const x5c = Array.isArray(header.x5c)
            ? header.x5c.filter(
                  (cert): cert is string => typeof cert === "string",
              )
            : [];

        if (x5c.length === 0) {
            throw new BadRequestException(
                "Schema metadata JWT does not contain x5c certificate chain in header",
            );
        }

        const leafCert = new X509Certificate(Buffer.from(x5c[0], "base64"));
        const key = leafCert.publicKey;
        const alg = typeof header.alg === "string" ? header.alg : "ES256";

        return async (data: string, signature: string) => {
            try {
                const verifier = createVerify("SHA256");
                verifier.update(data);
                verifier.end();

                const signatureBytes = Buffer.from(base64url.decode(signature));
                if (alg.startsWith("ES")) {
                    return verifier.verify(
                        { key, dsaEncoding: "ieee-p1363" },
                        signatureBytes,
                    );
                }

                return verifier.verify(key, signatureBytes);
            } catch {
                return false;
            }
        };
    }

    async resolveSchemaMetadata(schemaMetadataUrl: string): Promise<{
        signedJwt: string;
        schema: ResolvedSchemaMetadataPayload;
    }> {
        const response =
            await this.metadataFetchService.fetch(schemaMetadataUrl);

        if (!response || typeof response !== "object") {
            throw new BadRequestException(
                `Schema metadata response from ${schemaMetadataUrl} is invalid`,
            );
        }

        const signedJwt =
            typeof (response as { signedJwt?: unknown }).signedJwt === "string"
                ? (response as { signedJwt: string }).signedJwt
                : undefined;

        if (!signedJwt) {
            throw new BadRequestException(
                "Schema metadata response does not contain a signedJwt field",
            );
        }

        const allFormats = this.deriveSchemaMetadataFormatsFromJwt(signedJwt);

        const responseMetadata = response as {
            name?: unknown;
            description?: unknown;
            category?: unknown;
            tags?: unknown;
        };

        if (allFormats.length === 0) {
            throw new BadRequestException(
                "Schema metadata JWT payload does not contain any supported formats",
            );
        }

        const verifier = await this.buildSchemaMetadataVerifier(signedJwt);
        const schemaMetaSdk =
            eudiAttestationSchema as unknown as SchemaMetaSdkCompat;
        const resolved =
            typeof schemaMetaSdk.verifyResolveAndBuildDcql === "function"
                ? await schemaMetaSdk.verifyResolveAndBuildDcql({
                      jws: signedJwt,
                      verifier,
                      selectedFormats: allFormats as AttestationFormat[],
                      resolve: async (uri: string) => ({
                          content: await this.metadataFetchService.fetch(uri),
                      }),
                      includeTrustedAuthorities: true,
                  })
                : await (async () => {
                      if (
                          typeof schemaMetaSdk.verifySchemaMeta !==
                              "function" ||
                          typeof schemaMetaSdk.resolveSchemaReferences !==
                              "function" ||
                          typeof schemaMetaSdk.buildDcqlFromSchemaMeta !==
                              "function"
                      ) {
                          throw new BadRequestException(
                              "Installed @owf/eudi-attestation-schema version does not support schema metadata resolution APIs",
                          );
                      }

                      const verified = await schemaMetaSdk.verifySchemaMeta({
                          jws: signedJwt,
                          verifier,
                      });
                      const resolvedReferences =
                          await schemaMetaSdk.resolveSchemaReferences({
                              schemaMeta: verified.payload,
                              selectedFormats:
                                  allFormats as AttestationFormat[],
                              resolve: async (uri: string) => ({
                                  content:
                                      await this.metadataFetchService.fetch(
                                          uri,
                                      ),
                              }),
                          });
                      const dcql = schemaMetaSdk.buildDcqlFromSchemaMeta({
                          schemaMeta: verified.payload,
                          selectedFormats: allFormats as AttestationFormat[],
                          resolvedReferences,
                          includeTrustedAuthorities: true,
                      });

                      return {
                          verified,
                          resolvedReferences,
                          dcql,
                      };
                  })();

        const payload = resolved.verified.payload;
        const id = typeof payload.id === "string" ? payload.id : undefined;
        if (!id) {
            throw new BadRequestException(
                "Schema metadata JWT payload is missing a valid id",
            );
        }

        return {
            signedJwt,
            schema: {
                id,
                version: payload.version,
                name:
                    typeof responseMetadata.name === "string"
                        ? responseMetadata.name
                        : undefined,
                description:
                    typeof responseMetadata.description === "string"
                        ? responseMetadata.description
                        : undefined,
                category:
                    typeof responseMetadata.category === "string"
                        ? responseMetadata.category
                        : undefined,
                tags: Array.isArray(responseMetadata.tags)
                    ? responseMetadata.tags.filter(
                          (tag): tag is string => typeof tag === "string",
                      )
                    : undefined,
                supportedFormats: allFormats,
                schemaURIs: payload.schemaURIs.map(
                    (entry: { formatIdentifier?: string; uri: string }) => ({
                        formatIdentifier: entry.formatIdentifier,
                        uri: entry.uri,
                    }),
                ),
                trustedAuthorities:
                    payload.trustedAuthorities?.map(
                        (authority: {
                            frameworkType?: string;
                            value?: string;
                            isLOTE?: boolean;
                        }) => ({
                            frameworkType: authority.frameworkType,
                            value: authority.value,
                            isLoTE: authority.isLOTE,
                        }),
                    ) ?? [],
                resolvedReferences: resolved.resolvedReferences.map(
                    (ref: {
                        format: string;
                        uri: string;
                        integrity?: string;
                        meta?: unknown;
                        parsedSchema?: Record<string, unknown>;
                    }) => ({
                        format: ref.format,
                        uri: ref.uri,
                        integrity: ref.integrity,
                        meta:
                            ref.meta && typeof ref.meta === "object"
                                ? (ref.meta as Record<string, unknown>)
                                : undefined,
                        parsedSchema: ref.parsedSchema,
                    }),
                ),
                dcqlQuery: resolved.dcql,
            },
        };
    }

    async resolveSchemaMetadataJwt(signedJwt: string): Promise<{
        signedJwt: string;
        schema: ResolvedSchemaMetadataPayload;
    }> {
        if (!signedJwt || typeof signedJwt !== "string") {
            throw new BadRequestException(
                "signedJwt must be a non-empty string",
            );
        }

        const allFormats = this.deriveSchemaMetadataFormatsFromJwt(signedJwt);

        if (allFormats.length === 0) {
            throw new BadRequestException(
                "Schema metadata JWT payload does not contain any supported formats",
            );
        }

        const verifier = await this.buildSchemaMetadataVerifier(signedJwt);
        const schemaMetaSdk =
            eudiAttestationSchema as unknown as SchemaMetaSdkCompat;
        const resolved =
            typeof schemaMetaSdk.verifyResolveAndBuildDcql === "function"
                ? await schemaMetaSdk.verifyResolveAndBuildDcql({
                      jws: signedJwt,
                      verifier,
                      selectedFormats: allFormats as AttestationFormat[],
                      resolve: async (uri: string) => ({
                          content: await this.metadataFetchService.fetch(uri),
                      }),
                      includeTrustedAuthorities: true,
                  })
                : await (async () => {
                      if (
                          typeof schemaMetaSdk.verifySchemaMeta !==
                              "function" ||
                          typeof schemaMetaSdk.resolveSchemaReferences !==
                              "function" ||
                          typeof schemaMetaSdk.buildDcqlFromSchemaMeta !==
                              "function"
                      ) {
                          throw new BadRequestException(
                              "Installed @owf/eudi-attestation-schema version does not support schema metadata resolution APIs",
                          );
                      }

                      const verified = await schemaMetaSdk.verifySchemaMeta({
                          jws: signedJwt,
                          verifier,
                      });
                      const resolvedReferences =
                          await schemaMetaSdk.resolveSchemaReferences({
                              schemaMeta: verified.payload,
                              selectedFormats:
                                  allFormats as AttestationFormat[],
                              resolve: async (uri: string) => ({
                                  content:
                                      await this.metadataFetchService.fetch(
                                          uri,
                                      ),
                              }),
                          });
                      const dcql = schemaMetaSdk.buildDcqlFromSchemaMeta({
                          schemaMeta: verified.payload,
                          selectedFormats: allFormats as AttestationFormat[],
                          resolvedReferences,
                          includeTrustedAuthorities: true,
                      });

                      return {
                          verified,
                          resolvedReferences,
                          dcql,
                      };
                  })();

        const payload = resolved.verified.payload;
        const id = typeof payload.id === "string" ? payload.id : undefined;
        if (!id) {
            throw new BadRequestException(
                "Schema metadata JWT payload is missing a valid id",
            );
        }

        return {
            signedJwt,
            schema: {
                id,
                version: payload.version,
                supportedFormats: allFormats,
                schemaURIs: payload.schemaURIs.map(
                    (entry: { formatIdentifier?: string; uri: string }) => ({
                        formatIdentifier: entry.formatIdentifier,
                        uri: entry.uri,
                    }),
                ),
                trustedAuthorities:
                    payload.trustedAuthorities?.map(
                        (authority: {
                            frameworkType?: string;
                            value?: string;
                            isLOTE?: boolean;
                        }) => ({
                            frameworkType: authority.frameworkType,
                            value: authority.value,
                            isLoTE: authority.isLOTE,
                        }),
                    ) ?? [],
                resolvedReferences: resolved.resolvedReferences.map(
                    (ref: {
                        format: string;
                        uri: string;
                        integrity?: string;
                        meta?: unknown;
                        parsedSchema?: Record<string, unknown>;
                    }) => ({
                        format: ref.format,
                        uri: ref.uri,
                        integrity: ref.integrity,
                        meta:
                            ref.meta && typeof ref.meta === "object"
                                ? (ref.meta as Record<string, unknown>)
                                : undefined,
                        parsedSchema: ref.parsedSchema,
                    }),
                ),
                dcqlQuery: resolved.dcql,
            },
        };
    }

    /**
     * Stores the new registration certificate.
     * @param registrationCertId - The ID of the registration certificate to store.
     * @param id - The ID of the presentation configuration to update.
     * @param tenantId - The ID of the tenant for which to store the registration certificate.
     * @returns
     */
    public async storeRCID(
        registrationCertId: string,
        id: string,
        tenantId: string,
    ) {
        const element = await this.vpRequestRepository.findOneByOrFail({
            id,
            tenantId,
        });
        await this.vpRequestRepository.save(element);
    }

    /**
     * Parse the response from the wallet. It will verify the SD-JWT-VCs in the vp_token and return the parsed attestations.
     * @param res
     * @param requiredFields
     * @returns
     */
    @Span("presentations.parseResponse")
    async parseResponse(
        res: AuthResponse,
        presentationConfig: PresentationConfig,
        session: Session,
    ) {
        // Add session context to logs (Loki) and span attributes (Tempo)
        // assign() requires nestjs-pino request scope; the @Span decorator may
        // run the method in a separate AsyncLocalStorage context, so guard it.
        try {
            this.logger.assign({ sessionId: session.id });
        } catch {
            // Outside HTTP request scope — sessionId won't appear in logs,
            // but span attributes below still carry it for Tempo.
        }
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        const attestationIds = Object.keys(res.vp_token);
        const host = this.settings.publicUrl;
        const tenantHost = `${host}/issuers/${presentationConfig.tenantId}`;

        // Validate credential completeness - ensure all required credentials are present
        this.validateCredentialCompleteness(
            attestationIds,
            presentationConfig.dcql_query.credentials,
            presentationConfig.dcql_query.credential_sets,
        );

        // Get transaction_data from the request object JWT payload
        // This ensures we use the exact same encoded strings that were sent to the wallet
        let transactionDataStrings: string[] | undefined;
        let requestObjectSessionData:
            | {
                  nonce?: string;
                  client_id?: string;
                  response_uri?: string;
                  response_mode?: string;
                  expected_origins?: string[];
              }
            | undefined;
        let requestObjectJwkThumbprint: Uint8Array | undefined;
        if (session.requestObject) {
            const requestPayload = decodeJwt(session.requestObject) as {
                transaction_data?: string[];
                nonce?: string;
                client_id?: string;
                response_uri?: string;
                response_mode?: string;
                client_metadata?: {
                    jwks?: { keys?: Array<Record<string, any>> };
                };
            };
            transactionDataStrings = requestPayload.transaction_data;
            requestObjectSessionData = requestPayload;

            // Per ISO 18013-7 / OpenID4VP, OID4VPHandoverInfo carries the SHA-256
            // JWK thumbprint of the verifier's response encryption key (the one in
            // client_metadata.jwks used to encrypt the JARM response). The wallet
            // computes this when constructing DeviceAuthentication, so we must
            // match it here.
            try {
                const jwks = requestPayload.client_metadata?.jwks?.keys;
                if (jwks && jwks.length > 0) {
                    // Pick the first encryption key (use=enc) or fall back to first.
                    const encJwk = jwks.find((k) => k.use === "enc") ?? jwks[0];
                    // RFC 7638 canonical JSON for EC/OKP/RSA keys.
                    let canonical: string | undefined;
                    if (encJwk.kty === "EC") {
                        canonical = JSON.stringify({
                            crv: encJwk.crv,
                            kty: encJwk.kty,
                            x: encJwk.x,
                            y: encJwk.y,
                        });
                    } else if (encJwk.kty === "OKP") {
                        canonical = JSON.stringify({
                            crv: encJwk.crv,
                            kty: encJwk.kty,
                            x: encJwk.x,
                        });
                    } else if (encJwk.kty === "RSA") {
                        canonical = JSON.stringify({
                            e: encJwk.e,
                            kty: encJwk.kty,
                            n: encJwk.n,
                        });
                    }
                    if (canonical) {
                        requestObjectJwkThumbprint = new Uint8Array(
                            createHash("sha256")
                                .update(Buffer.from(canonical, "utf8"))
                                .digest(),
                        );
                    }
                }
            } catch (err: any) {
                this.logger.debug(
                    `Could not compute response-encryption JWK thumbprint: ${err?.message ?? err}`,
                );
            }
        }

        const results = await Promise.all(
            attestationIds.map(async (attId) => {
                const credentials = res.vp_token[attId] as unknown as string[];
                const dcqlCredential =
                    presentationConfig.dcql_query.credentials.find(
                        (c) => c.id === attId,
                    );

                if (!dcqlCredential) {
                    throw new ConflictException(
                        `${attId} not found in the presentation config`,
                    );
                }

                // Find transaction data entries that reference this credential
                // The strings are already base64url-encoded from the request object
                // We need to decode them to check credential_ids, then use the original encoded string for hash validation
                const relevantTransactionData = transactionDataStrings?.filter(
                    (tdStr) => {
                        try {
                            const td = JSON.parse(
                                Buffer.from(base64url.decode(tdStr)).toString(),
                            ) as { credential_ids?: string[] };
                            return td.credential_ids?.includes(attId);
                        } catch {
                            return false;
                        }
                    },
                );

                const loteAuthorities =
                    dcqlCredential.trusted_authorities?.find(
                        (auth): auth is TrustedAuthorityQueryEtsiTl =>
                            auth.type === TrustedAuthorityType.ETSI_TL,
                    );

                const federationAuthorities =
                    dcqlCredential.trusted_authorities?.find(
                        (auth): auth is TrustedAuthorityQueryOpenIdFederation =>
                            auth.type ===
                            TrustedAuthorityType.OPENID_FEDERATION,
                    );

                const resolvedLoteAuthorities =
                    await this.resolveTrustListRefsForTenant(
                        loteAuthorities?.values,
                        session.tenantId,
                        tenantHost,
                    );

                const verifyOptions: VerifierOptions = {
                    trustListSource: {
                        lotes: resolvedLoteAuthorities,
                        acceptedServiceTypes: [
                            ServiceTypeIdentifier.EaaIssuance,
                            ServiceTypeIdentifier.PIDIssuance,
                        ],
                        tenantId: session.tenantId,
                    },
                    federationTrustSource: federationAuthorities?.values.length
                        ? {
                              mode: "hybrid",
                              trustAnchors: federationAuthorities.values.map(
                                  (value) => ({
                                      entityId: value,
                                      entityConfigurationUri: `${value.replace(/\/$/, "")}/.well-known/openid-federation`,
                                  }),
                              ),
                          }
                        : undefined,
                    policy: {
                        requireX5c: true,
                        revocation: revocationModeToPolicy(
                            presentationConfig.statusCheckMode,
                        ),
                    },
                    skewSeconds:
                        session.skewSeconds ??
                        presentationConfig.skewSeconds ??
                        DEFAULT_VERIFIER_SKEW_SECONDS,
                    // Pass transaction data for hash validation (only for credentials that have it)
                    transactionData: relevantTransactionData,
                    ts12TransactionData: relevantTransactionData?.some(
                        (tdStr) => {
                            try {
                                const transactionData = JSON.parse(
                                    Buffer.from(
                                        base64url.decode(tdStr),
                                    ).toString(),
                                ) as { type?: string };
                                return (
                                    transactionData.type?.startsWith(
                                        "urn:eudi:sca:",
                                    ) ?? false
                                );
                            } catch {
                                return false;
                            }
                        },
                    ),
                    keyBindingResponseMode:
                        requestObjectSessionData?.response_mode,
                };

                const type = this.getType(session.requestObject!, attId);

                // Extract required claim keys from DCQL claims
                const requiredClaimKeys = this.getRequiredClaimKeys(
                    dcqlCredential.claims,
                    type,
                );
                const claimSelections =
                    this.getCredentialClaimSelections(dcqlCredential);
                const hasClaimSets =
                    !!dcqlCredential.claim_sets &&
                    dcqlCredential.claim_sets.length > 0;

                const values = await Promise.all(
                    credentials.map(async (cred) => {
                        return this.verifyCredentialValue({
                            cred,
                            attId,
                            type,
                            session,
                            requestObjectSessionData,
                            requestObjectJwkThumbprint,
                            verifyOptions,
                            dcqlCredential,
                            claimSelections,
                            hasClaimSets,
                            requiredClaimKeys,
                        });
                    }),
                );

                return { id: attId, values };
            }),
        );

        return results;
    }

    private resolveSdJwtKeyBindingAudience(
        session: Session,
        requestObjectSessionData:
            | {
                  client_id?: string;
                  expected_origins?: string[];
              }
            | undefined,
    ): string | undefined {
        const defaultAudience =
            requestObjectSessionData?.client_id ?? session.clientId;

        if (!session.useDcApi) {
            return defaultAudience;
        }

        const expectedOrigin = requestObjectSessionData?.expected_origins?.[0];
        const normalizedOrigin = this.normalizeDcApiOrigin(expectedOrigin);
        if (normalizedOrigin) {
            return `origin:${normalizedOrigin}`;
        }

        this.logger.warn(
            {
                sessionId: session.id,
                expectedOrigin,
                defaultAudience,
            },
            "Missing or invalid expected_origin for DC API; falling back to client_id for SD-JWT key binding audience",
        );
        return defaultAudience;
    }

    private normalizeDcApiOrigin(
        origin: string | undefined,
    ): string | undefined {
        if (!origin) {
            return undefined;
        }

        const trimmed = origin.trim();
        if (!trimmed) {
            return undefined;
        }

        const withoutPrefix = trimmed.startsWith("origin:")
            ? trimmed.slice("origin:".length)
            : trimmed;
        const withProtocol = /^https?:\/\//i.test(withoutPrefix)
            ? withoutPrefix
            : `http://${withoutPrefix}`;

        try {
            const parsed = new URL(withProtocol);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                return undefined;
            }

            return parsed.origin;
        } catch {
            return undefined;
        }
    }

    /**
     * Get the credential type based on the configuration id.
     * @param jwt
     * @param att
     * @returns
     */
    getType(jwt: string, att: string): CredentialType {
        const payload = decodeJwt<any>(jwt);
        return payload.dcql_query.credentials.find(
            (credential: { id: string; format: CredentialType }) =>
                credential.id === att,
        ).format;
    }

    /**
     * Validates that the presentation response contains all required credentials.
     * If credential_sets are defined, validates that at least one option set is fully satisfied.
     * If no credential_sets are defined, all credentials in the query are required.
     *
     * @param receivedCredentialIds - Array of credential IDs received in the response
     * @param requiredCredentials - Array of credential queries from DCQL
     * @param credentialSets - Optional credential set queries from DCQL
     * @throws IncompletePresentationException if validation fails
     */
    private validateCredentialCompleteness(
        receivedCredentialIds: string[],
        requiredCredentials: CredentialQueryValue[],
        credentialSets?: CredentialSetQuery[],
    ): void {
        const allCredentialIds = requiredCredentials.map((c) => c.id);
        const receivedSet = new Set(receivedCredentialIds);

        if (credentialSets && credentialSets.length > 0) {
            // Validate credential_sets - for each required set, at least one option must be satisfied
            const unsatisfiedSets: number[] = [];

            for (let i = 0; i < credentialSets.length; i++) {
                const credentialSet = credentialSets[i];

                // Default to required if not explicitly set to false
                if (credentialSet.required === false) {
                    continue;
                }

                // Check if at least one option set is fully satisfied
                const isSatisfied = credentialSet.options.some((optionSet) =>
                    optionSet.every((credId) => receivedSet.has(credId)),
                );

                if (!isSatisfied) {
                    unsatisfiedSets.push(i);
                }
            }

            if (unsatisfiedSets.length > 0) {
                throw new IncompletePresentationException(
                    `Credential sets not satisfied: ${unsatisfiedSets.map((i) => `set[${i}]`).join(", ")}`,
                    { unsatisfiedCredentialSets: unsatisfiedSets },
                );
            }
        } else {
            // No credential_sets defined - all credentials in the query are required
            const missingCredentials = allCredentialIds.filter(
                (id) => !receivedSet.has(id),
            );

            if (missingCredentials.length > 0) {
                throw new IncompletePresentationException(
                    `Missing required credentials: ${missingCredentials.join(", ")}`,
                    { missingCredentials },
                );
            }
        }
    }

    /**
     * Converts DCQL claim queries to required claim keys for verification.
     *
     * For SD-JWT-VC: paths are joined with dots (e.g., ["address", "locality"] -> "address.locality")
     * For mDOC: the first path element is the namespace, so we return the claim name (second element)
     *
     * @param claims - Array of claim queries from DCQL
     * @param credentialType - The type of credential ("dc+sd-jwt" or "mso_mdoc")
     * @returns Array of required claim keys in the format expected by the verifier
     */
    private getRequiredClaimKeys(
        claims: ClaimsQuery[] | undefined,
        credentialType: CredentialType,
    ): string[] {
        if (!claims || claims.length === 0) {
            return [];
        }

        return claims.map((claim) => {
            if (credentialType === "mso_mdoc") {
                // For mDOC, path is [namespace, claimName]
                // We return just the claim name for internal tracking
                // Actual validation happens in validateMdocClaims
                return claim.path.length > 1
                    ? claim.path.slice(1).join(".")
                    : claim.path[0];
            }
            // For SD-JWT-VC, join path with dots
            return claim.path.join(".");
        });
    }

    /**
     * Validates that all required claims from the DCQL query are present in the mDOC response.
     *
     * @param credentialId - The credential ID for error reporting
     * @param requiredClaims - Array of claim queries from DCQL
     * @param receivedClaims - Claims received in the mDOC response
     * @throws IncompletePresentationException if any required claims are missing
     */
    private validateMdocClaims(
        credentialId: string,
        requiredClaims: ClaimsQuery[] | undefined,
        receivedClaims: Record<string, unknown>,
    ): void {
        if (!requiredClaims || requiredClaims.length === 0) {
            return;
        }

        const missingClaims: string[] = [];

        for (const claim of requiredClaims) {
            // For mDOC, path is [namespace, claimName] or just [claimName]
            // The verifier already flattens claims from all namespaces
            const claimName =
                claim.path.length > 1 ? claim.path[1] : claim.path[0];

            this.logger.debug(
                {
                    credentialId,
                    claimName,
                    receivedClaimKeys: Object.keys(receivedClaims),
                },
                "Validating mDOC claim presence",
            );
            this.logger.trace(
                { credentialId, claimName, receivedClaims },
                "[TRACE] mDOC full received claims payload",
            );
            // Check if claim exists in received claims
            if (!(claimName in receivedClaims)) {
                // Format as namespace.claimName for better error message
                const fullPath = claim.path.join(".");
                missingClaims.push(fullPath);
            }
        }

        if (missingClaims.length > 0) {
            throw new IncompletePresentationException(
                `Missing required claims for credential '${credentialId}': ${missingClaims.join(", ")}`,
                { missingClaims: { [credentialId]: missingClaims } },
            );
        }
    }

    private getCredentialClaimSelections(
        credential: CredentialQueryValue,
    ): ClaimsQuery[][] {
        const claims = credential.claims ?? [];

        if (!credential.claim_sets || credential.claim_sets.length === 0) {
            return [claims];
        }

        const claimsById = new Map(
            claims
                .filter(
                    (claim): claim is ClaimsQuery & { id: string } =>
                        typeof claim.id === "string" && claim.id.trim() !== "",
                )
                .map((claim) => [claim.id, claim] as const),
        );

        return credential.claim_sets.map((claimSet) => {
            const resolvedClaims = claimSet.map((claimId) => {
                const claim = claimsById.get(claimId);
                if (!claim) {
                    throw new BadRequestException(
                        `claim_sets references unknown claim id '${claimId}' for credential '${credential.id}'`,
                    );
                }
                return claim;
            });

            return resolvedClaims;
        });
    }

    private async verifyCredentialValue(options: {
        cred: string;
        attId: string;
        type: CredentialType;
        session: Session;
        requestObjectSessionData:
            | {
                  nonce?: string;
                  client_id?: string;
                  response_uri?: string;
                  response_mode?: string;
                  expected_origins?: string[];
              }
            | undefined;
        requestObjectJwkThumbprint: Uint8Array | undefined;
        verifyOptions: VerifierOptions;
        dcqlCredential: CredentialQueryValue;
        claimSelections: ClaimsQuery[][];
        hasClaimSets: boolean;
        requiredClaimKeys: string[];
    }): Promise<Record<string, unknown>> {
        if (options.type === "mso_mdoc") {
            return this.verifyMdocCredentialValue(options);
        }

        if (options.type === "dc+sd-jwt") {
            return this.verifySdJwtCredentialValue(options);
        }

        throw new ConflictException(
            `Unsupported credential type: ${options.type}`,
        );
    }

    private async verifyMdocCredentialValue(options: {
        cred: string;
        attId: string;
        session: Session;
        requestObjectSessionData:
            | {
                  nonce?: string;
                  client_id?: string;
                  response_uri?: string;
                  response_mode?: string;
                  expected_origins?: string[];
              }
            | undefined;
        requestObjectJwkThumbprint: Uint8Array | undefined;
        verifyOptions: VerifierOptions;
        dcqlCredential: CredentialQueryValue;
        claimSelections: ClaimsQuery[][];
        hasClaimSets: boolean;
    }): Promise<Record<string, unknown>> {
        // DC API flows use the OID4VPDCAPIHandover transcript (origin + nonce),
        // while classic OID4VP uses OpenID4VPHandover (clientId + responseUri + nonce).
        // Passing the wrong protocol makes DeviceAuth verification fail.
        const sessionData: MdocSessionDataOid4vp | MdocSessionDataDcApi =
            options.session.useDcApi
                ? {
                      protocol: "dc_api" as const,
                      nonce:
                          options.requestObjectSessionData?.nonce ??
                          (options.session.vp_nonce as string),
                      origin:
                          options.requestObjectSessionData
                              ?.expected_origins?.[0] ?? "",
                      jwkThumbprint: options.requestObjectJwkThumbprint,
                  }
                : {
                      protocol: "openid4vp" as const,
                      nonce:
                          options.requestObjectSessionData?.nonce ??
                          (options.session.vp_nonce as string),
                      clientId:
                          options.requestObjectSessionData?.client_id ??
                          options.session.clientId!,
                      responseUri:
                          options.requestObjectSessionData?.response_uri ??
                          options.session.responseUri!,
                      responseMode:
                          options.requestObjectSessionData?.response_mode ??
                          "direct_post.jwt",
                      jwkThumbprint: options.requestObjectJwkThumbprint,
                  };
        if (options.hasClaimSets) {
            return this.verifyMdocCredentialWithClaimSets({
                ...options,
                sessionData,
            });
        }

        const result = await this.credentialVerifierFormats
            .resolve("mso_mdoc")
            .verify(
                options.cred,
                sessionData,
                options.verifyOptions,
                options.dcqlCredential.claims?.map((claim) => claim.path),
            );

        if (!result.verified) {
            this.throwMdocVerificationFailure(options.attId, result);
        }

        this.validateMdocClaims(
            options.attId,
            options.dcqlCredential.claims,
            result.claims,
        );

        return result.claims;
    }

    private async verifyMdocCredentialWithClaimSets(options: {
        cred: string;
        attId: string;
        sessionData: MdocSessionDataOid4vp | MdocSessionDataDcApi;
        verifyOptions: VerifierOptions;
        dcqlCredential: CredentialQueryValue;
        claimSelections: ClaimsQuery[][];
    }): Promise<Record<string, unknown>> {
        let lastVerificationFailure:
            | {
                  failureType?: VerificationFailureType;
                  failureReason?: string;
              }
            | undefined;

        for (const selectedClaims of options.claimSelections) {
            let result;

            try {
                result = await this.credentialVerifierFormats
                    .resolve("mso_mdoc")
                    .verify(
                        options.cred,
                        options.sessionData,
                        options.verifyOptions,
                        selectedClaims.map((claim) => claim.path),
                    );
            } catch (error) {
                lastVerificationFailure = {
                    failureType: "verification_error",
                    failureReason:
                        error instanceof Error ? error.message : undefined,
                };

                continue;
            }

            if (!result.verified) {
                lastVerificationFailure = result;
                continue;
            }

            if (this.matchesMdocClaimSelection(result.claims, selectedClaims)) {
                return result.claims;
            }
        }

        if (lastVerificationFailure) {
            this.throwMdocVerificationFailure(
                options.attId,
                lastVerificationFailure,
            );
        }

        throw new IncompletePresentationException(
            `Credential "${options.attId}" does not satisfy any claim_set`,
            {
                missingClaims: {
                    [options.attId]:
                        options.dcqlCredential.claims?.map((claim) =>
                            claim.path.join("."),
                        ) ?? [],
                },
            },
        );
    }

    private async verifySdJwtCredentialValue(options: {
        cred: string;
        attId: string;
        session: Session;
        requestObjectSessionData:
            | {
                  nonce?: string;
                  client_id?: string;
                  response_uri?: string;
                  response_mode?: string;
                  expected_origins?: string[];
              }
            | undefined;
        requestObjectJwkThumbprint: Uint8Array | undefined;
        verifyOptions: VerifierOptions;
        dcqlCredential: CredentialQueryValue;
        claimSelections: ClaimsQuery[][];
        hasClaimSets: boolean;
        requiredClaimKeys: string[];
    }): Promise<Record<string, unknown>> {
        const result = await this.credentialVerifierFormats
            .resolve("dc+sd-jwt")
            .verify(options.cred, {
                requiredClaimKeys: options.hasClaimSets
                    ? []
                    : options.requiredClaimKeys,
                keyBindingNonce: options.session.vp_nonce!,
                keyBindingAudience: this.resolveSdJwtKeyBindingAudience(
                    options.session,
                    options.requestObjectSessionData,
                ),
                ...options.verifyOptions,
            });

        if (options.hasClaimSets) {
            const matchingSelection = options.claimSelections.find(
                (selectedClaims) =>
                    this.matchesClaimSelection(
                        (result.payload ?? {}) as Record<string, unknown>,
                        options.dcqlCredential.claims,
                        selectedClaims,
                    ),
            );

            if (!matchingSelection) {
                throw new IncompletePresentationException(
                    `Credential "${options.attId}" does not satisfy any claim_set`,
                    {
                        missingClaims: {
                            [options.attId]:
                                options.dcqlCredential.claims?.map((claim) =>
                                    claim.path.join("."),
                                ) ?? [],
                        },
                    },
                );
            }
        }

        this.logger.debug(
            {
                credentialId: options.attId,
                requiredClaimKeys: options.hasClaimSets
                    ? []
                    : options.requiredClaimKeys,
                disclosedClaimKeys: Object.keys(result.payload ?? {}),
            },
            "SD-JWT-VC disclosed claims after verification",
        );
        this.logger.trace(
            {
                credentialId: options.attId,
                requiredClaimKeys: options.hasClaimSets
                    ? []
                    : options.requiredClaimKeys,
                disclosedClaims: result.payload,
            },
            "[TRACE] SD-JWT-VC full disclosed claims payload",
        );

        return {
            ...result.payload,
            cnf: undefined,
            status: undefined,
        };
    }

    private throwMdocVerificationFailure(
        attId: string,
        result: {
            failureType?: VerificationFailureType;
            failureReason?: string;
        },
    ): never {
        const reasonByType: Record<VerificationFailureType, string> = {
            signature_invalid: "mDOC signature is invalid",
            no_trust_chain_to_root:
                "no trust chain to a trusted root could be built",
            trust_chain_not_trusted:
                "certificate chain does not match any trusted entity",
            trust_list_unavailable:
                "the configured trust list could not be loaded",
            certificate_expired:
                "the issuer certificate is expired or not yet valid",
            x5c_missing:
                "credential does not include an x5c chain but it is required",
            verification_error: "mDOC verification failed",
        };

        const mappedReason = result.failureType
            ? reasonByType[result.failureType]
            : undefined;

        // Failures are classified at the source now (classifyVerificationError
        // / mapChainErrorToFailureType in the mDOC verifier), so the reason maps
        // straight off failureType. The previous text-sniffing fallback is gone:
        // it guessed at a trust failure by pattern-matching the verbose
        // diagnostic, and its `!mappedReason` guard silently disabled it for
        // `verification_error` — the one bucket that actually needed it.
        const reason = mappedReason || "mDOC verification failed";

        this.logger.warn(
            {
                credentialId: attId,
                failureType: result.failureType,
                failureReason: result.failureReason,
            },
            "mDOC verification failed",
        );

        throw new BadRequestException(
            `mDOC verification failed for credential "${attId}": ${reason}`,
        );
    }

    private matchesClaimSelection(
        payload: Record<string, unknown>,
        allClaims: ClaimsQuery[] | undefined,
        selectedClaims: ClaimsQuery[],
    ): boolean {
        if (!allClaims || allClaims.length === 0) {
            return selectedClaims.length === 0;
        }

        return selectedClaims.every((claim) =>
            this.hasClaimPath(payload, claim.path),
        );
    }

    private matchesMdocClaimSelection(
        payload: Record<string, unknown>,
        selectedClaims: ClaimsQuery[],
    ): boolean {
        return selectedClaims.every((claim) => {
            const claimName =
                claim.path.length > 1 ? claim.path[1] : claim.path[0];

            return claimName in payload;
        });
    }

    private areClaimPathsEqual(left: string[], right: string[]): boolean {
        if (left.length !== right.length) {
            return false;
        }

        return left.every((segment, index) => segment === right[index]);
    }

    private hasClaimPath(value: unknown, path: string[]): boolean {
        let current: unknown = value;

        for (const segment of path) {
            if (current === null || current === undefined) {
                return false;
            }

            if (Array.isArray(current)) {
                const index = Number(segment);
                if (!Number.isInteger(index) || index < 0) {
                    return false;
                }

                current = current[index];
                continue;
            }

            if (typeof current !== "object") {
                return false;
            }

            if (!(segment in current)) {
                return false;
            }

            current = (current as Record<string, unknown>)[segment];
        }

        return current !== undefined;
    }
}
