import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../../../session/domain/session-state.js";
import {
    CompletePresentationResponse,
    PresentationAlreadyConsumed,
} from "./complete-presentation-response.js";

describe("CompletePresentationResponse", () => {
    it("persists completed status, replay protection, and outcome provenance", async () => {
        const update = vi.fn().mockResolvedValue(true);
        const announce = vi.fn();
        const response = new CompletePresentationResponse(
            { updateIfUnconsumed: update },
            { announce },
        );
        const consumedAt = new Date("2026-09-27T00:00:00.000Z");

        const outcome = await response.execute({
            tenantId: "tenant-1",
            sessionId: "session-1",
            requestId: "presentation-1",
            credentials: [{ id: "credential-1" }, { value: "credential-2" }],
            responseCode: "response-code",
            consumedAt,
        });
        expect(announce).toHaveBeenCalledExactlyOnceWith(
            {
                id: "session-1",
                tenantId: "tenant-1",
                requestId: "presentation-1",
            },
            SessionStatus.Completed,
        );

        expect(update).toHaveBeenCalledWith("tenant-1", "session-1", {
            credentials: [{ id: "credential-1" }, { value: "credential-2" }],
            status: SessionStatus.Completed,
            responseCode: "response-code",
            consumed: true,
            consumedAt,
            responseEncryptionPrivateJwk: null,
            outcome: {
                result: "success",
                credentials: [
                    { id: "credential-1", verified: true },
                    { id: undefined, verified: true },
                ],
            },
        });
        // The persisted outcome is returned for the presentation webhook.
        expect(outcome).toEqual(update.mock.calls[0][2].outcome);
    });

    it("rejects a response that lost the race without announcing it", async () => {
        const announce = vi.fn();
        const response = new CompletePresentationResponse(
            { updateIfUnconsumed: vi.fn().mockResolvedValue(false) },
            { announce },
        );

        await expect(
            response.execute({
                tenantId: "tenant-1",
                sessionId: "session-1",
                credentials: [],
                responseCode: "response-code",
            }),
        ).rejects.toBeInstanceOf(PresentationAlreadyConsumed);
        expect(announce).not.toHaveBeenCalled();
    });
});
