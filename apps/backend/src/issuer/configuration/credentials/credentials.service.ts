import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { Jwk } from "@openid4vc/oauth2";
import type { CredentialConfigurationSupported } from "@openid4vc/openid4vci";
import type { ErrorObject } from "ajv";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { In, Repository } from "typeorm";
import { CryptoImplementationService } from "../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { Session } from "../../../session/entities/session.entity.js";
import { FederationTrustService } from "../../../trust/federation-trust.service.js";
import { WebhookConfig } from "../../../webhook/webhook.dto.js";
import { WebhookService } from "../../../webhook/webhook.service.js";
import { VCT } from "../../issuance/oid4vci/metadata/dto/vct.dto.js";
import { AttributeProviderEntity } from "../attribute-provider/entities/attribute-provider.entity.js";
import { IssuanceService } from "../issuance/issuance.service.js";
import { AuthorizationIdentity } from "./dto/authorization-identity.js";
import { ClaimsWebhookResult } from "./dto/claims-webhook-result.js";
import {
    CredentialConfig,
    CredentialFormat,
    CredentialProofType,
    IssuerMetadataCredentialConfig,
} from "./entities/credential.entity.js";
import { InvalidClaimsException } from "./exceptions/invalid-claims.exception.js";
import { MdocIssuerService } from "./issuer/mdoc-issuer/mdoc-issuer.service.js";
import { SdjwtvcIssuerService } from "./issuer/sdjwtvc-issuer/sdjwtvc-issuer.service.js";
import {
    type BuildCredentialConfigOptions,
    buildMsoMdocConfig,
    buildSdJwtDcConfig,
    MSO_MDOC_FORMAT,
    type TypedCredentialConfig,
    toCredentialConfigurationSupported,
} from "./types/credential-config-types.js";
import {
    buildClaims,
    buildClaimsMetadata,
    buildJsonSchema,
} from "./utils/index.js";

/**
 * Service for managing credentials and their configurations.
 * Delegates actual credential issuance to format-specific services.
 */
@Injectable()
export class CredentialsService {
    private static readonly DEFAULT_PROOF_TYPES: CredentialProofType[] = [
        CredentialProofType.ATTESTATION,
        CredentialProofType.JWT,
    ];

