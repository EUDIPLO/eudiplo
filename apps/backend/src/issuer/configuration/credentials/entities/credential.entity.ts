import {
    ApiExtraModels,
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
    getSchemaPath,
} from "@nestjs/swagger";
import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../../../crypto/key/entities/key-chain.entity.js";
import { VCT } from "../../../issuance/oid4vci/metadata/dto/vct.dto.js";
import { AttributeProviderEntity } from "../../attribute-provider/entities/attribute-provider.entity.js";
import { KeyAttestationsRequired } from "../../issuance/dto/key-attestations-required.dto.js";
import { WebhookEndpointEntity } from "../../webhook-endpoint/entities/webhook-endpoint.entity.js";
import { ActiveCredentialPolicy } from "../dto/active-credential-policy.dto.js";
import { ClaimFieldDefinitionDto } from "../dto/claim-field-definition.dto.js";
import { CredentialReusePolicy } from "../dto/credential-reuse-policy.dto.js";
import { SchemaMetaConfig } from "../dto/schema-meta-config.dto.js";
import {
    IaeAction,
    IaeActionOpenid4vpPresentation,
    IaeActionRedirectToWeb,
} from "./iae-action.dto.js";
import {
    AllowListPolicy,
    AttestationBasedPolicy,
    EmbeddedDisclosurePolicy,
    NoneTrustPolicy,
    RootOfTrustPolicy,
} from "./policies.dto.js";

export class DisplayImage {
    uri!: string;
}
export class Display {
    name!: string;
    description!: string;
    locale!: string;
    background_color?: string;
    text_color?: string;
    background_image?: DisplayImage;
    logo?: DisplayImage;
}

export const CredentialFormat = {
    MSO_MDOC: "mso_mdoc",
    SD_JWT_VC: "dc+sd-jwt",
} as const;
export type CredentialFormat =
    (typeof CredentialFormat)[keyof typeof CredentialFormat];

/**
 * Determines how SD-JWT credentials are signed and trust is established.
 * - "x5c": Include certificate chain in JWT header (certificate-based trust)
 * - "federation": Include issuer entity ID in 'iss' claim (federation-based trust)
 * - "auto": Legacy mode kept for backward compatibility (treated like x5c)
 */
export const SdJwtTrustFormat = {
    X5C: "x5c",
    FEDERATION: "federation",
} as const;
export type SdJwtTrustFormat =
    (typeof SdJwtTrustFormat)[keyof typeof SdJwtTrustFormat];

export const CredentialProofType = {
    JWT: "jwt",
    ATTESTATION: "attestation",
} as const;
export type CredentialProofType =
    (typeof CredentialProofType)[keyof typeof CredentialProofType];

export class IssuerMetadataCredentialConfig {
    format!: CredentialFormat;
    display!: Display[];
    scope?: string;

    /**
     * Document type for mDOC credentials (e.g., "org.iso.18013.5.1.mDL").
     * Only applicable when format is "mso_mdoc".
     */
    docType?: string;

    /**
     * Key attestation requirements for JWT proofs for this credential.
     * When set, this is published in proof_types_supported.jwt.key_attestations_required
     * for this specific credential configuration.
     *
     * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#appendix-F
     */
    @ApiPropertyOptional({ type: () => KeyAttestationsRequired })
    keyAttestationsRequired?: KeyAttestationsRequired;

    /**
     * Per-credential proof type policy.
     * If omitted, both proof types are supported with attestation as default preference.
     */
    @ApiPropertyOptional({
        type: [String],
        enum: CredentialProofType,
        description:
            "Supported proof types for this credential configuration. Defaults to ['attestation', 'jwt'].",
        example: [CredentialProofType.ATTESTATION, CredentialProofType.JWT],
    })
    proofTypesSupported?: CredentialProofType[];

    @ApiPropertyOptional({ type: () => CredentialReusePolicy })
    credentialReusePolicy?: CredentialReusePolicy;
}

@ApiExtraModels(
    AttestationBasedPolicy,
    NoneTrustPolicy,
    AllowListPolicy,
    RootOfTrustPolicy,
    VCT,
    IaeActionOpenid4vpPresentation,
    IaeActionRedirectToWeb,
    WebhookEndpointEntity,
)
@Entity()
export class CredentialConfig {
    @Column("varchar", { primary: true })
    id!: string;

    @Column("varchar", { nullable: true })
    description?: string | null;

    @ApiHideProperty()
    @Column("varchar", { primary: true })
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    @Column("json")
    config!: IssuerMetadataCredentialConfig;

    @Column("json")
    fields!: ClaimFieldDefinitionDto[];

    /**
     * Reference to the attribute provider used for fetching claims.
     * Optional: if set, claims will be fetched from this provider during issuance.
     */
    @Column("varchar", { nullable: true })
    attributeProviderId?: string | null;

