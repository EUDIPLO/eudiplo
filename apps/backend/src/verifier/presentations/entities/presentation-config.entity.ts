import {
    ApiExtraModels,
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
    getSchemaPath,
} from "@nestjs/swagger";
import { JWK } from "jose";
import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { WebhookEndpointEntity } from "../../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { MAX_FOLLOWED_TRUSTED_LISTS } from "../../../trust/domain/trusted-list-services.js";
import { RevocationCheckMode } from "../../../trust/types.js";
import { PresentationRegistrationCertificate } from "../dto/registration-certificate.dto.js";

export enum TrustedAuthorityType {
    ETSI_TL = "etsi_tl",
    OPENID_FEDERATION = "openid_federation",
}

const DCQL_CREDENTIAL_FORMATS = ["dc+sd-jwt", "mso_mdoc"] as const;

export class TrustListRef {
    @ApiPropertyOptional({
        enum: ["lote", "trusted-list"],
        default: "lote",
        description:
            "Format of the list. `lote` (default): a List of Trusted Entities (ETSI TS 119 602) as JWT, referenced by `trustListId` or by `url` with `verifierKey` or `verifierX509Der`. `trusted-list`: an ETSI TS 119 612 Trusted List or list of trusted lists as XML, referenced by `url` with `signingCertificates`; its granted qualified services for the issuance of QEAAs are trusted.",
    })
    format?: "lote" | "trusted-list";

    @ApiPropertyOptional({
        type: "string",
        description:
            "Managed local trust-list identifier. When provided, verifier material is resolved server-side from the trust list key chain. Only for `lote`.",
    })
    trustListId?: string;

    @ApiPropertyOptional({
        type: "string",
        description:
            "Trust-list URL: of the LoTE JWT, required for external lists when trustListId is not set, or of the ETSI TS 119 612 Trusted List or list of trusted lists for `trusted-list`.",
    })
    url!: string;

    @ApiPropertyOptional({
        type: "object",
        additionalProperties: true,
        description:
            "JWK used to verify trust-list JWT signatures for external trusted authority values.",
    })
    verifierKey?: JWK;

    @ApiPropertyOptional({
        type: "string",
        description:
            "Base64 DER-encoded X.509 certificate used to verify trust-list JWT signatures for external trusted authority values.",
    })
    verifierX509Der?: string;

    @ApiPropertyOptional({
        type: "array",
        items: { type: "string" },
        description:
            "Only for `trusted-list`, required there: base64 DER certificates one of which must have signed the list. For a list of trusted lists, the signing certificates its operator publishes; the national lists it points to are verified with the certificates it names for them. For a national list, its scheme operator certificates.",
    })
    signingCertificates?: string[];

    @ApiPropertyOptional({
        type: "array",
        items: { type: "string" },
        description: `Only for \`trusted-list\` naming a list of trusted lists: the SchemeTerritory values of the national lists to follow, such as \`DE\`. All when absent. With more than ${MAX_FOLLOWED_TRUSTED_LISTS} lists to follow, none of the lists of the \`etsi_tl\` entry is used.`,
    })
    schemeTerritories?: string[];
}

/**
 * Attached attestations
 */
export class PresentationAttachment {
    format!: string;

    data!: any;

    credential_ids?: string[];
}

export class ClaimsQuery {
    id?: string;

    path!: string[];

    @ApiPropertyOptional({
        type: "array",
        description:
            "Allowed values of the claim. A disclosed value must equal one of them in type and value.",
        items: {
            oneOf: [
                { type: "string" },
                { type: "integer" },
                { type: "boolean" },
            ],
        },
    })
    values?: Array<string | number | boolean>;
}

export class MsoMdocClaimsQuery extends ClaimsQuery {
    @ApiPropertyOptional({
        type: "boolean",
        description:
            "Whether the holder should be allowed to retain the claim in an mso_mdoc response.",
    })
    intent_to_retain?: boolean;
}

export class DcSdJwtCredentialQueryMeta {
    @ApiProperty({
        type: "array",
        items: { type: "string" },
        description: "VCT identifiers accepted for dc+sd-jwt credentials.",
    })
    vct_values!: string[];
}

export class MsoMdocCredentialQueryMeta {
    @ApiProperty({
        type: "string",
        description:
            "Document type identifier accepted for mso_mdoc credentials.",
    })
    doctype_value!: string;
}

// TODO: extend: https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-trusted-authorities-query
abstract class TrustedAuthorityQuery {
    declare type: TrustedAuthorityType;
}

