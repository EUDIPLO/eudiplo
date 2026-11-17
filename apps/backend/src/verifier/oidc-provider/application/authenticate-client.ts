import {
    matchClientSecret,
    type OidcClient,
    secretUseIsStale,
} from "../domain/oidc-client.js";
import { OidcError } from "../domain/oidc-error.js";
import type { OidcClientRepository } from "../ports/oidc-client.repository.js";

/** Credentials a client presented with `client_secret_basic` or `_post`. */
export interface ClientCredentials {
    clientId?: string;
    clientSecret?: string;
}

/**
 * Authenticate a confidential client at the pushed authorization request
 * and token endpoints (RFC 6749 Section 2.3.1). Every failure is the same
 * `invalid_client`, so the answer does not reveal which client IDs exist.
 */
export class AuthenticateOidcClient {
    constructor(
        private readonly clients: Pick<
            OidcClientRepository,
            "findForTenant" | "recordSecretUse"
        >,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(
        tenantId: string,
        credentials: ClientCredentials,
    ): Promise<OidcClient> {
        const failed = () =>
            new OidcError("invalid_client", "Client authentication failed", {
                clientAuthenticationFailed: true,
            });
        if (!credentials.clientId || !credentials.clientSecret) throw failed();
        const client = await this.clients.findForTenant(
            tenantId,
            credentials.clientId,
        );
        if (!client) throw failed();
        const now = this.now();
        const secret = matchClientSecret(client, credentials.clientSecret, now);
        if (!secret) throw failed();
        if (secretUseIsStale(secret, now)) {
            await this.clients.recordSecretUse(
                tenantId,
                client.id,
                secret.id,
                now,
            );
        }
        return client;
    }
}
