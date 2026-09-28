import type { SessionStore } from "../../../../session/application/session-store.js";
import type {
    Notification,
    SessionData,
} from "../../../../session/domain/session-data.js";

export class CredentialNotificationNotFound extends Error {
    constructor(notificationId: string) {
        super(`No notifications found in session`);
        this.name = "CredentialNotificationNotFound";
        this.notificationId = notificationId;
    }

    readonly notificationId: string;
}

export class RecordCredentialNotification {
    constructor(
        private readonly sessions: Pick<SessionStore, "updateForTenant">,
    ) {}

    async execute(
        session: SessionData,
        notificationId: string,
        event: Notification["event"],
    ): Promise<Notification> {
        const notification = session.notifications.find(
            (item) => item.id === notificationId,
        );
        if (!notification) {
            throw new CredentialNotificationNotFound(notificationId);
        }

        notification.event = event;
        await this.sessions.updateForTenant(session.tenantId, session.id, {
            notifications: session.notifications,
        });
        return notification;
    }
}
