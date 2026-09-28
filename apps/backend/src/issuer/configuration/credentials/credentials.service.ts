import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Jwk } from "@openid4vc/oauth2";
import type { CredentialConfigurationSupported } from "@openid4vc/openid4vci";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { CryptoImplementationService } from "../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import type { SessionData as Session } from "../../../session/domain/session-data.js";
import { VCT } from "../../issuance/oid4vci/metadata/dto/vct.dto.js";
import { IssueCredential } from "./application/issue-credential.js";
import {
    CREDENTIAL_SETTINGS,
    type CredentialSettings,
} from "./credential-settings.js";
import type { CredentialConfiguration as CredentialConfig } from "./domain/credential-configuration.js";
import {
    CredentialFormat,
    CredentialProofType,
} from "./entities/credential.entity.js";
import {
    CREDENTIAL_CONFIGURATION_REPOSITORY,
    type CredentialConfigurationRepository,
} from "./ports/credential-configuration.repository.js";
import {
    type BuildCredentialConfigOptions,
    buildMsoMdocConfig,
    buildSdJwtDcConfig,
    MSO_MDOC_FORMAT,
    type TypedCredentialConfig,
    toCredentialConfigurationSupported,
} from "./types/credential-config-types.js";
import { buildClaimsMetadata, buildJsonSchema } from "./utils/index.js";

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
     * @param credentialIssuerFormats
     * @param cryptoImplementationService
     */
    constructor(
        @Inject(CREDENTIAL_SETTINGS)
        private readonly settings: CredentialSettings,
        @Inject(CREDENTIAL_CONFIGURATION_REPOSITORY)
        private readonly credentialConfigurationRepository: CredentialConfigurationRepository,
        private readonly issueCredential: IssueCredential,
        private readonly cryptoImplementationService: CryptoImplementationService,
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
        return this.credentialConfigurationRepository.findForTenant(
            tenantId,
            id,
        );
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
            return this.credentialConfigurationRepository.listForTenant(
                tenantId,
            );
        }

        const uniqueIds = Array.from(new Set(ids));
        const configs =
            await this.credentialConfigurationRepository.listForTenant(
                tenantId,
                uniqueIds,
            );

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

        const configs =
            await this.credentialConfigurationRepository.listForTenant(
                tenantId,
            );

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
        config: CredentialConfig["config"],
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
        config: CredentialConfig["config"],
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
        const config =
            await this.credentialConfigurationRepository.findForTenant(
                tenantId,
                credentialConfigurationId,
            );

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
            vct = `${this.settings.publicUrl}/issuers/${tenantId}/credentials-metadata/vct/${entity.id}`;
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
        // AJV instance with draft 2020-12 meta-schema support.
        // removeAdditional:"all" ensures only schema-declared properties remain on the claims object.
        const ajv = new Ajv({
            allErrors: true,
            strict: true,
            removeAdditional: "all", // strip properties not defined in the schema
            useDefaults: true, // optionally apply default values from schema
        });
        //fetch the credential configuration
        return this.credentialConfigurationRepository
            .getForTenant(tenantId, credentialConfigurationId)
            .then((credentialConfiguration) => {
                //if a schema is defined, validate the claims against it
                const schema = buildJsonSchema(
                    credentialConfiguration.fields as any,
                );
                if (schema && Object.keys(schema.properties ?? {}).length > 0) {
                    const validate = ajv.compile(schema as any);
                    const valid = validate(claims); // claims mutated: unknown props removed, defaults applied
                    if (!valid) {
                        throw new ConflictException(
                            `Claims do not conform to the schema for credential configuration with id ${credentialConfigurationId}: ${ajv.errorsText(
                                validate.errors,
                            )}`,
                        );
                    }
                }
            });
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
        return this.issueCredential.execute({
            credentialConfigurationId,
            holderKey: holderCnf,
            session,
            preloadedClaims,
            issuanceSetId,
        });
    }

    /**
     * Retrieves the VCT (Verifiable Credential Type) for a specific credential configuration.
     * @param credentialId
     * @param tenantId
     * @returns
     */
    async getVCT(credentialId: string, tenantId: string): Promise<VCT> {
        const credentialConfig = await this.credentialConfigurationRepository
            .getForTenant(tenantId, credentialId)
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
        const host = this.settings.publicUrl;
        credentialConfig.vct.vct = `${host}/issuers/${tenantId}/credentials-metadata/vct/${credentialConfig.id}`;
        return credentialConfig.vct;
    }
}