class TrustedAuthorityQueryEtsiTl extends TrustedAuthorityQuery {
    @ApiProperty({
        enum: [TrustedAuthorityType.ETSI_TL],
        default: TrustedAuthorityType.ETSI_TL,
    })
    type: TrustedAuthorityType.ETSI_TL = TrustedAuthorityType.ETSI_TL;

    @ApiProperty({
        type: "array",
        items: {
            $ref: getSchemaPath(TrustListRef),
        },
    })
    values!: TrustListRef[];
}

class TrustedAuthorityQueryOpenIdFederation extends TrustedAuthorityQuery {
    @ApiProperty({
        enum: [TrustedAuthorityType.OPENID_FEDERATION],
        default: TrustedAuthorityType.OPENID_FEDERATION,
    })
    type: TrustedAuthorityType.OPENID_FEDERATION =
        TrustedAuthorityType.OPENID_FEDERATION;

    @ApiProperty({
        type: "array",
        items: { type: "string" },
    })
    values!: string[];
}

type TrustedAuthorityQueryValue =
    | TrustedAuthorityQueryEtsiTl
    | TrustedAuthorityQueryOpenIdFederation;

export class CredentialSetQuery {
    @ApiProperty({
        type: "array",
        items: { type: "array", items: { type: "string" } },
    })
    options!: string[][];

    required?: boolean;
}

//TODO: extend: https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-credential-query
@ApiExtraModels(
    TrustListRef,
    TrustedAuthorityQueryEtsiTl,
    TrustedAuthorityQueryOpenIdFederation,
    DcSdJwtCredentialQueryMeta,
    MsoMdocCredentialQueryMeta,
    MsoMdocClaimsQuery,
)
abstract class CredentialQuery {
    id!: string;

    @ApiProperty({
        enum: DCQL_CREDENTIAL_FORMATS,
        description: "Credential format discriminator.",
    })
    format!: string;

    multiple?: boolean;

    claims?: ClaimsQuery[];

    @ApiPropertyOptional({
        type: "array",
        items: { type: "array", items: { type: "string" } },
        description:
            "Ordered alternative claim combinations for this credential query.",
    })
    claim_sets?: string[][];

    @ApiPropertyOptional({
        type: "array",
        description:
            "Trusted authority constraints (discriminated by type) for this credential query.",
        items: {
            oneOf: [
                { $ref: getSchemaPath(TrustedAuthorityQueryEtsiTl) },
                {
                    $ref: getSchemaPath(TrustedAuthorityQueryOpenIdFederation),
                },
            ],
            discriminator: {
                propertyName: "type",
                mapping: {
                    [TrustedAuthorityType.ETSI_TL]: getSchemaPath(
                        TrustedAuthorityQueryEtsiTl,
                    ),
                    [TrustedAuthorityType.OPENID_FEDERATION]: getSchemaPath(
                        TrustedAuthorityQueryOpenIdFederation,
                    ),
                },
            },
        },
    })
    trusted_authorities?: TrustedAuthorityQueryValue[];
}

class CredentialQueryDcSdJwt extends CredentialQuery {
    @ApiProperty({
        enum: ["dc+sd-jwt"],
        default: "dc+sd-jwt",
    })
    format = "dc+sd-jwt" as const;

    @ApiProperty({
        type: DcSdJwtCredentialQueryMeta,
        description: "dc+sd-jwt schema metadata for the requested credential.",
    })
    meta!: DcSdJwtCredentialQueryMeta;

    declare claims?: ClaimsQuery[];
}

class CredentialQueryMsoMdoc extends CredentialQuery {
    @ApiProperty({
        enum: ["mso_mdoc"],
        default: "mso_mdoc",
    })
    format = "mso_mdoc" as const;

    @ApiProperty({
        type: MsoMdocCredentialQueryMeta,
        description:
            "mso_mdoc document type metadata for the requested credential.",
    })
    meta!: MsoMdocCredentialQueryMeta;

    declare claims?: MsoMdocClaimsQuery[];
}

export type CredentialQueryValue =
    | CredentialQueryDcSdJwt
    | CredentialQueryMsoMdoc;

@ApiExtraModels(CredentialQueryDcSdJwt, CredentialQueryMsoMdoc)
export class DCQL {
    @ApiPropertyOptional({
        type: "array",
        description: "Format-discriminated credential queries.",
        items: {
            oneOf: [
                { $ref: getSchemaPath(CredentialQueryDcSdJwt) },
                { $ref: getSchemaPath(CredentialQueryMsoMdoc) },
            ],
            discriminator: {
                propertyName: "format",
                mapping: {
                    "dc+sd-jwt": getSchemaPath(CredentialQueryDcSdJwt),
                    mso_mdoc: getSchemaPath(CredentialQueryMsoMdoc),
                },
            },
        },
    })
    credentials!: CredentialQueryValue[];

