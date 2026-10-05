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
        const wellKnownUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
        return getAuthorizationServerJson<OidcDiscoveryDocument>(
            this.outboundUrlPolicy,
            wellKnownUrl,
        );
    }
}
