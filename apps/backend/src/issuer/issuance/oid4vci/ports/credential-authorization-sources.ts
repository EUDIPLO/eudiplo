import type { AuthorizationIdentity } from "../../../configuration/credentials/domain/authorization-identity.js";

export interface CredentialTokenIssuers {
    localIssuer: string;
    chainedIssuer: string;
    hasChainedAuthorizationServer: boolean;
    managedAuthorizationServerIssuers: ReadonlySet<string>;
}
export interface ExternalCredentialAuthorizationServer {
    id: string;
    bindingClaim?: string;
}
export interface CredentialAuthorizationSources {
    tokenIssuers(tenantId: string): Promise<CredentialTokenIssuers>;
    externalServer(
        tenantId: string,
        issuer: string,
    ): Promise<{
        advertised: boolean;
        configuration?: ExternalCredentialAuthorizationServer;
    }>;
    upstreamIdentity(
        issuerState: string,
    ): Promise<AuthorizationIdentity | undefined>;
}
export const CREDENTIAL_AUTHORIZATION_SOURCES = Symbol(
    "CREDENTIAL_AUTHORIZATION_SOURCES",
);
