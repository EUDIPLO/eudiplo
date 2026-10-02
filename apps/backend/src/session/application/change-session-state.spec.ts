import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionEventPublisher } from "../ports/session-event-publisher.js";
import { ChangeSessionState } from "./change-session-state.js";

function setup() {
    const repository = {
        changeState: vi
            .fn<SessionRepository["changeState"]>()
            .mockResolvedValue(undefined),
        changeStateFrom: vi
            .fn<SessionRepository["changeStateFrom"]>()
            .mockResolvedValue(true),
    };
    const events = {
        publishStatusChanged:
            vi.fn<SessionEventPublisher["publishStatusChanged"]>(),
    };
    return {
        repository,
        events,
        useCase: new ChangeSessionState(repository, events),
    };
}
const session = { id: "id", tenantId: "tenant", requestId: "presentation" };

describe("ChangeSessionState", () => {
    it("waits for persistence before publishing only the public status data", async () => {
        const { repository, events, useCase } = setup();
        let finish!: () => void;
        repository.changeState.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const pending = useCase.execute(session, SessionStatus.Completed);
        expect(events.publishStatusChanged).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(repository.changeState).toHaveBeenCalledWith("tenant", "id", {
            status: SessionStatus.Completed,
            responseEncryptionPrivateJwk: null,
        });
        expect(events.publishStatusChanged).toHaveBeenCalledWith({
            sessionId: "id",
            status: SessionStatus.Completed,
            updatedAt: expect.any(Date),
        });
    });

    it("propagates synchronous publication failures", async () => {
        const { repository, events, useCase } = setup();
        const error = new Error("publication failed");
        events.publishStatusChanged.mockImplementation(() => {
            throw error;
        });
        await expect(
            useCase.execute(session, SessionStatus.Failed),
        ).rejects.toBe(error);
        expect(repository.changeState).toHaveBeenCalledOnce();
    });

    it("preserves repeated-transition behavior without adding deduplication", async () => {
        const { events, useCase } = setup();
        await useCase.execute(session, SessionStatus.Expired);
        await useCase.execute(session, SessionStatus.Expired);
        expect(events.publishStatusChanged).toHaveBeenCalledTimes(2);
    });

    it("announces an already-persisted transition without writing", () => {
        const { repository, events, useCase } = setup();
        useCase.announce(session, SessionStatus.Failed);
        expect(repository.changeState).not.toHaveBeenCalled();
        expect(events.publishStatusChanged).toHaveBeenCalledExactlyOnceWith({
            sessionId: "id",
            status: SessionStatus.Failed,
            updatedAt: expect.any(Date),
        });
    });

    it("changes the status from an expected status and announces it", async () => {
        const { repository, events, useCase } = setup();
        await expect(
            useCase.executeFrom(
                session,
                [SessionStatus.Active],
                SessionStatus.Fetched,
            ),
        ).resolves.toBe(true);
        expect(repository.changeStateFrom).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            "id",
            [SessionStatus.Active],
            { status: SessionStatus.Fetched },
        );
        expect(events.publishStatusChanged).toHaveBeenCalledExactlyOnceWith({
            sessionId: "id",
            status: SessionStatus.Fetched,
            updatedAt: expect.any(Date),
        });
    });

    it("does not announce when the session left the expected status", async () => {
        const { repository, events, useCase } = setup();
        repository.changeStateFrom.mockResolvedValue(false);
        await expect(
            useCase.executeFrom(
                session,
                [SessionStatus.Active, SessionStatus.Fetched],
                SessionStatus.Expired,
            ),
        ).resolves.toBe(false);
        expect(repository.changeStateFrom).toHaveBeenCalledWith(
            "tenant",
            "id",
            [SessionStatus.Active, SessionStatus.Fetched],
            {
                status: SessionStatus.Expired,
                responseEncryptionPrivateJwk: null,
            },
        );
        expect(events.publishStatusChanged).not.toHaveBeenCalled();
    });
});
