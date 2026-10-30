import { JWK } from "jose";
import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { EncryptedJsonTransformer } from "../../../platform/data-encryption/index.js";
import { KeyUsageType } from "../types/key-usage-type.js";

/**
 * Key usage types for cryptographic operations.
 */
export enum KeyUsage {
    Sign = "sign",
    Encrypt = "encrypt",
}

/**
 * KeyChainEntity represents a complete signing key setup.
 *
 * This unified model encapsulates:
 * - An optional root CA key (for internal certificate chains)
 * - An active signing key with its certificate
 * - A previous key (for grace period after rotation)
 * - Rotation policy
 *
 * External consumers (e.g., issuance config) reference this entity by its `id`.
 * The embedded root CA (if present) signs the signing key's certificates.
 * This eliminates orphaned keys and simplifies lifecycle management.
 */
@Entity("key_chain")
export class KeyChainEntity {
    /**
     * Unique identifier for the key chain.
     * This is the ID referenced by other entities (e.g., a credential configuration's keyChainId).
     */
    @Column("varchar", { primary: true })
    id!: string;

    /**
     * Tenant ID for the key chain.
     */
    @Column("varchar", { primary: true })
    tenantId!: string;

    /**
     * The tenant that owns this key chain.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * Human-readable description of the key chain.
     */
    @Column("varchar", { nullable: true })
    description?: string;

    /**
     * The purpose/role of this key chain in the system.
     */
    @Column("varchar")
    usageType!: KeyUsageType;

    /**
     * The usage type of the keys (sign or encrypt).
     */
    @Column("varchar", { default: "sign" })
    usage!: KeyUsage;

    /**
     * The KMS provider used for this key chain.
     * References a configured KMS provider name.
     */
    @Column("varchar", { default: "db" })
    kmsProvider!: string;

    /**
     * External key identifier for cloud KMS providers.
     * This field stores the provider-specific key reference for the active signing key.
     */
    @Column("varchar", { nullable: true })
    externalKeyId?: string;

    /**
     * External key identifier for cloud KMS providers for the root CA key.
     * Used when rotating internal-chain key chains backed by external KMS.
     */
    @Column("varchar", { nullable: true })
    rootExternalKeyId?: string;

    // ─────────────────────────────────────────────────────────
    // ROOT CA (optional - for internal certificate chains)
    // ─────────────────────────────────────────────────────────

    /**
     * Root CA key material (JWK).
     * Encrypted at rest using AES-256-GCM.
     * Null for standalone keys that use self-signed or externally issued certificates.
     */
    @Column("text", {
        transformer: EncryptedJsonTransformer,
        nullable: true,
    })
    rootJwk?: JWK;

    /**
     * Root CA certificate in PEM format.
     * Self-signed certificate for the root CA key.
     */
    @Column("text", { nullable: true })
    rootCertificate?: string;

    // ─────────────────────────────────────────────────────────
    // ACTIVE SIGNING KEY
    // ─────────────────────────────────────────────────────────

    /**
     * Active signing key material (JWK).
     * Encrypted at rest using AES-256-GCM.
     * This is the key used for signing operations.
     */
    @Column("text", { transformer: EncryptedJsonTransformer })
    activeJwk!: JWK;

    /**
     * Certificate for the active signing key in PEM format.
     * Either CA-signed (if rootKey exists) or self-signed.
     */
    @Column("text")
    activeCertificate!: string;

    // ─────────────────────────────────────────────────────────
    // ROTATION
    // ─────────────────────────────────────────────────────────

    /**
     * Whether automatic key rotation is enabled.
     */
    @Column("boolean", { default: false })
    rotationEnabled!: boolean;

    /**
     * Rotation interval in days. Key material will be rotated after this many days.
     */
    @Column("int", { nullable: true })
    rotationIntervalDays?: number;

    /**
     * Certificate validity in days when generating new certificates.
     */
    @Column("int", { nullable: true })
    certValidityDays?: number;

    /**
     * Timestamp of when the key was last rotated.
     */
    @Column({ nullable: true })
    lastRotatedAt?: Date;

    // ─────────────────────────────────────────────────────────
    // PREVIOUS KEY (grace period after rotation)
    // ─────────────────────────────────────────────────────────

    /**
     * Previous signing key material (JWK).
     * Encrypted at rest using AES-256-GCM.
     * Kept for a grace period after rotation to allow validation of existing signatures.
     */
    @Column("text", {
        transformer: EncryptedJsonTransformer,
        nullable: true,
    })
    previousJwk?: JWK;

    /**
     * Certificate for the previous signing key in PEM format.
     */
    @Column("text", { nullable: true })
    previousCertificate?: string;

    /**
     * Expiry date for the previous key.
     * After this date, the previous key should be deleted.
     */
    @Column({ nullable: true })
    previousKeyExpiry?: Date;

    // ─────────────────────────────────────────────────────────
    // TIMESTAMPS
    // ─────────────────────────────────────────────────────────

    /**
     * The timestamp when the key chain was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * The timestamp when the key chain was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;

    // ─────────────────────────────────────────────────────────
    // HELPER METHODS
    // ─────────────────────────────────────────────────────────

    /**
     * Returns true if this key chain has an internal CA (root key).
     */
    hasInternalCa(): boolean {
        return this.rootJwk != null && this.rootCertificate != null;
    }

    /**
     * Returns all public keys (current and previous) for JWKS.
     */
    getPublicKeys(): JWK[] {
        const keys: JWK[] = [];
        if (this.activeJwk) {
            keys.push(this.getPublicJwk(this.activeJwk));
        }
        if (this.previousJwk) {
            keys.push(this.getPublicJwk(this.previousJwk));
        }
        return keys;
    }

    private getPublicJwk(jwk: JWK): JWK {
        // Remove private key components
        const { d, p, q, dp, dq, qi, k, ...publicJwk } = jwk as Record<
            string,
            unknown
        >;
        return publicJwk as JWK;
    }
}
