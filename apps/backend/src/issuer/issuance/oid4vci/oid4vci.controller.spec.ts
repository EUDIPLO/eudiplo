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

describe("Oid4vciController encrypted request body", () => {
    function streamingRequest(chunks: Buffer[]) {
        const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
        const req = {
            body: {},
            headers: {
                "content-type": "application/openid4vci-credential-request+jwt",
            },
            method: "POST",
            url: "/deferred_credential",
            destroy: vi.fn(),
            on(event: string, listener: (arg?: unknown) => void) {
                (listeners[event] ??= []).push(listener);
                if (event === "end") {
                    queueMicrotask(() => {
                        for (const chunk of chunks) {
                            for (const onData of listeners.data ?? []) {
                                onData(chunk);
                            }
                        }
                        for (const onEnd of listeners.end ?? []) onEnd();
                    });
                }
                return req;
            },
        };
        return req;
    }

    it("stops reading an unparsed body above 10 MB", async () => {
        const getDeferredCredential = vi.fn();
        const controller = new Oid4vciController(
            { getDeferredCredential } as never,
            {} as never,
        );
        const req = streamingRequest([
            Buffer.alloc(6 * 1024 * 1024),
            Buffer.alloc(6 * 1024 * 1024),
        ]);

        const error = await controller
            .deferredCredential(req as unknown as Request, "tenant", {
                setHeader: vi.fn(),
            } as unknown as Response)
            .catch((rejection: unknown) => rejection);

        expect((error as HttpException).getResponse()).toEqual({
            error: "invalid_encryption_parameters",
            error_description: "Encrypted credential request body is too large",
        });
        expect(req.destroy).toHaveBeenCalled();
        expect(getDeferredCredential).not.toHaveBeenCalled();
    });

    it("reads an unparsed body below the limit", async () => {
        const getDeferredCredential = vi.fn().mockResolvedValue({
            deferredCredentialResponse: { credential: "c" },
        });
        const controller = new Oid4vciController(
            { getDeferredCredential } as never,
            {} as never,
        );

        await controller.deferredCredential(
            streamingRequest([
                Buffer.from("a.b"),
                Buffer.from(".c.d.e"),
            ]) as unknown as Request,
            "tenant",
            { setHeader: vi.fn() } as unknown as Response,
        );

        expect(getDeferredCredential).toHaveBeenCalledWith(
            expect.objectContaining({ body: "a.b.c.d.e" }),
            "tenant",
        );
    });
});
