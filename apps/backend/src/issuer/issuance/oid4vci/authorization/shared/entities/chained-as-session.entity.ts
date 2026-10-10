import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { EncryptedJsonTransformer } from "../../../../../../platform/data-encryption/index.js";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../../domain/chained-as-session.js";

/**
 * Entity for storing Chained AS session state.
 * Tracks the flow from PAR → authorize → upstream callback → token issuance.
 */
@Entity("chained_as_session")
export class ChainedAsSessionEntity implements ChainedAsSession {
    /**
     * The session ID (used as request_uri parameter in PAR response).
     */
    @PrimaryColumn("uuid")
    id!: string;

    /**
     * The tenant ID this session belongs to.
     */
    @Column("varchar")
    tenantId!: string;

    /**
     * Current status of the session.
     */
    @Column({
        type: "varchar",
        default: ChainedAsSessionStatus.PENDING_AUTHORIZE,
    })
    status!: ChainedAsSessionStatus;

    /**
     * The issuer_state that will be included in the issued token.
     * This links the token to the credential offer session.
     */
    @Column("varchar")
    issuerState!: string;

    /**
     * Client ID from the wallet's PAR request.
     */
    @Column("varchar")
    clientId!: string;

    /**
     * Redirect URI from the wallet's PAR request.
     */
    @Column("varchar")
    redirectUri!: string;

    /**
     * PKCE code challenge from the wallet's PAR request.
     */
    @Column("varchar", { nullable: true })
    codeChallenge?: string;

    /**
     * PKCE code challenge method from the wallet's PAR request.
     */
    @Column("varchar", { nullable: true })
    codeChallengeMethod?: string;

    /**
     * State parameter from the wallet's PAR request (returned in redirect).
     */
    @Column("varchar", { nullable: true })
    walletState?: string;

    /**
     * Scope requested by the wallet.
     */
    @Column("varchar", { nullable: true })
    scope?: string;

    /**
     * Authorization details from the wallet request (JSON).
     */
    @Column("json", { nullable: true })
    authorizationDetails?: Record<string, unknown>[];

    /**
     * DPoP JWK thumbprint if DPoP was used in PAR.
     */
    @Column("varchar", { nullable: true })
    dpopJkt?: string;

    /**
     * State parameter we generate for the upstream OIDC request.
     */
    @Column("varchar", { nullable: true })
    upstreamState?: string;

    /**
     * Nonce we send to the upstream OIDC provider.
     */
    @Column("varchar", { nullable: true })
    upstreamNonce?: string;

    /**
     * PKCE verifier we use for the upstream OIDC request.
     */
    @Column("varchar", { nullable: true })
    upstreamCodeVerifier?: string;

    /**
     * Presentation configuration used when this session is handled by a
     * managed OID4VP-backed authorization server.
     */
    @Column("varchar", { nullable: true })
    vpPresentationConfigId?: string;

    /**
     * Response code returned by the verifier callback after a successful
     * OID4VP presentation flow.
     */
    @Column("varchar", { nullable: true })
    vpResponseCode?: string;

    /**
     * ID token claims received from upstream OIDC (for user info).
     * Encrypted at rest - contains personal information. The column stays
     * `json` and holds the ciphertext as a JSON string.
     */
    @Column("json", { nullable: true, transformer: EncryptedJsonTransformer })
    upstreamIdTokenClaims?: Record<string, unknown>;

    /**
     * Access token claims received from upstream OIDC.
     * Encrypted at rest - may contain personal information.
     */
    @Column("json", { nullable: true, transformer: EncryptedJsonTransformer })
    upstreamAccessTokenClaims?: Record<string, unknown>;

    /**
     * SHA-256 hash of the authorization code we issue to the wallet (after
     * upstream callback), see `hashAuthorizationCode`.
     */
    @Column("varchar", { nullable: true })
    authorizationCode?: string;

    /**
     * Expiration time for the authorization code.
     */
    @Column({ nullable: true })
    authorizationCodeExpiresAt?: Date;

    /**
     * The access token issued to the wallet (for later reference).
     */
    @Column("varchar", { nullable: true })
    accessTokenJti?: string;

    /**
     * SHA-256 hash of the refresh token issued to the wallet (if refresh
     * tokens are enabled), see `hashRefreshToken`.
     */
    @Column("varchar", { nullable: true })
    refreshToken?: string;

    /**
     * Expiration time for the refresh token.
     */
    @Column({ nullable: true })
    refreshTokenExpiresAt?: Date;

    /**
     * Timestamp when the session was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * Timestamp when the session was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;

    /**
     * Session expiration time.
     */
    @Column()
    expiresAt!: Date;
}
