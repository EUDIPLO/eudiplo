import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import type { SessionStore } from "../../../../session/application/session-store.js";
import { assertSessionUsable } from "../../../../session/domain/session-usability.js";

export interface CredentialOfferSettings {
    allowMultipleConsumption: boolean;
}

export class CredentialOfferNotFound extends Error {
    constructor(options?: ErrorOptions) {
        super("Credential offer not found", options);
        this.name = "CredentialOfferNotFound";
    }
}

export class RetrieveCredentialOffer {
    constructor(
        private readonly sessions: Pick<
            SessionStore,
            "findCredentialOffer" | "consumeCredentialOffer"
        >,
        private readonly settings: CredentialOfferSettings,
    ) {}

    /**
     * @throws CredentialOfferNotFound when the session or its offer is missing
     * @throws SessionNotUsable when the offer expired or the session is finished
     */
    async execute(
        tenantId: string,
        sessionId: string,
    ): Promise<CredentialOfferObject | null> {
        // Preserve the existing endpoint's lookup-failure mapping, including
        // persistence failures, while retaining the cause for diagnostics.
        const session = await this.sessions
            .findCredentialOffer(tenantId, sessionId)
            .catch((cause: unknown) => {
                throw new CredentialOfferNotFound({ cause });
            });
        if (!session) throw new CredentialOfferNotFound();
        assertSessionUsable(session, new Date());

        if (!this.settings.allowMultipleConsumption) {
            if (
                !session.offer ||
                !(await this.sessions.consumeCredentialOffer(
                    tenantId,
                    sessionId,
                ))
            ) {
                throw new CredentialOfferNotFound();
            }
        }

        // Multiple-consumption mode historically returns an empty response for
        // an existing session without an offer. Preserve that behavior here.
        return session.offer;
    }
}