    /**
     * Constructor for CredentialsService.
     * @param configService
     * @param credentialConfigRepo
     * @param webhookService
     * @param sdjwtvcIssuerService
     * @param mdocIssuerService
     * @param cryptoImplementationService
     */
    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(CredentialConfig)
        private readonly credentialConfigRepo: Repository<CredentialConfig>,
        @InjectRepository(AttributeProviderEntity)
        private readonly attributeProviderRepo: Repository<AttributeProviderEntity>,
        private readonly webhookService: WebhookService,
        private readonly sdjwtvcIssuerService: SdjwtvcIssuerService,
        private readonly mdocIssuerService: MdocIssuerService,
        private readonly cryptoImplementationService: CryptoImplementationService,
        private readonly issuanceService: IssuanceService,
        private readonly federationTrustService: FederationTrustService,
    ) {}

    /**
     * Returns a single credential configuration by ID.
     * @param id The credential configuration ID
     * @param tenantId The tenant ID
     * @returns The credential configuration or null if not found
     */
    async getCredentialConfig(
        id: string,
        tenantId: string,
    ): Promise<CredentialConfig | null> {
        return this.credentialConfigRepo.findOneBy({ id, tenantId });
    }

    /**
     * Returns tenant credential configurations, optionally filtered by IDs.
     * Throws when one or more requested IDs do not exist.
     */
    async getCredentialConfigsForTenant(
        tenantId: string,
        ids?: string[],
    ): Promise<CredentialConfig[]> {
        if (!ids?.length) {
            return this.credentialConfigRepo.findBy({ tenantId });
        }

        const uniqueIds = Array.from(new Set(ids));
        const configs = await this.credentialConfigRepo.findBy({
            tenantId,
            id: In(uniqueIds),
        });

        if (configs.length !== uniqueIds.length) {
            const foundIds = new Set(configs.map((config) => config.id));
            const missing = uniqueIds.filter((id) => !foundIds.has(id));
            throw new ConflictException(
                `Credential configuration(s) not found: ${missing.join(", ")}`,
            );
        }

        return configs;
    }

    /**
     * Returns the credential configuration that is required for oid4vci
     * @param tenantId
     * @returns
     */
    async getCredentialConfigurationSupported(
        tenantId: string,
    ): Promise<Record<string, CredentialConfigurationSupported>> {
        const credentialConfigurationsSupported: Record<
            string,
            CredentialConfigurationSupported
        > = {};

        const configs = await this.credentialConfigRepo.findBy({
            tenantId,
        });

        for (const entity of configs) {
            const builtConfig = this.buildCredentialConfiguration(
                entity,
                tenantId,
            );
            credentialConfigurationsSupported[entity.id] =
                toCredentialConfigurationSupported(
                    builtConfig,
                ) as CredentialConfigurationSupported;
        }
        return credentialConfigurationsSupported;
    }

    /**
     * Builds a typed credential configuration from the stored entity.
     * Uses format-specific builders for proper type safety.
     * @param entity The credential config entity from the database
     * @param tenantId The tenant ID for generating URLs
     * @returns A properly typed credential configuration
     */
    private buildCredentialConfiguration(
        entity: CredentialConfig,
        tenantId: string,
    ): TypedCredentialConfig & { disclosure_policy?: unknown } {
        const format = entity.config.format;

        if (format === MSO_MDOC_FORMAT) {
            // For mDOC, algorithms are COSE numbers
            const algs = this.cryptoImplementationService.getAlgs(
                format,
            ) as number[];
            return this.buildMdocConfiguration(entity, algs);
        } else {
            // For SD-JWT, algorithms are JOSE strings
            const algs = this.cryptoImplementationService.getAlgs(
                format,
            ) as string[];
            return this.buildSdJwtConfiguration(entity, tenantId, algs);
        }
    }

    private resolveConfiguredProofTypes(
        config: IssuerMetadataCredentialConfig,
    ): CredentialProofType[] {
        const configured = config.proofTypesSupported;
        if (!Array.isArray(configured) || configured.length === 0) {
            return [...CredentialsService.DEFAULT_PROOF_TYPES];
        }

        const supported = new Set(configured);
        return CredentialsService.DEFAULT_PROOF_TYPES.filter((proofType) =>
            supported.has(proofType),
        );
    }

    /**
     * Builds `proof_types_supported` for a credential configuration.
     *
     * Both proof types only carry `key_attestations_required` when constraints are
     * configured, otherwise wallets are not required to attach a key attestation.
     */
    private buildProofTypesSupported(
        config: IssuerMetadataCredentialConfig,
        algs: string[],
    ): BuildCredentialConfigOptions["proofTypesSupported"] {
        const supportedProofTypes = this.resolveConfiguredProofTypes(config);
        const configuredKeyAttestations = config.keyAttestationsRequired;
        const proofTypesSupported: Record<string, Record<string, unknown>> = {};

        if (supportedProofTypes.includes(CredentialProofType.ATTESTATION)) {
            proofTypesSupported.attestation = {
                proof_signing_alg_values_supported: algs,
                ...(configuredKeyAttestations && {
                    key_attestations_required: {
                        ...configuredKeyAttestations,
                    },
                }),
            };
        }

        if (supportedProofTypes.includes(CredentialProofType.JWT)) {
            proofTypesSupported.jwt = {
                proof_signing_alg_values_supported: algs,
                ...(configuredKeyAttestations && {
                    key_attestations_required: {
                        ...configuredKeyAttestations,
                    },
                }),
            };
        }

        return proofTypesSupported as BuildCredentialConfigOptions["proofTypesSupported"];
    }

    private buildCredentialMetadata(
        entity: CredentialConfig,
    ): Record<string, unknown> | undefined {
        const metadata: Record<string, unknown> = {};
        if (entity.config.display) {
            metadata.display = entity.config.display;
        }
        if (entity.fields.length > 0) {
            metadata.claims = buildClaimsMetadata(entity.fields as any);
        }
        if (entity.config.credentialReusePolicy) {
            metadata.credential_reuse_policy =
                entity.config.credentialReusePolicy;
        }
        return Object.keys(metadata).length > 0 ? metadata : undefined;
    }

    async getSupportedProofTypesForCredentialConfig(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<CredentialProofType[]> {
        const config = await this.credentialConfigRepo.findOneBy({
            id: credentialConfigurationId,
            tenantId,
        });

        if (!config) {
            throw new ConflictException(
                `Credential configuration '${credentialConfigurationId}' not found`,
            );
        }

        return this.resolveConfiguredProofTypes(config.config);
    }

    /**
     * Builds an mDOC credential configuration
     */
    private buildMdocConfiguration(
        entity: CredentialConfig,
        algs: number[],
    ): TypedCredentialConfig & { disclosure_policy?: unknown } {
        const doctype = entity.config.docType;
        if (!doctype) {
            throw new ConflictException(
                `mDOC credential configuration ${entity.id} missing required docType`,
            );
        }

        // Build credential_metadata with display and claims
        const credentialMetadata = this.buildCredentialMetadata(entity);

        const proofTypesSupported = this.buildProofTypesSupported(
            entity.config,
            this.cryptoImplementationService.getAlgs(
                CredentialFormat.SD_JWT_VC,
            ) as string[],
        );

        const config = buildMsoMdocConfig(
            doctype,
            {
                signingAlgorithms: algs,
                bindingMethods: ["cose_key"],
                proofTypesSupported,
            },
            credentialMetadata,
            entity.config.scope,
        );

        // Add disclosure policy if present
        if (entity.embeddedDisclosurePolicy) {
            const policy = { ...entity.embeddedDisclosurePolicy };
            delete (policy as Record<string, unknown>)["$schema"];
            return { ...config, disclosure_policy: policy };
        }

        return config;
    }

    /**
     * Builds an SD-JWT (dc+sd-jwt) credential configuration
     */
    private buildSdJwtConfiguration(
        entity: CredentialConfig,
        tenantId: string,
        algs: string[],
    ): TypedCredentialConfig & { disclosure_policy?: unknown } {
        // Resolve VCT - can be a string URI, an object (hosted by EUDIPLO), or null
        let vct: string;
        if (entity.vct && typeof entity.vct === "object") {
            // Generate URL for object-based vct hosted by EUDIPLO
            vct = `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}/credentials-metadata/vct/${entity.id}`;
        } else if (typeof entity.vct === "string") {
            // Use the string URI directly
            vct = entity.vct;
        } else {
            throw new ConflictException(
                `SD-JWT credential configuration ${entity.id} missing required vct`,
            );
        }

        // Build credential_metadata with display and claims
        const credentialMetadata = this.buildCredentialMetadata(entity);

        const proofTypesSupported = this.buildProofTypesSupported(
            entity.config,
            algs,
        );

        const config = buildSdJwtDcConfig(
            vct,
            {
                signingAlgorithms: algs,
                bindingMethods: ["jwk"],
                proofTypesSupported,
            },
            credentialMetadata,
            entity.config.scope,
        );

        // Add disclosure policy if present
        if (entity.embeddedDisclosurePolicy) {
            const policy = { ...entity.embeddedDisclosurePolicy };
            delete (policy as Record<string, unknown>)["$schema"];
            return { ...config, disclosure_policy: policy };
        }

        return config;
    }

    /**
     * Validates the provided claims against the schema defined in the credential configuration.
     * @param credentialConfigurationId
     * @param claims
     * @returns
     */
    validateClaimsForCredential(
        credentialConfigurationId: string,
        claims: Record<string, unknown>,
        tenantId: string,
    ) {
        return this.credentialConfigRepo
            .findOneByOrFail({ id: credentialConfigurationId, tenantId })
            .then((credentialConfiguration) =>
                this.validateClaims(credentialConfiguration, claims),
            );
    }

    /**
     * Validates claims against the schema derived from the credential configuration fields.
     * Configurations without fields are not validated.
     * @throws InvalidClaimsException with a message that names claim paths but never claim values
     */
    private validateClaims(
        credentialConfiguration: CredentialConfig,
        claims: Record<string, unknown>,
    ): void {
        const schema = buildJsonSchema(credentialConfiguration.fields as any);
        if (Object.keys(schema.properties ?? {}).length === 0) {
            return;
        }

        const ajv = new Ajv({
            allErrors: true,
            strict: true,
            useDefaults: true,
            validateSchema: false,
        });
        const validate = ajv.compile(schema as any);
        if (!validate(claims)) {
            throw new InvalidClaimsException(
                `Claims do not conform to the schema for credential configuration with id ${credentialConfiguration.id}: ${formatClaimErrors(validate.errors)}`,
            );
        }
    }

    /**
     * Fetches claims for a credential configuration from webhook.
     * Unified method that works for both internal and external AS flows.
     *
     * Webhook resolution priority:
     * 1. Webhook passed at offer time via session.credentialPayload.credentialClaims
     * 2. claimsWebhook configured on the credential configuration
     *
     * The webhook receives a unified payload:
     * - session: Session ID
     * - credential_configuration_id: The credential being requested
     * - identity: (optional) Identity context from AS token (iss, sub, token_claims)
     * - credentials: (optional) Presented credentials from presentation flow
     *
     * @param credentialConfigurationId The credential configuration ID
     * @param session The session associated with this request
     * @param options Optional parameters for the webhook
     * @param options.identity Identity context from authorization server (internal or external)
     * @param options.credentials Presented credentials (for presentation flows)
     * @param options.requireWebhook If true, throws if no webhook is configured (default: false)
     * @returns The fetched claims result including deferred flag, or undefined if no webhook is configured
     */
    async getClaimsFromWebhook(
        credentialConfigurationId: string,
        session: Session,
        options?: {
            identity?: AuthorizationIdentity;
            credentials?: any[];
            requireWebhook?: boolean;
        },
    ): Promise<ClaimsWebhookResult | undefined> {
        // First check for claims source passed at offer time via credentialClaims
        const claimsSource =
            session.credentialPayload?.credentialClaims?.[
                credentialConfigurationId
            ];
        let webhook: WebhookConfig | undefined | null;

        // Handle inline claims - return directly without webhook call
        if (claimsSource?.type === "inline") {
            return {
                deferred: false,
                claims: claimsSource.claims,
            };
        }

        // Handle webhook config passed directly at offer time
        if (claimsSource?.type === "webhook") {
            webhook = claimsSource.webhook;
        } else if (claimsSource?.type === "attributeProvider") {
            // Resolve the attribute provider by ID
            const provider = await this.attributeProviderRepo.findOneBy({
                id: claimsSource.attributeProviderId,
                tenantId: session.tenantId,
            });
            if (!provider) {
                throw new ConflictException(
                    `Attribute provider '${claimsSource.attributeProviderId}' not found`,
                );
            }
            webhook = { url: provider.url, auth: provider.auth };
        } else {
            // Fall back to credential config's attributeProviderId
            const credentialConfiguration =
                await this.credentialConfigRepo.findOneBy({
                    tenantId: session.tenantId,
                    id: credentialConfigurationId,
                });

            if (!credentialConfiguration) {
                throw new ConflictException(
                    `Credential configuration '${credentialConfigurationId}' not found`,
                );
            }

            if (credentialConfiguration.attributeProviderId) {
                const provider = await this.attributeProviderRepo.findOneBy({
                    id: credentialConfiguration.attributeProviderId,
                    tenantId: session.tenantId,
                });
                if (!provider) {
                    throw new ConflictException(
                        `Attribute provider '${credentialConfiguration.attributeProviderId}' not found`,
                    );
                }
                webhook = { url: provider.url, auth: provider.auth };
            }
        }

        // No webhook configured
        if (!webhook) {
            if (options?.requireWebhook) {
                throw new ConflictException(
                    `Authorization code flow requires an attribute provider to be configured on credential '${credentialConfigurationId}' ` +
                        `or provided at offer time.`,
                );
            }
            return undefined;
        }

        // Send webhook with unified payload
        const response = await this.webhookService.sendClaimsWebhook({
            webhook,
            session: session.id,
            credentialConfigurationId,
            identity: options?.identity,
            credentials: options?.credentials,
        });

        // Check if the webhook response indicates deferred issuance
        if (response.deferred) {
            return {
                deferred: true,
                interval: response.interval ?? 5,
            };
        }

        // Return claims for immediate issuance
        return {
            deferred: false,
            claims: response[credentialConfigurationId] as Record<string, any>,
        };
    }

    /**
     * Issues a credential based on the provided configuration and session.
     * Delegates to format-specific issuer services.
     * @param credentialConfigurationId
     * @param holderCnf
     * @param session
     * @param preloadedClaims Optional claims fetched from webhook (to avoid redundant calls in batch)
     * @param issuanceSetId Opaque identifier grouping credentials issued with one access token
     * @returns
     */
    async getCredential(
        credentialConfigurationId: string,
        holderCnf: Jwk,
        session: Session,
        preloadedClaims?: Record<string, any>,
        issuanceSetId?: string,
    ) {
        const credentialConfiguration =
            await this.credentialConfigRepo.findOneByOrFail({
                tenantId: session.tenantId,
                id: credentialConfigurationId,
            });

        if (!credentialConfiguration)
            throw new ConflictException(
                `Credential configuration with id ${credentialConfigurationId} not found`,
            );

        /**
         * Priority of the claims
         * 1. fetched via passed webhook (preloadedClaims)
         * 2. inline claims stored in the session
         * 3. webhook from the credential configuration
         * 4. static claims from the credential configuration
         */
        // Extract claims from the session's credentialClaims (discriminated union)
        let usedClaims = buildClaims(
            credentialConfiguration.fields as any,
        ) as Record<string, any>; // default fallback

        // Use preloaded claims if provided (from webhook or inline)
        if (preloadedClaims) {
            usedClaims = preloadedClaims;
        } else {
            // Fallback: check if inline claims are in the session
            const claimsSource =
                session.credentialPayload?.credentialClaims?.[
                    credentialConfigurationId
                ];
            if (claimsSource?.type === "inline") {
                usedClaims = claimsSource.claims;
            } else if (claimsSource?.type === "webhook") {
                // Use webhook config passed at offer time
                const webhookResponse = await this.webhookService.sendWebhook({
                    webhook: claimsSource.webhook,
                    session,
                    expectResponse: true,
                });
                if (webhookResponse?.[credentialConfigurationId]) {
                    usedClaims = webhookResponse[
                        credentialConfigurationId
                    ] as Record<string, any>;
                }
            } else if (credentialConfiguration.attributeProviderId) {
                const provider = await this.attributeProviderRepo.findOneBy({
                    id: credentialConfiguration.attributeProviderId,
                    tenantId: session.tenantId,
                });
                if (provider) {
                    const webhookResponse =
                        await this.webhookService.sendWebhook({
                            webhook: {
                                url: provider.url,
                                auth: provider.auth,
                            },
                            session,
                            expectResponse: true,
                        });
                    if (webhookResponse?.[credentialConfigurationId]) {
                        usedClaims = webhookResponse[
                            credentialConfigurationId
                        ] as Record<string, any>;
                    }
                }
            }
        }

        this.validateClaims(credentialConfiguration, usedClaims);

        // Load issuance config to check for federation settings
        let federationEntityId: string | undefined;
        try {
            const issuanceConfig =
                await this.issuanceService.getIssuanceConfiguration(
                    session.tenantId,
                );
            if (
                issuanceConfig.federation &&
                this.federationTrustService.isEnabled(issuanceConfig.federation)
            ) {
                federationEntityId = issuanceConfig.federation.entityId;
            }
        } catch {
            // If issuance config not found, proceed without federation
        }

        // Delegate to format-specific issuer service
        const format = credentialConfiguration.config.format;

        if (format === "mso_mdoc") {
            // For mDOC, holderCnf is the device key
            return this.mdocIssuerService.issue({
                credentialConfiguration,
                deviceKey: holderCnf,
                session,
                claims: usedClaims,
                issuanceSetId,
            });
        } else {
            // Default to SD-JWT VC (handles "dc+sd-jwt" and "vc+sd-jwt" formats)
            return this.sdjwtvcIssuerService.issue({
                credentialConfiguration,
                holderCnf,
                session,
                claims: usedClaims,
                federationEntityId,
                issuanceSetId,
            });
        }
    }

    /**
     * Retrieves the VCT (Verifiable Credential Type) for a specific credential configuration.
     * @param credentialId
     * @param tenantId
     * @returns
     */
    async getVCT(credentialId: string, tenantId: string): Promise<VCT> {
        const credentialConfig = await this.credentialConfigRepo
            .findOneByOrFail({
                id: credentialId,
                tenantId,
            })
            .catch(() => {
                throw new ConflictException(
                    `Credential configuration with id ${credentialId} not found`,
                );
            });
        if (!credentialConfig.vct) {
            throw new ConflictException(
                `VCT for credential configuration with id ${credentialId} not found`,
            );
        }
        // If vct is a string URI, this endpoint doesn't apply
        if (typeof credentialConfig.vct === "string") {
            throw new ConflictException(
                `VCT for credential configuration with id ${credentialId} is a URI, not hosted by this server`,
            );
        }
        const host = this.configService.getOrThrow<string>("PUBLIC_URL");
        credentialConfig.vct.vct = `${host}/issuers/${tenantId}/credentials-metadata/vct/${credentialConfig.id}`;
        return credentialConfig.vct;
    }
}

function joinClaimPath(instancePath: string, property: unknown): string {
    return `${instancePath}/${String(property)}`;
}

/**
 * Formats validation errors as claim paths and rule descriptions only, so the message can be
 * logged and returned without exposing claim values.
 */
function formatClaimErrors(errors: ErrorObject[] | null | undefined): string {
    return (errors ?? [])
        .map((error) => {
            if (error.keyword === "required") {
                return `${joinClaimPath(error.instancePath, error.params.missingProperty)}: missing required claim`;
            }
            if (error.keyword === "additionalProperties") {
                return `${joinClaimPath(error.instancePath, error.params.additionalProperty)}: unexpected claim`;
            }
            return `${error.instancePath || "/"}: ${error.message}`;
        })
        .join("; ");
}
