import { oidcDiscoveryUrl } from "../../../../../../shared/domain/oidc-discovery-url.js";
import type { OutboundUrlPolicyService } from "../../../../../../webhook/outbound-url-policy.service.js";
import { getAuthorizationServerJson } from "../../../adapters/authorization-server-http.js";
import type {
    OidcDiscoveryDocument,
    OidcDiscoveryResolver,
} from "../ports/oidc-discovery-resolver.js";

/** Fetches upstream OIDC discovery documents under the outbound URL policy. */
export class HttpOidcDiscoveryResolver implements OidcDiscoveryResolver {
    constructor(private readonly outboundUrlPolicy: OutboundUrlPolicyService) {}

    resolve(issuer: string): Promise<OidcDiscoveryDocument> {
        return getAuthorizationServerJson<OidcDiscoveryDocument>(
            this.outboundUrlPolicy,
            oidcDiscoveryUrl(issuer),
        );
    }
}
