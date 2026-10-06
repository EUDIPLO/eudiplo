import { EventEmitter2 } from "@nestjs/event-emitter";
import { Repository } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import { ChangeSessionState } from "../application/change-session-state.js";
import { SessionStatus } from "../domain/session-state.js";
import { Session } from "../entities/session.entity.js";
import { NestSessionEventPublisher } from "./nest-session-event-publisher.js";
import { TypeOrmSessionRepository } from "./typeorm-session.repository.js";

function setup(write = async () => {}, affected = 1) {
    const order: string[] = [];
    const update = vi.fn(async (_where: unknown, _change: unknown) => {
        order.push("persist");
        await write();
        return { affected };
    });
    const emit = vi.fn(() => {
        order.push("publish");
    });
    const service = new ChangeSessionState(
        new TypeOrmSessionRepository({
            update,
        } as unknown as Repository<Session>),
        new NestSessionEventPublisher({ emit } as unknown as EventEmitter2),
    );
    return { service, update, emit, order };
}

describe("session state-change characterization", () => {
    it.each(Object.values(SessionStatus))(
        "preserves persistence and event order for %s",
        async (status) => {
            const { service, order, update, emit } = setup();
            const session = {
                id: "session",
                tenantId: "tenant",
                requestId: "presentation",
                status: SessionStatus.Fetched,
            } as Session;
            await service.execute(session, status);
            expect(order).toEqual(["persist", "publish"]);
            expect(emit).toHaveBeenCalledWith(
                "session.status.changed",
                expect.objectContaining({
                    sessionId: session.id,
                    status,
                    updatedAt: expect.any(Date),
                }),
            );
            expect(update.mock.calls[0][0]).toEqual({
                id: "session",
                tenantId: "tenant",
            });
            const change = update.mock.calls[0][1];
            expect(change).toEqual(
                [
                    SessionStatus.Completed,
                    SessionStatus.Failed,
                    SessionStatus.Expired,
                    SessionStatus.Cancelled,
                ].includes(status)
                    ? { status, responseEncryptionPrivateJwk: null }
                    : { status },
            );
            expect(session.status).toBe(SessionStatus.Fetched);
        },
    );

    it("does not publish if persistence fails", async () => {
        const failure = new Error("database unavailable");
        const { service, emit } = setup(async () => {
            throw failure;
        });
        await expect(
            service.execute(
                { id: "session", tenantId: "tenant" } as Session,
                SessionStatus.Failed,
            ),
        ).rejects.toBe(failure);
        expect(emit).not.toHaveBeenCalled();
    });

    it("publishes a compare-and-set transition only when a row changed", async () => {
        const changed = setup();
        await expect(
            changed.service.executeFrom(
                { id: "session", tenantId: "tenant" },
                [SessionStatus.Active],
                SessionStatus.Fetched,
            ),
        ).resolves.toBe(true);
        expect(changed.order).toEqual(["persist", "publish"]);

        const unchanged = setup(async () => {}, 0);
        await expect(
            unchanged.service.executeFrom(
                { id: "session", tenantId: "tenant" },
                [SessionStatus.Active],
                SessionStatus.Fetched,
            ),
        ).resolves.toBe(false);
        expect(unchanged.emit).not.toHaveBeenCalled();
    });
});