    credential_sets?: CredentialSetQuery[];
}

export class TransactionData {
    type!: string;
    credential_ids!: string[];
    [key: string]: any;
}

/**
 * Entity representing a configuration for a Verifiable Presentation (VP) request.
 */
@Entity()
export class PresentationConfig {
    /**
     * Unique identifier for the VP request.
     */
    @Column("varchar", { primary: true })
    id!: string;

    /**
     * The tenant ID for which the VP request is made.
     */
    @ApiHideProperty()
    @Column("varchar", { primary: true })
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * Description of the presentation configuration.
     */
    @Column("varchar", { nullable: true })
    description?: string | null;

    /**
     * Lifetime how long the presentation request is valid after creation, in seconds.
     */
    @Column("int", { default: 300 })
    lifeTime?: number;

    /**
     * Clock skew tolerance for credential JWT time validation, in seconds.
     */
    @ApiPropertyOptional({
        description:
            "Clock skew tolerance for credential JWT time validation, in seconds.",
        default: 60,
    })
    @Column("int", { default: 60 })
    skewSeconds?: number;

    /**
     * Controls how credential status lists (revocation/suspension) are handled during verification.
     */
    @ApiPropertyOptional({
        description:
            "Status list verification mode for presentations: strict (default), best_effort, or disabled.",
        enum: RevocationCheckMode,
        default: RevocationCheckMode.Strict,
    })
    @Column("varchar", { default: RevocationCheckMode.Strict })
    statusCheckMode?: RevocationCheckMode;

    /**
     * The DCQL query to be used for the VP request.
     */
    @Column("json")
    dcql_query!: DCQL;

    /**
     *
     */
    @Column("json", { nullable: true })
    transaction_data?: TransactionData[];

    /**
     * Registration certificate from a registrar, attached to every request
     * object, with the purpose and privacy policy it is requested with.
     */
    @Column("json", { nullable: true })
    registration_cert?: PresentationRegistrationCertificate | null;

    /**
     * Reference to the webhook endpoint used for notifications.
     * Optional: if set, notifications will be sent to this endpoint.
     */
    @Column("varchar", { nullable: true })
    webhookEndpointId?: string | null;

    @ApiHideProperty()
    @ManyToOne(() => WebhookEndpointEntity, {
        createForeignKeyConstraints: false,
    })
    @JoinColumn([
        { name: "webhookEndpointId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    webhookEndpoint?: WebhookEndpointEntity;

    /**
     * The timestamp when the VP request was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * The timestamp when the VP request was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;

    /**
     * Attestation that should be attached
     */
    @Column("json", { nullable: true })
    attached?: PresentationAttachment[] | null;

    /**
     * Redirect URI to which the user-agent should be redirected after the presentation is completed.
     * You can use the `{sessionId}` placeholder in the URI, which will be replaced with the actual session ID.
     * @example "https://example.com/callback?session={sessionId}"
     */
    @Column("varchar", { nullable: true })
    redirectUri?: string | null;

    /**
     * Optional ID of the access certificate to use for signing the presentation request.
     * If not provided, the default access certificate for the tenant will be used.
     *
     * Note: This is intentionally NOT a TypeORM relationship because CertEntity uses
     * a composite primary key (id + tenantId), and SQLite cannot create foreign keys
     * that reference only part of a composite primary key. The relationship is handled
     * at the application level in the service layer.
     */
    @Column("varchar", { nullable: true })
    accessKeyChainId?: string | null;

    /**
     * Origins of the web pages allowed to request this presentation over the
     * Digital Credentials API. When set, `dc-api` and `iso-18013-7` offers
     * are bound to one of them; unset, any `expected_origin` is accepted.
     * `uri` offers ignore them.
     * @example ["https://shop.example"]
     */
    @Column("json", { nullable: true })
    allowedOrigins?: string[] | null;

    /**
     * Enable reader authentication for the ISO 18013-7 Annex C (DC API) flow.
     *
     * When `true`, the DeviceRequest embeds a detached `readerAuth` COSE_Sign1
     * signed with the tenant's Access key chain (selected by
     * {@link accessKeyChainId}), letting the wallet cryptographically
     * authenticate the verifier — the mDOC equivalent of the signed request
     * object used in the OID4VP flow. Defaults to disabled (null/false).
     *
     * Only affects `response_type: "iso-18013-7"` offers.
     */
    @Column("boolean", { nullable: true })
    readerAuth?: boolean | null;
}
