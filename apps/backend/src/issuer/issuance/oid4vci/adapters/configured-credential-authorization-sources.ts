import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import type { AuthorizationServersService } from "../authorization/authorization-servers/authorization-servers.service.js";
import type { AuthorizeService } from "../authorization/authorize/authorize.service.js";
import type { ChainedAsService } from "../authorization/chained-as/chained-as.service.js";
import type { Oid4vciSettings } from "../oid4vci-settings.js";
import type { CredentialAuthorizationSources } from "../ports/credential-authorization-sources.js";

export class ConfiguredCredentialAuthorizationSources
    implements CredentialAuthorizationSources
{
    constructor(
        private readonly authorization: AuthorizeService,
        private readonly servers: AuthorizationServersService,
        private readonly chained: ChainedAsService,
        private readonly issuance: IssuanceService,
        private readonly settings: Oid4vciSettings,
    ) {}
    async tokenIssuers(tenantId: string) {
        const localIssuer = this.authorization.getAuthzIssuer(tenantId);
        const chainedIssuer = `${this.settings.publicUrl}/issuers/${tenantId}/chained-as`;
        const hasChainedAuthorizationServer =
            await this.servers.hasEnabledChainedAuthorizationServer(tenantId);
        const managedAuthorizationServerIssuers = new Set(
            await this.servers.getAuthorizationServerIssuerUrls(tenantId),
        );
        return {
            localIssuer,
            chainedIssuer,
            hasChainedAuthorizationServer,
            managedAuthorizationServerIssuers,
        };
    }
    async externalServer(tenantId: string, issuer: string) {
        const advertised = (
            await this.servers.getExternalAuthorizationServerUrls(tenantId)
        ).includes(issuer);
        if (!advertised) return { advertised };
        const config = (
            await this.issuance.getIssuanceConfiguration(tenantId)
        ).authorizationServers.find(
            (server) =>
                server.type === "external" &&
                server.enabled !== false &&
                (server as { issuer?: string }).issuer === issuer,
        ) as { id: string; sessionBinding?: { claim: string } } | undefined;
        return {
            advertised,
            configuration: config
                ? { id: config.id, bindingClaim: config.sessionBinding?.claim }
                : undefined,
        };
    }
    upstreamIdentity(issuerState: string) {
        return this.chained.getUpstreamIdentityByIssuerState(issuerState);
    }
}
