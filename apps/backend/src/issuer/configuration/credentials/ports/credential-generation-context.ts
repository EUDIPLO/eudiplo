import type { SessionData } from "../../../../session/domain/session-data.js";
import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";

/** Resolves the issuer identity used by credential formats. */
export interface IssuerFederationContext {
    entityIdForTenant(tenantId: string): Promise<string | undefined>;
}
export const ISSUER_FEDERATION_CONTEXT = Symbol("ISSUER_FEDERATION_CONTEXT");

/** Legacy session-based claim sources used by direct credential generation. */
export interface SessionCredentialClaims {
    resolve(
        webhook: WebhookConfiguration,
        session: SessionData,
        configurationId: string,
    ): Promise<Record<string, unknown> | undefined>;
}
export const SESSION_CREDENTIAL_CLAIMS = Symbol("SESSION_CREDENTIAL_CLAIMS");
