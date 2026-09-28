import type { AuthorizationIdentity } from "../../../configuration/credentials/domain/authorization-identity.js";

interface CredentialTokenIssuers {
    localIssuer: string;
    chainedIssuer: string;
    hasChainedAuthorizationServer: boolean;
    managedAuthorizationServerIssuers: ReadonlySet<string>;
}
interface ExternalCredentialAuthorizationServer {
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
        tenantId: string,
        issuerState: string,
    ): Promise<AuthorizationIdentity | undefined>;
}
export const CREDENTIAL_AUTHORIZATION_SOURCES = Symbol(
    "CREDENTIAL_AUTHORIZATION_SOURCES",
);
