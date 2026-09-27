import { ApiProperty } from "@nestjs/swagger";
import {
    CredentialOfferObject,
    NotificationEvent,
} from "@openid4vc/openid4vci";
import { VerificationResult } from "@sd-jwt/sd-jwt-vc";
import { JWK } from "jose";
import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { AuthorizeQueries } from "../../issuer/issuance/oid4vci/authorization/authorize/dto/authorize-request.dto.js";
import { OfferRequestDto } from "../../issuer/issuance/oid4vci/dto/offer-request.dto.js";
import { EncryptedJsonTransformer } from "../../platform/data-encryption/index.js";
import { TransactionData } from "../../verifier/presentations/entities/presentation-config.entity.js";
import { WebhookConfig } from "../../webhook/webhook.dto.js";
import { SessionOutcome } from "./session-outcome.js";

export enum SessionStatus {
    Active = "active",
    Fetched = "fetched",
    Completed = "completed",
    Expired = "expired",
    Failed = "failed",
}

/**
 * Represents a session entity for managing user sessions in the application.
 */
export type Notification = {
    /**
     * Unique identifier for the notification.
     */
    id: string;
    /**
     * The type of notification.
     */
    event?: NotificationEvent;

    /**
     * The credential ID associated with the notification.
     */
    credentialConfigurationId: string;
};

/**
 * Entity representing a user session in the application.
 * It includes various properties such as credentials, authorization code,
 * request URI, authorization queries, and more.
 */
@Entity()
export class Session {
    /**
     * Unique identifier for the session.
     */
    @PrimaryColumn("uuid")
    id!: string;

    /**
     * The timestamp when the request was created.
     */
    @CreateDateColumn()
    createdAt!: Date;

    /**
     * The timestamp when the request was last updated.
     */
    @UpdateDateColumn()
    updatedAt!: Date;

    /**
     * The timestamp when the request is set to expire.
     */
    @Column("date", { nullable: true })
    expiresAt?: Date;

    /**
     * Flag indicating whether to use the DC API for the presentation request.
     */
    @Column("boolean", { nullable: true })
    useDcApi!: boolean;

    /**
     * DC API sub-protocol: "oid4vp" (OpenID4VP via DC API) or "iso-18013-7" (org.iso.mdoc).
     * Null/undefined means the standard OID4VP flow (useDcApi=false).
     */
    @Column("varchar", { nullable: true })
    dcApiProtocol?: string;

    /**
     * Browser page origin recorded at offer time for BrowserHandover session transcript.
     * Used exclusively by the ISO 18013-7 Annex C flow.
     */
    @Column("varchar", { nullable: true })
    browserOrigin?: string;

