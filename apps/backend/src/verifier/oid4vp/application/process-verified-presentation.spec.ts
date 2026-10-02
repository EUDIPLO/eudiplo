import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import {
    CompletePresentationResponse,
    PresentationAlreadyConsumed,
} from "./complete-presentation-response.js";
import { FailPresentationResponse } from "./fail-presentation-response.js";
import { ParseAuthorizationResponse } from "./parse-authorization-response.js";
import { ProcessVerifiedPresentation } from "./process-verified-presentation.js";

describe("presentation completion and publication", () => {
    const session = {
        id: "session",
        tenantId: "tenant",
        walletNonce: "state",
        redirectUri: "https://original.example",
    } as SessionData;
    const webhook = {
        url: "https://webhook.example",
        auth: { type: "none" as const },
    };
    const input = {
        session,
        response: { vp_token: { pid: ["raw"] }, state: "state" },
        credentials: [{ id: "pid" }],
        responseCode: "code",
        webhook,
        rawPresentationPayload: { private: "raw" },
    };
    function fixture() {
        const writes: unknown[] = [];
        const update = vi.fn().mockImplementation(async (...args) => {
            writes.push(args);
            return true;
        });
        const publish = vi.fn().mockImplementation(async () => {
            expect(update).toHaveBeenCalledOnce();
            return { redirectUri: "https://override.example" };
        });
        const useCase = new ProcessVerifiedPresentation(
            new ParseAuthorizationResponse(),
            new CompletePresentationResponse(
                { updateIfUnconsumed: update },
                { announce: vi.fn() },
            ),
            { publish },
        );
        return { useCase, update, publish, writes };
    }
    it("completes and clears keys before publishing raw payload only in memory", async () => {
        const f = fixture();
        await expect(f.useCase.execute(input)).resolves.toEqual({
            redirectUri: "https://override.example",
            publicationFailed: false,
        });
        expect(f.update).toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({
                status: "completed",
                responseCode: "code",
                consumed: true,
                responseEncryptionPrivateJwk: null,
            }),
        );
        expect(JSON.stringify(f.writes)).not.toContain("private");
        expect(f.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                rawPresentationPayload: input.rawPresentationPayload,
            }),
        );
    });
    it("rejects state mismatches before persistence and publication", async () => {
        const f = fixture();
        await expect(
            f.useCase.execute({
                ...input,
                response: { ...input.response, state: "wrong" },
            }),
        ).rejects.toMatchObject({
            name: "PresentationResponseValidationError",
        });
        expect(f.update).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
    });
    it("preserves completion on delivery failure and returns its audit context", async () => {
        const f = fixture();
        const error = new Error("delivery");
        f.publish.mockRejectedValue(error);
        await expect(f.useCase.execute(input)).resolves.toEqual({
            redirectUri: session.redirectUri,
            publicationFailed: true,
            publicationError: error,
        });
        expect(f.update).toHaveBeenCalledOnce();
    });
    it("does not publish after a persistence failure", async () => {
        const f = fixture();
        f.update.mockRejectedValue(new Error("storage"));
        await expect(f.useCase.execute(input)).rejects.toThrow("storage");
        expect(f.publish).not.toHaveBeenCalled();
    });
    it("supports absent state and no webhook", async () => {
        const f = fixture();
        await expect(
            f.useCase.execute({
                ...input,
                webhook: undefined,
                response: { vp_token: {} },
            }),
        ).resolves.toEqual({
            redirectUri: session.redirectUri,
            publicationFailed: false,
        });
        expect(f.publish).not.toHaveBeenCalled();
    });
    it.each([undefined, "invalid_signature"])(
        "persists failure and clears keys with code %s",
        async (code) => {
            const updateIfUnconsumed = vi.fn().mockResolvedValue(true);
            const announce = vi.fn();
            await new FailPresentationResponse(
                { updateIfUnconsumed },
                { announce },
            ).execute({
                tenantId: "tenant",
                sessionId: "session",
                requestId: "presentation",
                message: "failed",
                code,
            });
            expect(announce).toHaveBeenCalledExactlyOnceWith(
                {
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                },
                "failed",
            );
            expect(updateIfUnconsumed).toHaveBeenCalledWith(
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
        },
    );

    it("does not announce a failure when the session is gone, completed or expired", async () => {
        const announce = vi.fn();
        await new FailPresentationResponse(
            { updateIfUnconsumed: vi.fn().mockResolvedValue(false) },
            { announce },
        ).execute({ tenantId: "tenant", sessionId: "gone", message: "failed" });
        expect(announce).not.toHaveBeenCalled();
    });

    it("does not publish when another response already completed the session", async () => {
        const publish = vi.fn();
        const useCase = new ProcessVerifiedPresentation(
            new ParseAuthorizationResponse(),
            new CompletePresentationResponse(
                { updateIfUnconsumed: vi.fn().mockResolvedValue(false) },
                { announce: vi.fn() },
            ),
            { publish },
        );

        await expect(useCase.execute(input)).rejects.toBeInstanceOf(
            PresentationAlreadyConsumed,
        );
        expect(publish).not.toHaveBeenCalled();
    });
});
