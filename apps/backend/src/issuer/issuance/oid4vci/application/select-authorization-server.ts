import type { IssuanceConfigRepository } from "../../../configuration/issuance/ports/issuance-config.repository.js";
import {
    authorizationServerIssuer,
    toAuthorizationServerEndpoint,
} from "../domain/authorization-server-endpoint.js";
import { AuthorizationServerNotConfigured } from "../domain/authorization-server-errors.js";

export interface AuthorizationServerSelection {
    /** Issuer identifier put into the credential offer grant. */
    issuer: string;
    /** Value stored as the session's `authorizationServerId`. */
    sessionServerId?: string;
}

/**
 * Chooses the authorization server a credential offer points to: the
 * explicitly requested one, or otherwise the first enabled server that can be
 * advertised.
 */
export class SelectAuthorizationServer {
    constructor(
        private readonly issuanceConfigs: Pick<
            IssuanceConfigRepository,
            "getForTenant"
        >,
        private readonly publicUrl: string,
    ) {}

    async execute(
        tenantId: string,
        requested?: string,
    ): Promise<AuthorizationServerSelection> {
        const config = await this.issuanceConfigs.getForTenant(tenantId);
        const credentialIssuer = `${this.publicUrl}/issuers/${tenantId}`;
        const enabled = (config.authorizationServers ?? []).filter(
            (server) => server.enabled !== false,
        );

        if (requested) {
            for (const server of enabled) {
                if (server.id !== requested) continue;
                const endpoint = toAuthorizationServerEndpoint(server);
                if (endpoint) {
                    const issuer = authorizationServerIssuer(
                        endpoint,
                        credentialIssuer,
                    );
                    // Historical behavior: an explicit selection stores the
                    // resolved issuer URL, not the configured server id.
                    return { issuer, sessionServerId: issuer };
                }
            }
            throw new AuthorizationServerNotConfigured(
                `Authorization server '${requested}' is not configured or enabled`,
            );
        }

        for (const server of enabled) {
            const endpoint = toAuthorizationServerEndpoint(server);
            if (endpoint) {
                return {
                    issuer: authorizationServerIssuer(
                        endpoint,
                        credentialIssuer,
                    ),
                    sessionServerId: enabled[0]?.id,
                };
            }
        }
        throw new AuthorizationServerNotConfigured(
            "No enabled authorization server configured",
        );
    }
}
