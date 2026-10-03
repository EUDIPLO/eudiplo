import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import { FailPresentationResponse } from "./fail-presentation-response.js";

describe("FailPresentationResponse", () => {
    const session = {
        id: "session",
        tenantId: "tenant",
        transaction_data: [{ type: "payment" }],
    } as unknown as SessionData;
    const webhook = {
        url: "https://webhook.example",
        auth: { type: "none" as const },
    };

    function fixture(options: { updated?: boolean } = {}) {
        const writes: string[] = [];
        const updateIfUnconsumed = vi.fn().mockImplementation(async () => {
            writes.push("update");
            return options.updated ?? true;
        });
        const announce = vi.fn().mockImplementation(() => {
            writes.push("announce");
        });
        const publish = vi.fn().mockImplementation(async () => {
            writes.push("publish");
            return {};
        });
        const useCase = new FailPresentationResponse(
            { updateIfUnconsumed },
            { announce },
            { publish },
        );
        return {
            useCase,
            updateIfUnconsumed,
            announce,
            publish,
            writes,
        };
    }

    it.each([undefined, "invalid_signature"])(
        "persists failure and clears keys with code %s",
        async (code) => {
            const f = fixture();
            await expect(
                f.useCase.execute({
                    tenantId: "tenant",
                    sessionId: "session",
                    requestId: "presentation",
                    message: "failed",
                    code,
                }),
            ).resolves.toEqual({ failed: true, publicationFailed: false });
            expect(f.announce).toHaveBeenCalledExactlyOnceWith(
                {
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                },
                "failed",
            );
            expect(f.updateIfUnconsumed).toHaveBeenCalledWith(
                "tenant",
                "session",
                {
                    status: "failed",
                    errorReason: "failed",
                    responseEncryptionPrivateJwk: null,
                    ...(code ? { failureCode: code } : {}),
                    outcome: {
                        result: "failed",
                        message: "failed",
                        ...(code ? { error: code } : {}),
                    },
                },
            );
            expect(f.publish).not.toHaveBeenCalled();
        },
    );

    it("does not announce or publish a failure when no session was updated", async () => {
        const f = fixture({ updated: false });
        await expect(
            f.useCase.execute({
                tenantId: "tenant",
                sessionId: "gone",
                message: "failed",
                publish: { webhook, session },
            }),
        ).resolves.toEqual({ failed: false, publicationFailed: false });
        expect(f.announce).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
    });

    it("publishes the persisted outcome without credentials after recording the failure", async () => {
        const f = fixture();
        const credential = {
            id: "mdl",
            format: "mso_mdoc",
            docType: "org.iso.18013.5.1.mDL",
            verified: false,
            error: "trust_chain_not_trusted",
            message: "The credential issuer is not in the trusted list.",
        };

        await f.useCase.execute({
            tenantId: "tenant",
            sessionId: "session",
            message: "The credential issuer is not in the trusted list.",
            code: "trust_chain_not_trusted",
            credentials: [credential],
            publish: { webhook, session },
        });

        const outcome = {
            result: "failed",
            error: "trust_chain_not_trusted",
            message: "The credential issuer is not in the trusted list.",
            credentials: [credential],
        };
        expect(f.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({
                failureCode: "trust_chain_not_trusted",
                outcome,
            }),
        );
        expect(f.publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome,
        });
        expect(f.writes).toEqual(["update", "announce", "publish"]);
    });

    it("keeps the final state of a finished or expired session", async () => {
        const f = fixture({ updated: false });

        await expect(
            f.useCase.execute({
                tenantId: "tenant",
                sessionId: "session",
                message: "Wallet error: access_denied",
                code: "access_denied",
                publish: { webhook, session },
            }),
        ).resolves.toEqual({ failed: false, publicationFailed: false });
        expect(f.updateIfUnconsumed).toHaveBeenCalledOnce();
        expect(f.announce).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
    });

    it("returns the webhook's redirect override", async () => {
        const f = fixture();
        f.publish.mockResolvedValue({
            redirectUri: "https://override.example/failed",
        });

        await expect(
            f.useCase.execute({
                tenantId: "tenant",
                sessionId: "session",
                message: "failed",
                publish: { webhook, session },
            }),
        ).resolves.toEqual({
            failed: true,
            redirectUri: "https://override.example/failed",
            publicationFailed: false,
        });
    });

    it("keeps the failure when delivery fails and returns its audit context", async () => {
        const f = fixture();
        const error = new Error("delivery");
        f.publish.mockRejectedValue(error);

        await expect(
            f.useCase.execute({
                tenantId: "tenant",
                sessionId: "session",
                message: "failed",
                publish: { webhook, session },
            }),
        ).resolves.toEqual({
            failed: true,
            publicationFailed: true,
            publicationError: error,
        });
        expect(f.updateIfUnconsumed).toHaveBeenCalledOnce();
        expect(f.announce).toHaveBeenCalledOnce();
    });
});
