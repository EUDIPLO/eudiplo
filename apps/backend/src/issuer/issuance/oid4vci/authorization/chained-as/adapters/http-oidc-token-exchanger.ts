import type { HttpService } from "@nestjs/axios";
import type { OutboundUrlPolicyService } from "../../../../../../webhook/outbound-url-policy.service.js";
import { requestAuthorizationServer } from "../../../adapters/authorization-server-http.js";
import type {
    OidcTokenExchangeInput,
    OidcTokenExchangeResult,
    OidcTokenExchanger,
} from "../ports/oidc-token-exchanger.js";

/**
 * Redeems the upstream authorization code under the outbound URL policy. The
 * token endpoint comes from the upstream discovery document; redirects are
 * not followed.
 */
export class HttpOidcTokenExchanger implements OidcTokenExchanger {
    constructor(
        private readonly http: HttpService,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
    ) {}

    async exchange(
        input: OidcTokenExchangeInput,
    ): Promise<OidcTokenExchangeResult> {
        const response = await requestAuthorizationServer(
            this.http,
            this.outboundUrlPolicy,
            {
                url: input.tokenEndpoint,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code: input.code,
                    redirect_uri: input.redirectUri,
                    client_id: input.clientId,
                    client_secret: input.clientSecret || "",
                    code_verifier: input.codeVerifier || "",
                }).toString(),
            },
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Upstream token request failed with status code ${response.status}`,
            );
        }

        const tokens = JSON.parse(response.data) as {
            access_token: string;
            id_token?: string;
        };
        return { accessToken: tokens.access_token, idToken: tokens.id_token };
    }
}
