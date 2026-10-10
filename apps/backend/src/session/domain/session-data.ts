import type {
    CredentialOfferObject,
    NotificationEvent,
} from "@openid4vc/openid4vci";
import type { VerificationResult } from "@sd-jwt/sd-jwt-vc";
import type { JWK } from "jose";
import type { WebhookConfiguration } from "../../webhook/domain/webhook-configuration.js";
import type { SessionOutcome } from "./session-outcome.js";
import type { SessionCleanupMode } from "./session-retention.js";
import type { SessionStatus } from "./session-state.js";

export interface SessionAuthorization {
    issuer_state?: string;
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    resource?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    dpop_jkt?: string;
    request_uri?: string;
    auth_session?: string;
    state?: string;
    authorization_details?: string | any[];
}
export interface SessionOfferRequest {
    response_type: "uri" | "dc-api" | "iso-18013-7";
    flow: "authorization_code" | "pre_authorized_code";
    tx_code?: string;
    tx_code_description?: string;
    credentialConfigurationIds: string[];
    authorization_server?: string;
    credentialClaims?: Record<
        string,
        | { type: "inline"; claims: Record<string, any> }
        | { type: "attributeProvider"; attributeProviderId: string }
        | { type: "webhook"; webhook: WebhookConfiguration }
    >;
    webhookEndpointId?: string;
    /** Overrides the issuance configuration's offer lifetime. */
    offerLifetimeSeconds?: number;
    /** Caller reference stored with the session; plaintext, never personal data. */
    reference?: string;
}
interface SessionTransactionData {
    type: string;
    credential_ids: string[];
    [key: string]: any;
}
export interface Notification {
    id: string;
    event?: NotificationEvent;
    /** OID4VCI `event_description` the wallet sent with the latest event. */
    eventDescription?: string;
    credentialConfigurationId: string;
}
/** Read-only tenant projection retained for the existing session detail response. */
interface SessionTenant {
    id: string;
    name: string;
    description?: string | null;
    status: "active" | null;
    sessionConfig?: {
        ttlSeconds?: number;
        cleanupMode?: SessionCleanupMode;
    } | null;
    statusListConfig?: {
        capacity?: number;
        bits?: 1 | 2 | 4 | 8;
        ttl?: number;
        immediateUpdate?: boolean;
        enableAggregation?: boolean;
    } | null;
}

/** Session data shared by issuance and verification, independent of persistence/DTOs. */
export interface SessionData {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt?: Date;
    useDcApi: boolean;
    dcApiProtocol?: string;
    browserOrigin?: string;
    tenantId: string;
    tenant?: SessionTenant;
    /** Caller reference of the offer; plaintext, never personal data. */
    reference?: string | null;
    status: SessionStatus;
    /** SHA-256 hash of the authorization or pre-authorized code. */
    authorization_code?: string;
    authorization_code_expires_at?: Date;
    dpop_jkt?: string;
    client_key_jkt?: string;
    /** SHA-256 hash of the refresh token; the token itself is not stored. */
    refresh_token?: string;
    refresh_token_expires_at?: Date;
    request_uri?: string;
    request_uri_expires_at?: Date;
    auth_queries?: SessionAuthorization;
    offer?: CredentialOfferObject | null;
    offerUrl?: string;
    credentialPayload?: SessionOfferRequest;
    /** Plaintext copy of the offered credential configuration ids. */
    credentialConfigurationIds?: string[] | null;
    webhookEndpointId?: string;
    notifications: Notification[];
    requestId?: string;
    requestUrl?: string;
    requestObject?: string;
    responseEncryptionPrivateJwk?: JWK | null;
    credentials?: VerificationResult[];
    vp_nonce?: string;
    clientId?: string;
    walletNonce?: string;
    responseCode?: string;
    responseUri?: string;
    redirectUri?: string | null;
    parsedWebhook?: WebhookConfiguration;
    transaction_data?: SessionTransactionData[];
    skewSeconds?: number;
    externalIssuer?: string;
    authorizationServerId?: string;
    externalSubject?: string;
    errorReason?: string;
    failureCode?: string;
    outcome?: SessionOutcome | null;
    txCodeFailedAttempts: number;
    consumed: boolean;
    consumedAt?: Date;
}

export type NewSession = Pick<SessionData, "id" | "tenantId"> &
    Partial<Omit<SessionData, "id" | "tenantId" | "tenant">>;
export type SessionUpdate = Partial<
    Omit<SessionData, "id" | "tenantId" | "tenant" | "createdAt" | "updatedAt">
>;

export interface ExternalSessionBinding {
    tenantId: string;
    authorizationServerId: string;
    sessionId: string;
    externalIssuer: string;
    externalSubject: string;
}
