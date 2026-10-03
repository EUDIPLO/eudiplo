import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import type { AuthorizationServersService } from "../authorization/authorization-servers/authorization-servers.service.js";
import type { AuthorizeService } from "../authorization/authorize/authorize.service.js";
import type { ChainedAsService } from "../authorization/chained-as/chained-as.service.js";
import type { HostedAuthorizationServer } from "../domain/authorization-server-endpoint.js";
import type { HostedAuthorizationServerMetadata } from "../ports/authorization-server-metadata.js";

/** Reads the metadata of EUDIPLO-hosted authorization servers from their services. */
export class HostedAuthorizationServerMetadataAdapter
    implements HostedAuthorizationServerMetadata
{
    constructor(
        private readonly builtIn: AuthorizeService,
        private readonly oid4vp: AuthorizationServersService,
        private readonly chainedAs: ChainedAsService,
    ) {}

    async get(
        tenantId: string,
        server: HostedAuthorizationServer,
    ): Promise<AuthorizationServerMetadata> {
        switch (server.kind) {
            case "built-in":
                return this.builtIn.authzMetadata(tenantId);
            case "oid4vp":
                return (await this.oid4vp.getMetadata(
                    tenantId,
                    server.id,
                )) as AuthorizationServerMetadata;
            case "chained-as":
                return (await this.chainedAs.getMetadata(
                    tenantId,
                )) as AuthorizationServerMetadata;
        }
    }
}
