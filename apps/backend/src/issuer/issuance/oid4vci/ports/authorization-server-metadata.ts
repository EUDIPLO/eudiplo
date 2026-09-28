import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import type { FederationTrustSource } from "../../../../trust/types.js";
import type { HostedAuthorizationServer } from "../domain/authorization-server-endpoint.js";

/**
 * Metadata of an external authorization server.
 *
 * Implementations enforce the tenant's OpenID Federation trust policy before
 * fetching and may cache results. They throw `AuthorizationServerNotTrusted`
 * or `AuthorizationServerMetadataUnavailable`.
 */
export interface ExternalAuthorizationServerMetadataResolver {
    resolve(
        issuer: string,
        federation?: FederationTrustSource,
    ): Promise<AuthorizationServerMetadata>;
}

export const EXTERNAL_AUTHORIZATION_SERVER_METADATA_RESOLVER = Symbol(
    "EXTERNAL_AUTHORIZATION_SERVER_METADATA_RESOLVER",
);

/** Metadata of an authorization server hosted by EUDIPLO for the tenant. */
export interface HostedAuthorizationServerMetadata {
    get(
        tenantId: string,
        server: HostedAuthorizationServer,
    ): Promise<AuthorizationServerMetadata>;
}

export const HOSTED_AUTHORIZATION_SERVER_METADATA = Symbol(
    "HOSTED_AUTHORIZATION_SERVER_METADATA",
);
