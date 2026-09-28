import { EventEmitter2 } from "@nestjs/event-emitter";
import { MetricService } from "nestjs-otel";
import { Repository } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import { ChangeSessionState } from "../application/change-session-state.js";
import { SessionStatus } from "../domain/session-state.js";
import { Session } from "../entities/session.entity.js";
import { NestSessionEventPublisher } from "./nest-session-event-publisher.js";
import { OtelSessionMetrics } from "./otel-session-metrics.js";
import { TypeOrmSessionRepository } from "./typeorm-session.repository.js";

function setup(write = async () => {}) {
    const order: string[] = [];
    const update = vi.fn(async (_where: unknown, _change: unknown) => {
        order.push("persist");
        await write();
    });
    const emit = vi.fn(() => {
        order.push("publish");
    });
    const add = vi.fn((_value: number, _attributes: unknown) => {
        order.push("metric");
    });
    const service = new ChangeSessionState(
        new TypeOrmSessionRepository({
            update,
        } as unknown as Repository<Session>),
        new NestSessionEventPublisher({ emit } as unknown as EventEmitter2),
        new OtelSessionMetrics({
            getUpDownCounter: () => ({ add }),
        } as unknown as MetricService),
    );
    return { service, update, emit, add, order };
}

describe("session state-change characterization", () => {
    it.each(Object.values(SessionStatus))(
        "preserves persistence, event, and metric order for %s",
        async (status) => {
            const { service, order, update, emit, add } = setup();
            const session = {
                id: "session",
                tenantId: "tenant",
                requestId: "presentation",
                status: SessionStatus.Fetched,
            } as Session;
            await service.execute(session, status);
            expect(order).toEqual(["persist", "publish", "metric", "metric"]);
            expect(emit).toHaveBeenCalledWith(
                "session.status.changed",
                expect.objectContaining({
                    sessionId: session.id,
                    status,
                    updatedAt: expect.any(Date),
                }),
            );
            expect(add.mock.calls).toEqual([
                [
                    1,
                    {
                        tenant_id: "tenant",
                        session_type: "verification",
                        status,
                    },
                ],
                [
                    -1,
                    {
                        tenant_id: "tenant",
                        session_type: "verification",
                        status: "active",
                    },
                ],
            ]);
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
                ].includes(status)
                    ? { status, responseEncryptionPrivateJwk: null }
                    : { status },
            );
            expect(session.status).toBe(SessionStatus.Fetched);
        },
    );

    it("does not publish or record metrics if persistence fails", async () => {
        const failure = new Error("database unavailable");
        const { service, emit, add } = setup(async () => {
            throw failure;
        });
        await expect(
            service.execute(
                { id: "session", tenantId: "tenant" } as Session,
                SessionStatus.Failed,
            ),
        ).rejects.toBe(failure);
        expect(emit).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
    });
});
