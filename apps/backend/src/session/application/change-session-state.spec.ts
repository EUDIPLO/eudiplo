import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionEventPublisher } from "../ports/session-event-publisher.js";
import type { SessionMetrics } from "../ports/session-metrics.js";
import { ChangeSessionState } from "./change-session-state.js";

function setup() {
    const repository = {
        changeState: vi
            .fn<SessionRepository["changeState"]>()
            .mockResolvedValue(undefined),
    };
    const events = {
        publishStatusChanged:
            vi.fn<SessionEventPublisher["publishStatusChanged"]>(),
    };
    const metrics = {
        recordStateChange: vi.fn<SessionMetrics["recordStateChange"]>(),
    };
    return {
        repository,
        events,
        metrics,
        useCase: new ChangeSessionState(repository, events, metrics),
    };
}
const session = { id: "id", tenantId: "tenant", requestId: "presentation" };

describe("ChangeSessionState", () => {
    it("waits for persistence before any effects, publishing only the public status data", async () => {
        const { repository, events, metrics, useCase } = setup();
        let finish!: () => void;
        repository.changeState.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const pending = useCase.execute(session, SessionStatus.Completed);
        expect(events.publishStatusChanged).not.toHaveBeenCalled();
        expect(metrics.recordStateChange).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(events.publishStatusChanged).toHaveBeenCalledWith({
            sessionId: "id",
            status: SessionStatus.Completed,
            updatedAt: expect.any(Date),
        });
        expect(metrics.recordStateChange).toHaveBeenCalledWith(
            session,
            SessionStatus.Completed,
        );
    });

    it("propagates synchronous publication failures and leaves later metrics untouched", async () => {
        const { repository, events, metrics, useCase } = setup();
        const error = new Error("publication failed");
        events.publishStatusChanged.mockImplementation(() => {
            throw error;
        });
        await expect(
            useCase.execute(session, SessionStatus.Failed),
        ).rejects.toBe(error);
        expect(repository.changeState).toHaveBeenCalledOnce();
        expect(metrics.recordStateChange).not.toHaveBeenCalled();
    });

    it("preserves repeated-transition behavior without adding deduplication", async () => {
        const { events, metrics, useCase } = setup();
        await useCase.execute(session, SessionStatus.Expired);
        await useCase.execute(session, SessionStatus.Expired);
        expect(events.publishStatusChanged).toHaveBeenCalledTimes(2);
        expect(metrics.recordStateChange).toHaveBeenCalledTimes(2);
    });
});
