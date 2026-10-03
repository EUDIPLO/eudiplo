import {
    ApiExtraModels,
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
    getSchemaPath,
} from "@nestjs/swagger";
import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import {
    AuthenticationMethodAuth,
    AuthenticationMethodNone,
    AuthenticationMethodPresentation,
} from "../dto/authentication-config.dto.js";
import {
    BuiltInAuthorizationServerConfig,
    ChainedAuthorizationServerConfig,
    ExternalAuthorizationServerConfig,
    ManagedAuthorizationServerConfig,
    Oid4VpAuthorizationServerConfig,
} from "../dto/authorization-server-config.dto.js";
import { DisplayInfo } from "../dto/display.dto.js";
import { FederationConfig } from "../dto/federation-config.dto.js";
import {
    IssuerRegistrationCertificateCache,
    IssuerRegistrationCertificateConfig,
} from "../dto/issuer-registration-certificate.dto.js";

class WalletProviderTrustListRefDto {
    @ApiPropertyOptional({
        description:
            "Managed trust-list ID in this tenant; resolves URL and verifier automatically.",
    })
    trustListId?: string;

    @ApiProperty({ format: "uri" })
    url!: string;

    @ApiPropertyOptional({
        type: "object",
        additionalProperties: true,
        description: "JWK used to verify the trust-list JWT signature.",
    })
    verifierKey?: Record<string, unknown>;

    @ApiPropertyOptional({
        type: "string",
        description:
            "Base64 DER-encoded X.509 certificate used to verify the trust-list JWT signature.",
    })
    verifierX509Der?: string;
}

/**
 * Entity to manage issuance configs
 */
@ApiExtraModels(
    AuthenticationMethodNone,
    AuthenticationMethodAuth,
    AuthenticationMethodPresentation,
    ManagedAuthorizationServerConfig,
    ExternalAuthorizationServerConfig,
    Oid4VpAuthorizationServerConfig,
    ChainedAuthorizationServerConfig,
    BuiltInAuthorizationServerConfig,
)
@Entity()
export class IssuanceConfig {
    /**
     * Tenant ID for the issuance configuration.
     */
    @ApiHideProperty()
    @PrimaryColumn()
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * Value to determine the amount of credentials that are issued in a batch.
     * Default is 1.
     */
    @Column("int", { default: 1 })
    batchSize?: number;

    /**
     * Indicates whether DPoP is required for the issuance process. Default value is true.
     */
    @Column("boolean", { default: true })
    dPopRequired?: boolean;

    /**
     * Default wallet attestation requirement for managed authorization servers.
     * When enabled, wallets must provide OAuth-Client-Attestation headers.
     * Default value is false.
     */
    @Column("boolean", { default: false })
    walletAttestationRequired?: boolean;

    /**
     * Shared wallet provider trust lists for key attestations at the credential endpoint
     * and default wallet-attestation trust at managed authorization servers.
     * Each entry MUST include either `verifierKey` or `verifierX509Der`.
     */
    @ApiPropertyOptional({
        type: [WalletProviderTrustListRefDto],
    })
    @Column({ type: "json", nullable: true })
    walletProviderTrustLists?: WalletProviderTrustListRefDto[];

    /**
     * Optional key ID to use for signing access tokens.
     * Must reference an existing key managed by the key service.
     * If not set, the first available signing key for the tenant is used.
     */
    @ApiPropertyOptional({
        description:
            "Key ID for signing access tokens. If unset, the default signing key is used.",
    })
    @Column({ type: "varchar", nullable: true })
    signingKeyId?: string;

    /**
     * Dedicated managed authorization servers hosted by this issuer.
     * Each entry creates a distinct AS endpoint and can be bound to a different
     * presentation configuration.
     */
    @ApiProperty({
        description:
            "Dedicated managed authorization servers hosted by this issuer. At least one entry is required.",
        type: "array",
        items: {
            oneOf: [
                { $ref: getSchemaPath(ExternalAuthorizationServerConfig) },
                { $ref: getSchemaPath(Oid4VpAuthorizationServerConfig) },
                { $ref: getSchemaPath(ChainedAuthorizationServerConfig) },
                { $ref: getSchemaPath(BuiltInAuthorizationServerConfig) },
            ],
            discriminator: {
                propertyName: "type",
                mapping: {
                    external: getSchemaPath(ExternalAuthorizationServerConfig),
                    oid4vp: getSchemaPath(Oid4VpAuthorizationServerConfig),
                    chained: getSchemaPath(ChainedAuthorizationServerConfig),
                    "built-in": getSchemaPath(BuiltInAuthorizationServerConfig),
                },
            },
        },
    })
    @Column({ type: "json", nullable: true })
    authorizationServers!: ManagedAuthorizationServerConfig[];

