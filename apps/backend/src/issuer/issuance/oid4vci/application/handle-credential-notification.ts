import type { ChangeSessionState } from "../../../../session/application/change-session-state.js";
import type {
    Notification,
    SessionData,
} from "../../../../session/domain/session-data.js";
import { SessionStatus } from "../../../../session/domain/session-state.js";
import type { WebhookEndpointRepository } from "../../../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import type { CredentialNotificationPublisher } from "../ports/credential-notification-publisher.js";
import type { RecordCredentialNotification } from "./record-credential-notification.js";

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
    ): Promise<void> {
        const notification = await this.record.execute(
            session,
            notificationId,
            event,
        );
        if (session.webhookEndpointId) {
            const endpoint = await this.endpoints.findForTenant(
                session.tenantId,
                session.webhookEndpointId,
            );
            if (endpoint)
                await this.publisher.publish(
                    { url: endpoint.url, auth: endpoint.auth },
                    session,
                    notification,
                );
        }
        await this.state.execute(
            session,
            event === "credential_accepted"
                ? SessionStatus.Completed
                : SessionStatus.Failed,
        );
    }
}