    @ManyToOne(() => AttributeProviderEntity, {
        createForeignKeyConstraints: false,
    })
    @JoinColumn([
        { name: "attributeProviderId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    attributeProvider?: AttributeProviderEntity;

    /**
     * Reference to the webhook endpoint used for notifications.
     * Optional: if set, notifications will be sent to this endpoint.
     */
    @Column("varchar", { nullable: true })
    webhookEndpointId?: string | null;

    @ManyToOne(() => WebhookEndpointEntity, {
        createForeignKeyConstraints: false,
    })
    @JoinColumn([
        { name: "webhookEndpointId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    webhookEndpoint?: WebhookEndpointEntity;

    @ApiPropertyOptional({
        description:
            "VCT as a URI string (e.g., urn:eudi:pid:de:1) or as an object for EUDIPLO-hosted VCT",
        anyOf: [
            { type: "string", description: "VCT URI string" },
            { $ref: getSchemaPath(VCT) },
            { type: "null" },
        ],
    })
    @Column("json", { nullable: true })
    vct?: string | VCT | null;

    @Column("boolean", { default: false })
    keyBinding?: boolean;

    /**
     * Reference to the key chain used for signing.
     * Optional: if not specified, the default attestation key chain will be used.
     */
    @Column("varchar", { nullable: true })
    keyChainId?: string;

    @ManyToOne(() => KeyChainEntity, { createForeignKeyConstraints: false })
    @JoinColumn([
        { name: "keyChainId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    keyChain?: KeyChainEntity;

    @Column("boolean", { default: false })
    statusManagement?: boolean;

    /**
     * Optional issuer-side policy limiting how many credentials of this
     * configuration a subject may hold active at once. When enabled, issuing a
     * new credential to a subject revokes that subject's previously issued
     * credentials for this configuration.
     *
     * Requires `statusManagement`, since revocation relies on status entries.
     *
     * Distinct from `credentialReusePolicy` (issuer metadata published to
     * wallets); this one is enforced by the issuer at issuance time.
     */
    @Column("json", { nullable: true })
    activeCredentials?: ActiveCredentialPolicy | null;

    /**
     * List of Interactive Authorization Endpoint (IAE) actions to execute
     * before credential issuance. Actions are executed in order.
     *
     * Each action can be:
     * - `openid4vp_presentation`: Request a verifiable presentation from the wallet
     * - `redirect_to_web`: Redirect user to a web page for additional interaction
     *
     * If empty or not set, no interactive authorization is required.
     *
     * @example
     * [
     *   { "type": "openid4vp_presentation", "presentationConfigId": "pid-config" },
     *   { "type": "redirect_to_web", "url": "https://example.com/verify", "label": "Additional Verification" }
     * ]
     */
    @ApiProperty({
        description:
            "List of IAE actions to execute before credential issuance",
        type: "array",
        items: {
            oneOf: [
                { $ref: getSchemaPath(IaeActionOpenid4vpPresentation) },
                { $ref: getSchemaPath(IaeActionRedirectToWeb) },
            ],
        },
        nullable: true,
        required: false,
    })
    @Column("json", { nullable: true })
    iaeActions?: IaeAction[] | null;

    /**
     * For SD-JWT credentials: determines whether to include certificate chain (x5c)
     * or use federation-based trust (iss claim).
     * Default: "x5c" (federation must be explicitly selected)
     */
    @Column("varchar", { nullable: true, default: "x5c" })
    sdJwtTrustFormat?: SdJwtTrustFormat | null;

    @Column("int", { nullable: true })
    lifeTime?: number;

    /**
     * TS11 schema metadata configuration for EUDI Catalogue of Attestations.
     *
     * When present, EUDIPLO can generate a SchemaMeta object per the TS11 spec
     * using the GET /issuer/credentials/:id/schema-metadata endpoint.
     *
     * @experimental The underlying TS11 specification is not yet finalized.
     */
    @ApiPropertyOptional({ type: () => SchemaMetaConfig })
    @Column("json", { nullable: true })
    schemaMeta?: SchemaMetaConfig | null;

    /**
     * Embedded disclosure policy (discriminated union by `policy`).
     * The discriminator metadata is retained for OpenAPI schema generation.
     */
    @ApiProperty({
        oneOf: [
            { $ref: getSchemaPath(AttestationBasedPolicy) },
            { $ref: getSchemaPath(NoneTrustPolicy) },
            { $ref: getSchemaPath(AllowListPolicy) },
            { $ref: getSchemaPath(RootOfTrustPolicy) },
        ],
    })
    @Column("json", { nullable: true })
    embeddedDisclosurePolicy?: EmbeddedDisclosurePolicy | null;
}