    /**
     * Optional OpenID Federation configuration used for trust evaluation.
     * When omitted, trust checks rely on existing LoTE trust-list behavior.
     */
    @ApiPropertyOptional({ type: () => FederationConfig })
    @Column({ type: "json", nullable: true })
    federation?: FederationConfig | null;

    /**
     * Optional registration certificate configuration for issuer metadata (`issuer_info`).
     * Supports importing an existing JWT or generating one via registrar.
     */
    @ApiPropertyOptional({ type: () => IssuerRegistrationCertificateConfig })
    @Column({ type: "json", nullable: true })
    registrationCertificate?: IssuerRegistrationCertificateConfig | null;

    /**
     * Server-managed cache for generated issuer registration certificates.
     */
    @ApiPropertyOptional({
        type: () => IssuerRegistrationCertificateCache,
        readOnly: true,
    })
    @Column({ type: "json", nullable: true })
    registrationCertificateCache?: IssuerRegistrationCertificateCache | null;

    @Column("json", { nullable: true })
    display!: DisplayInfo[];

    /**
     * Whether the OID4VCI notification endpoint is advertised and accepts
     * requests for this issuance configuration.
     * Default: true
     */
    @ApiPropertyOptional({
        description:
            "Whether the OID4VCI notification endpoint is exposed for this issuance configuration.",
        default: true,
    })
    @Column("boolean", { default: true })
    notificationEndpointEnabled?: boolean;

    /**
     * Whether to advertise support for credential response encryption in the
     * credential issuer metadata (`credential_response_encryption`). When
     * enabled, wallets MAY request encrypted credential responses. Some
     * wallets reject issuer metadata that advertises unsupported algorithms,
     * so this defaults to false.
     * Default: false
     */
    @ApiPropertyOptional({
        description:
            "Whether `credential_response_encryption` should be advertised in the credential issuer metadata.",
        default: false,
    })
    @Column("boolean", { default: false })
    credentialResponseEncryption?: boolean;

    /**
     * Whether to advertise `credential_request_encryption` in the credential issuer metadata.
     * When enabled, the issuer publishes its encryption public key so wallets can
     * send encrypted credential requests. Set `encryption_required` to enforce it.
     * Default: false
     */
    @ApiPropertyOptional({
        description:
            "Whether `credential_request_encryption` should be advertised in the credential issuer metadata.",
        default: false,
    })
    @Column("boolean", { default: false })
    credentialRequestEncryption?: boolean;

    /**
     * Maximum number of failed tx_code (transaction code) validation attempts
     * before the pre-authorized code is invalidated. Protects against brute-force
     * attacks on the OID4VCI pre-authorized code flow.
     * Default: 5. Set to null to disable the limit (not recommended).
     */
    @ApiPropertyOptional({
        description:
            "Maximum failed tx_code attempts before the pre-authorized code is invalidated. Defaults to 5.",
        default: 5,
        nullable: true,
    })
    @Column("int", { nullable: true })
    txCodeMaxAttempts?: number;

    /**
     * Default lifetime of credential offers in seconds. After it, the offer
     * (credential offer URI, pre-authorized code, authorization flow) can no
     * longer be redeemed; tokens already issued keep their own lifetimes.
     * An offer request can override it. Unset: offers do not expire.
     */
    @ApiPropertyOptional({
        description:
            "Default lifetime of credential offers in seconds. Can be overridden per offer request. Unset: offers do not expire.",
        nullable: true,
        minimum: 1,
    })
    @Column("int", { nullable: true })
    offerLifetimeSeconds?: number | null;

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
}
