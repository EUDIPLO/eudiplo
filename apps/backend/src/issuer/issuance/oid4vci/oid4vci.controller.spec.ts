import { HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { CredentialNotificationNotFound } from "./application/record-credential-notification.js";
import { Oid4vciController } from "./oid4vci.controller.js";

describe("Oid4vciController notification endpoint", () => {
    function notify(error: unknown): Promise<unknown> {
        const controller = new Oid4vciController(
            { handleNotification: vi.fn().mockRejectedValue(error) } as never,
            {} as never,
        );
        return controller
            .notifications(
                {
                    notification_id: "notification",
                    event: "credential_accepted",
                },
                {
                    body: {},
                    headers: {},
                    method: "POST",
                    url: "/notification",
                } as Request,
                "tenant",
                { setHeader: vi.fn() } as unknown as Response,
            )
            .then(
                () => {
                    throw new Error("expected a rejection");
                },
                (rejection: unknown) => rejection,
            );
    }

    it("answers an unknown notification_id with invalid_notification_id", async () => {
        const error = await notify(
            new CredentialNotificationNotFound("notification"),
        );
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(400);
        expect((error as HttpException).getResponse()).toEqual({
            error: "invalid_notification_id",
            error_description:
                "The notification_id is invalid or does not belong to the access token",
        });
    });

    it("passes other errors through", async () => {
        const failure = new Error("database unavailable");
        expect(await notify(failure)).toBe(failure);
    });
});
