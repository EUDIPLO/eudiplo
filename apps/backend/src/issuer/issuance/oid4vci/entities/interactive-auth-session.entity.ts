import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import { EncryptedStringTransformer } from "../../../../platform/data-encryption/index.js";
import {
    type InteractiveAuthSession,
    InteractiveAuthSessionStatus,
} from "../authorization/domain/interactive-auth-session.js";

/**
 * Entity for tracking interactive authorization sessions.
 *
 * The Interactive Authorization Endpoint (IAE) enables credential issuance
 * with additional interaction steps, such as verifiable presentation requests.
 * This entity stores the session state between the initial request and follow-up.
 */
@Entity("interactive_auth_session")
export class InteractiveAuthSessionEntity implements InteractiveAuthSession {
    /**
     * Auto-generated primary key.
     */
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    /**
     * The auth session identifier returned to the client.
     * Used to correlate follow-up requests.
     */
    @Column("uuid")
    @Index()
    authSession!: string;

    /**
     * Tenant ID for multi-tenancy support.
     */
    @Column("varchar")
    @Index()
    tenantId!: string;

    /**
     * The tenant that owns this session.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * The client identifier from the initial request.
     */
    @Column("varchar")
    clientId!: string;

    /**
     * Redirect URI from the initial request.
     */
    @Column("varchar", { nullable: true })
    redirectUri?: string;

    /**
     * OAuth scope from the initial request.
     */
    @Column("varchar", { nullable: true })
    scope?: string;

    /**
     * PKCE code challenge for redirect_to_web flow.
     */
    @Column("varchar", { nullable: true })
    codeChallenge?: string;

    /**
     * PKCE code challenge method (e.g., 'S256').
     */
    @Column("varchar", { nullable: true })
    codeChallengeMethod?: string;

    /**
     * Issuer state from credential offer, if provided.
     * Links this IAE session to a credential offer session.
     */
    @Column("varchar", { nullable: true })
    issuerState?: string;

    /**
     * Client state parameter.
     */
    @Column("varchar", { nullable: true })
    state?: string;

    /**
     * Authorization details as JSON string.
     * Encrypted at rest.
     */
    @Column("text", { nullable: true, transformer: EncryptedStringTransformer })
    authorizationDetails?: string;

    /**
     * Comma-separated list of supported interaction types.
     */
    @Column("varchar")
    interactionTypesSupported!: string;

    /**
     * DPoP JWK as JSON string, if provided.
     */
    @Column("text", { nullable: true })
    dpopJwk?: string;

    /**
     * Current status of the session.
     */
    @Column({
        type: "varchar",
        default: InteractiveAuthSessionStatus.Pending,
    })
    status!: string;

    /**
     * Request URI for PAR-based redirect_to_web flow.
     */
    @Column("varchar", { nullable: true })
    requestUri?: string;

    /**
     * PAR request expiration time.
     */
    @Column({ nullable: true })
    parExpiresAt?: Date;

    /**
     * OpenID4VP presentation data as JSON string.
     * Encrypted at rest - contains personal information.
     */
    @Column("text", { nullable: true, transformer: EncryptedStringTransformer })
    presentationData?: string;

    /**
     * IAE actions configuration as JSON string.
     * Stores the list of actions to execute for this session.
     */
    @Column("text", { nullable: true })
    iaeActions?: string;

    /**
     * Current step index in the IAE actions sequence (0-based).
     * Incremented after each step completes successfully.
     */
    @Column("int", { default: 0 })
    currentStepIndex!: number;

    /**
     * Completed steps data as JSON string.
     * Contains results from each completed step (presentations, web auth results).
     * Encrypted at rest - may contain personal information.
     */
    @Column("text", { nullable: true, transformer: EncryptedStringTransformer })
    completedStepsData?: string;

    /**
     * SHA-256 hash of the authorization code once issued.
     */
    @Column("varchar", { nullable: true })
    authorizationCode?: string;

    /**
     * Session expiration time.
     */
    @Column()
    expiresAt!: Date;

    /**
     * Timestamp when the entity was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * Timestamp when the entity was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;
}
