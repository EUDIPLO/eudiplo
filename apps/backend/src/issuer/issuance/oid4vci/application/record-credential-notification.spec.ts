import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
import {
    CredentialNotificationNotFound,
    RecordCredentialNotification,
} from "./record-credential-notification.js";

describe("RecordCredentialNotification", () => {
    it("persists the event before returning the updated notification", async () => {
        const notification = {
            id: "notification-1",
            credentialConfigurationId: "pid",
        };
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
            notifications: [notification],
        } as SessionData;
        const updateForTenant = vi.fn().mockResolvedValue(1);
        const useCase = new RecordCredentialNotification({ updateForTenant });

        await expect(
            useCase.execute(session, "notification-1", "credential_accepted"),
        ).resolves.toBe(notification);
        expect(notification.event).toBe("credential_accepted");
        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            { notifications: session.notifications },
        );
    });

    it("fails without persisting when the notification is unknown", async () => {
        const updateForTenant = vi.fn();
        const useCase = new RecordCredentialNotification({ updateForTenant });
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
            notifications: [],
        } as SessionData;

        await expect(
            useCase.execute(session, "missing", "credential_accepted"),
        ).rejects.toBeInstanceOf(CredentialNotificationNotFound);
        expect(updateForTenant).not.toHaveBeenCalled();
    });

    it("preserves persistence failures", async () => {
        const failure = new Error("database unavailable");
        const useCase = new RecordCredentialNotification({
            updateForTenant: vi.fn().mockRejectedValue(failure),
        });
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
            notifications: [{ id: "notification-1" }],
        } as SessionData;

        await expect(
            useCase.execute(session, "notification-1", "credential_accepted"),
        ).rejects.toBe(failure);
    });
});
