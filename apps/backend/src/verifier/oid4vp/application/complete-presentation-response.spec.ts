import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../../../session/domain/session-state.js";
import { CompletePresentationResponse } from "./complete-presentation-response.js";

describe("CompletePresentationResponse", () => {
    it("persists completed status, replay protection, and outcome provenance", async () => {
        const update = vi.fn().mockResolvedValue(undefined);
        const response = new CompletePresentationResponse({ execute: update });
        const consumedAt = new Date("2026-09-27T00:00:00.000Z");

        await response.execute({
            tenantId: "tenant-1",
            sessionId: "session-1",
            credentials: [{ id: "credential-1" }, { value: "credential-2" }],
            responseCode: "response-code",
            consumedAt,
        });

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
    });
});
