import type { WebhookService } from "../../../../webhook/webhook.service.js";
import type {
    RemoteCredentialClaims,
    RemoteCredentialClaimsRequest,
} from "../ports/remote-credential-claims.js";

export class WebhookRemoteCredentialClaims implements RemoteCredentialClaims {
    constructor(
        private readonly webhooks: Pick<WebhookService, "sendClaimsWebhook">,
    ) {}

    async fetchClaims(request: RemoteCredentialClaimsRequest) {
        const response = await this.webhooks.sendClaimsWebhook(request);
        if (response.deferred)
            return { deferred: true, interval: response.interval ?? 5 };
        return {
            deferred: false,
            claims: response[request.credentialConfigurationId] as
                | Record<string, unknown>
                | undefined,
        };
    }
}