    /**
     * Tenant ID for multi-tenancy support.
     */
    @Column("varchar")
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, {
        cascade: true,
        onDelete: "CASCADE",
        eager: true,
    })
    tenant!: TenantEntity;

    /**
     * Status of the session.
     */
    @ApiProperty({ enum: SessionStatus })
    @Column("varchar", { nullable: true, default: "active" })
    status!: SessionStatus;

    // issuance specific fields
    /**
     * Authorization code for the session.
     */
    @Column("varchar", { nullable: true })
    authorization_code?: string;
    /**
     * Expiration timestamp of the authorization code issued by the authorization endpoint.
     * Not set for pre-authorized codes.
     */
    @Column({ nullable: true })
    authorization_code_expires_at?: Date;
    /**
     * JWK thumbprint of the DPoP key the session's tokens are bound to.
     * Set from the PAR request (DPoP header or `dpop_jkt`) or at token issuance.
     */
    @Column("varchar", { nullable: true })
    dpop_jkt?: string;
    /**
     * JWK thumbprint of the client instance key (client attestation `cnf`)
     * the refresh token is bound to.
     */
    @Column("varchar", { nullable: true })
    client_key_jkt?: string;
    /**
     * Refresh token for the session - used to obtain a new access token.
     */
    @Column("varchar", { nullable: true })
    refresh_token?: string;
    /**
     * Expiration timestamp for the refresh token.
     * Used to validate refresh_token grant requests.
     */
    @Column({ nullable: true })
    refresh_token_expires_at?: Date;
    /**
     * Request URI from the authorization request.
     */
    @Column("varchar", { nullable: true })
    request_uri?: string;
    /**
     * Expiration timestamp of the PAR request_uri. Set to the time of use once
     * the request_uri was redeemed, making it single-use.
     */
    @Column({ nullable: true })
    request_uri_expires_at?: Date;
    /**
     * Authorization queries associated with the session.
     * Encrypted at rest.
     */
    @Column("text", { nullable: true, transformer: EncryptedJsonTransformer })
    auth_queries?: AuthorizeQueries;

    /**
     * Credential offer object containing details about the credential offer or presentation request.
     * Encrypted at rest.
     */
    @Column("text", { nullable: true, transformer: EncryptedJsonTransformer })
    offer?: CredentialOfferObject | null;

    /**
     * Offer URL for the credential offer.
     */
    @Column("varchar", { nullable: true })
    offerUrl?: string;

    /**
     * Credential payload containing the offer request details.
     * Encrypted at rest - may contain sensitive claim data.
     */
    @Column("text", { nullable: true, transformer: EncryptedJsonTransformer })
    credentialPayload?: OfferRequestDto;
    /**
     * ID of the webhook endpoint to notify about issuance status.
     */
    @Column("varchar", { nullable: true })
    webhookEndpointId?: string;
    /**
     * Notifications associated with the session.
     */
    @Column("json", { default: JSON.stringify([]) })
    notifications!: Notification[];

    // presentation specific fields

    /**
     * The ID of the presentation configuration associated with the session.
     */
    @Column("varchar", { nullable: true })
    requestId?: string;

    /**
     * The URL of the presentation auth request.
     */
    @Column("varchar", { nullable: true })
    requestUrl?: string;

    /**
     * Signed presentation auth request.
     */
    @Column("varchar", { nullable: true })
    requestObject?: string;

    /**
     * Per-authorization-request private encryption key used to decrypt
     * wallet responses. Encrypted at rest.
     */
    @Column("text", { nullable: true, transformer: EncryptedJsonTransformer })
    responseEncryptionPrivateJwk?: JWK | null;

    /**
     * Verified credentials from the presentation process.
     * Encrypted at rest - contains personal information.
     */
    @Column("text", { nullable: true, transformer: EncryptedJsonTransformer })
    credentials?: VerificationResult[];

    /**
     * Nonce from the Verifiable Presentation request.
     */
    @Column("varchar", { nullable: true })
    vp_nonce?: string;

    /**
     * Client ID used in the OID4VP authorization request.
     */
    @Column("varchar", { nullable: true })
    clientId?: string;

    /**
     * Cryptographic random nonce used in wallet-facing URLs (response_uri, request_uri, state).
     * Per OID4VP spec Section 13.3, this separates the wallet-facing identifier (request-id)
     * from the frontend-facing session ID (transaction-id) to prevent session fixation.
     */
    @Column("varchar", { nullable: true })
    walletNonce?: string;

    /**
     * Cryptographic random code generated after successful VP Token processing.
     * Per OID4VP spec Section 13.3, included in redirect_uri so only the legitimate
     * frontend (which receives the redirect) can confirm the session completed.
     */
    @Column("varchar", { nullable: true })
    responseCode?: string;

    /**
     * Response URI used in the OID4VP authorization request.
     */
    @Column("varchar", { nullable: true })
    responseUri?: string;

    /**
     * Redirect URI to which the user-agent should be redirected after the presentation is completed.
     */
    @Column("varchar", { nullable: true })
    redirectUri?: string | null;

    /**
     * Where to send the claims webhook response.
     */
    @Column("json", { nullable: true })
    parsedWebhook?: WebhookConfig;

    /**
     * Transaction data to include in the OID4VP authorization request.
     * Can be overridden per-request from the presentation configuration.
     */
    @Column("json", { nullable: true })
    transaction_data?: TransactionData[];

    /**
     * Per-session clock skew tolerance for presentation credential JWT time validation.
     */
    @Column("int", { nullable: true })
    skewSeconds?: number;

    // External authorization server fields (for wallet-initiated flows with external AS like Keycloak)

    /**
     * The issuer (iss) of the external authorization server token.
     * Set when a wallet presents a token from an external AS.
     */
    @Column("varchar", { nullable: true })
    externalIssuer?: string;

    /**
     * Identifier of the authorization server selected when this issuance session
     * was created. Required for deterministic mapping of external AS access
     * tokens back to the correct issuance session.
     */
    @Column("varchar", { nullable: true })
    authorizationServerId?: string;

    /**
     * The subject (sub) from the external authorization server token.
     * Used to identify the user at the external AS.
     */
    @Column("varchar", { nullable: true })
    externalSubject?: string;

    /**
     * Error reason if the session failed.
     * Stores the error message when status is 'failed'.
     */
    @Column("text", { nullable: true })
    errorReason?: string;

    /**
     * Machine-readable failure code when status is 'failed' (e.g.
     * `trust_chain_not_trusted`). Stable across credential and trust-list
     * formats; consumers branch on this rather than parsing {@link errorReason}.
     */
    @Column("varchar", { nullable: true })
    failureCode?: string;

    /**
     * Structured verification outcome (success or failure, provenance and
     * diagnostics, per credential). Additive to {@link status} /
     * {@link errorReason}; verbose detail stays in the session log only.
     */
    @Column("json", { nullable: true })
    outcome?: SessionOutcome | null;

    /**
     * Number of failed tx_code (transaction code) validation attempts.
     * Used to enforce brute-force protection in the pre-authorized code flow.
     * Reset implicitly when the session is consumed successfully.
     */
    @Column("int", { default: 0 })
    txCodeFailedAttempts!: number;

    /**
     * Flag indicating whether the session offer has been consumed.
     * Prevents replay attacks by ensuring each offer can only be used once.
     * For OID4VCI: set after successful token exchange.
     * For OID4VP: set after successful response validation.
     */
    @Column("boolean", { default: false })
    consumed!: boolean;

    /**
     * Timestamp of the first consumption event for the session offer.
     * For OID4VCI this can be URI resolution or later flow completion.
     * Null if no consumption event has happened yet.
     */
    @Column({ nullable: true })
    consumedAt?: Date;
}
