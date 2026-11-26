import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { credentialNotificationResult } from "../domain/credential-notification-result.js";
import { HandleCredentialNotification } from "./handle-credential-notification.js";

describe("HandleCredentialNotification", () => {
    function setup(
        publish = vi.fn().mockResolvedValue(undefined),
        changed = true,
    ) {
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
            webhookEndpointId: "issuance-events",
        } as SessionData;
        const endpoint = {
            id: "issuance-events",
            tenantId: "tenant-1",
            url: "https://backend.example/notify",
            auth: { type: "none" },
        };
        const notification = {
            id: "notification-1",
            credentialConfigurationId: "pid",
        };
        const order: string[] = [];
        const record = vi.fn(async () => {
            order.push("record");
            return notification;
        });
        const changeState = vi.fn(async (..._args: unknown[]) => {
            order.push("state");
            return changed;
        });
        const publisher = vi.fn(async (...args: unknown[]) => {
            order.push("publish");
            return publish(...args);
        });
        const useCase = new HandleCredentialNotification(
            { execute: record },
            { findForTenant: vi.fn().mockResolvedValue(endpoint) },
            { publish: publisher },
            { executeFrom: changeState },
        );
        return {
            useCase,
            session,
            notification,
            record,
            changeState,
            publisher,
            order,
        };
    }

    it.each([
        ["credential_accepted", "completed"],
        ["credential_failure", "failed"],
        ["credential_deleted", "failed"],
    ] as const)(
        "moves a fetched session for %s to %s with its outcome",
        async (event, status) => {
            const test = setup();
            await test.useCase.execute(
                test.session,
                "notification-1",
                event,
                "Why",
            );
            expect(test.changeState).toHaveBeenCalledExactlyOnceWith(
                test.session,
                ["fetched"],
                status,
                credentialNotificationResult(event, "Why"),
            );
        },
    );

    it("records and publishes the event even when the session already finished", async () => {
        const test = setup(vi.fn().mockResolvedValue(undefined), false);

        await expect(
            test.useCase.execute(
                test.session,
                "notification-1",
                "credential_deleted",
            ),
        ).resolves.toEqual({ publicationFailed: false });
        expect(test.record).toHaveBeenCalledOnce();
        expect(test.publisher).toHaveBeenCalledOnce();
        expect(test.order).toEqual(["record", "state", "publish"]);
    });

    it("records the event with its description and changes the status before publishing", async () => {
        const test = setup();

        await expect(
            test.useCase.execute(
                test.session,
                "notification-1",
                "credential_failure",
                "Storage full",
            ),
        ).resolves.toEqual({ publicationFailed: false });
        expect(test.record).toHaveBeenCalledExactlyOnceWith(
            test.session,
            "notification-1",
            "credential_failure",
            "Storage full",
        );
        expect(test.publisher).toHaveBeenCalledExactlyOnceWith(
            {
                url: "https://backend.example/notify",
                auth: { type: "none" },
                storedAs: { kind: "WebhookEndpoint", tenantId: "tenant-1" },
            },
            test.session,
            test.notification,
        );
        expect(test.order).toEqual(["record", "state", "publish"]);
    });

    it("reports a failed delivery instead of failing the notification", async () => {
        const failure = new Error("Error sending webhook: 500");
        const test = setup(vi.fn().mockRejectedValue(failure));

        await expect(
            test.useCase.execute(
                test.session,
                "notification-1",
                "credential_accepted",
            ),
        ).resolves.toEqual({
            publicationFailed: true,
            publicationError: failure,
        });
        expect(test.changeState).toHaveBeenCalledWith(
            test.session,
            ["fetched"],
            "completed",
            expect.anything(),
        );
    });

    it("changes the status without a webhook endpoint", async () => {
        const test = setup();
        const session = { ...test.session, webhookEndpointId: undefined };

        await expect(
            test.useCase.execute(
                session,
                "notification-1",
                "credential_deleted",
            ),
        ).resolves.toEqual({ publicationFailed: false });
        expect(test.changeState).toHaveBeenCalledWith(
            session,
            ["fetched"],
            "failed",
            expect.anything(),
        );
        expect(test.publisher).not.toHaveBeenCalled();
    });
});
