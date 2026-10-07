import type { ChangeSessionState } from "../../../../session/application/change-session-state.js";
import type {
    Notification,
    SessionData,
} from "../../../../session/domain/session-data.js";
import { SessionStatus } from "../../../../session/domain/session-state.js";
import type { WebhookEndpointRepository } from "../../../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import type { CredentialNotificationPublisher } from "../ports/credential-notification-publisher.js";
import type { RecordCredentialNotification } from "./record-credential-notification.js";

/**
 * Records the wallet's event and changes the session status before publishing
 * the event, so that delivery is best effort like for presentation results.
 */
export class HandleCredentialNotification {
    constructor(
        private readonly record: Pick<RecordCredentialNotification, "execute">,
        private readonly endpoints: Pick<
            WebhookEndpointRepository,
            "findForTenant"
        >,
        private readonly publisher: CredentialNotificationPublisher,
        private readonly state: Pick<ChangeSessionState, "execute">,
    ) {}
    async execute(
        session: SessionData,
        notificationId: string,
        event: Notification["event"],
        eventDescription?: string,
    ): Promise<{ publicationFailed: boolean; publicationError?: unknown }> {
        const notification = await this.record.execute(
            session,
            notificationId,
            event,
            eventDescription,
        );
        const endpoint = session.webhookEndpointId
            ? await this.endpoints.findForTenant(
                  session.tenantId,
                  session.webhookEndpointId,
              )
            : null;
        await this.state.execute(
            session,
            event === "credential_accepted"
                ? SessionStatus.Completed
                : SessionStatus.Failed,
        );
        if (!endpoint) return { publicationFailed: false };
        try {
            await this.publisher.publish(
                { url: endpoint.url, auth: endpoint.auth },
                session,
                notification,
            );
            return { publicationFailed: false };
        } catch (publicationError) {
            return { publicationFailed: true, publicationError };
        }
    }
}
