import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";

/**
 * Entity for tracking deferred credential issuance transactions.
 *
 * According to OID4VCI Section 9, when the credential is not immediately available,
 * the Credential Issuer can return a `transaction_id` for the wallet to poll later.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-deferred-credential-endpoin
 */
@Entity()
export class DeferredTransactionEntity {
    /**
     * Unique identifier for the deferred transaction.
     * This is the `transaction_id` returned to the wallet.
     */
    @PrimaryColumn("uuid")
    transactionId!: string;

    /**
     * Tenant ID for multi-tenancy support.
     */
    @Column("varchar")
    tenantId!: string;

    /**
     * The tenant that owns this transaction.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * Session ID associated with this deferred transaction.
     */
    @Column("uuid")
    sessionId!: string;

    /**
     * The credential configuration ID being requested.
     */
    @Column("varchar")
    credentialConfigurationId!: string;

    /**
     * Opaque HMAC fingerprint of the access token that authorized this
     * transaction. Preserves active-credential batch grouping when deferred
     * issuance is completed after the original request has ended.
     */
    @Column("varchar", { nullable: true })
    issuanceSetId?: string | null;

    /**
     * The holder's public key (CNF) for key binding.
     * Stored as JSON.
     */
    @Column("json")
    holderCnf!: Record<string, unknown>;

    /**
     * Current status of the deferred transaction.
     */
    @Column({
        type: "varchar",
        default: DeferredTransactionStatus.Pending,
    })
    status!: DeferredTransactionStatus;

    /**
     * The issued credential, populated when status becomes Ready.
     */
    @Column("text", { nullable: true })
    credential?: string | null;

    /**
     * Recommended polling interval in seconds.
     * Returned to the wallet as `interval` in the deferred response.
     */
    @Column("int", { default: 5 })
    interval!: number;

    /**
     * Error message if the transaction failed.
     */
    @Column("text", { nullable: true })
    errorMessage?: string | null;

    /**
     * The timestamp when the deferred transaction was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * The timestamp when the deferred transaction was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;

    /**
     * The timestamp when the transaction expires.
     * After this time, the transaction_id is no longer valid.
     */
    @Column()
    expiresAt!: Date;
}
