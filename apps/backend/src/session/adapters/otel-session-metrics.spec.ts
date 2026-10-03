import type { ObservableResult } from "@opentelemetry/api";
import type { MetricService } from "nestjs-otel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import type {
    SessionCount,
    SessionRepository,
} from "../ports/session.repository.js";
import {
    OtelSessionMetrics,
    SESSION_METRICS_REFRESH_INTERVAL_MS,
} from "./otel-session-metrics.js";

function setup(counts: SessionCount[] = []) {
    const addCallback = vi.fn();
    const removeCallback = vi.fn();
    const getObservableGauge = vi.fn(() => ({ addCallback, removeCallback }));
    const countSessionsByStatus = vi
        .fn<SessionRepository["countSessionsByStatus"]>()
        .mockResolvedValue(counts);
    const metrics = new OtelSessionMetrics(
        { getObservableGauge } as unknown as MetricService,
        { countSessionsByStatus },
    );
    return {
        metrics,
        getObservableGauge,
        addCallback,
        removeCallback,
        countSessionsByStatus,
    };
}

/** Collects one export: a map from "tenant/type/status" to the value. */
function collect(metrics: OtelSessionMetrics): Record<string, number> {
    const observed: Record<string, number> = {};
    metrics.observe({
        observe: (value: number, attributes: Record<string, string>) => {
            observed[
                `${attributes.tenant_id}/${attributes.session_type}/${attributes.status}`
            ] = value;
        },
    } as unknown as ObservableResult);
    return observed;
}

describe("OtelSessionMetrics", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("registers the `sessions` gauge and unregisters on shutdown", async () => {
        const { metrics, getObservableGauge, addCallback, removeCallback } =
            setup();
        expect(getObservableGauge).toHaveBeenCalledExactlyOnceWith("sessions", {
            description: "Number of sessions by tenant, type and status",
        });
        metrics.onModuleInit();
        expect(addCallback).toHaveBeenCalledOnce();
        metrics.onModuleDestroy();
        expect(removeCallback).toHaveBeenCalledWith(
            addCallback.mock.calls[0][0],
        );
    });

    it("reports database counts per tenant, type and status, zero-filled", async () => {
        const { metrics } = setup([
            {
                tenantId: "a",
                kind: "verification",
                status: SessionStatus.Fetched,
                count: 3,
            },
            {
                tenantId: "a",
                kind: "issuance",
                status: SessionStatus.Active,
                count: 2,
            },
        ]);
        await metrics.refresh();
        const observed = collect(metrics);
        expect(Object.keys(observed)).toHaveLength(
            2 * Object.values(SessionStatus).length,
        );
        expect(observed["a/verification/fetched"]).toBe(3);
        expect(observed["a/issuance/active"]).toBe(2);
        expect(observed["a/verification/active"]).toBe(0);
        expect(observed["a/issuance/completed"]).toBe(0);
    });

    it("never waits for the database and refreshes at most every interval", async () => {
        vi.useFakeTimers();
        const { metrics, countSessionsByStatus } = setup();
        let finish!: (counts: SessionCount[]) => void;
        countSessionsByStatus.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        // The first export starts a read but reports the (empty) cache.
        expect(collect(metrics)).toEqual({});
        expect(collect(metrics)).toEqual({});
        expect(countSessionsByStatus).toHaveBeenCalledOnce();
        finish([
            {
                tenantId: "a",
                kind: "issuance",
                status: SessionStatus.Active,
                count: 1,
            },
        ]);
        // Joins the read in flight instead of starting another one.
        await metrics.refresh();
        expect(countSessionsByStatus).toHaveBeenCalledOnce();
        expect(collect(metrics)["a/issuance/active"]).toBe(1);

        vi.advanceTimersByTime(SESSION_METRICS_REFRESH_INTERVAL_MS - 1);
        collect(metrics);
        expect(countSessionsByStatus).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1);
        collect(metrics);
        expect(countSessionsByStatus).toHaveBeenCalledTimes(2);
    });

    it("keeps the last snapshot when a read fails", async () => {
        const { metrics, countSessionsByStatus } = setup([
            {
                tenantId: "a",
                kind: "issuance",
                status: SessionStatus.Active,
                count: 4,
            },
        ]);
        await metrics.refresh();
        countSessionsByStatus.mockRejectedValueOnce(new Error("db down"));
        await metrics.refresh();
        expect(collect(metrics)["a/issuance/active"]).toBe(4);
    });

    it("reports a tenant without sessions as zero once, then drops it", async () => {
        const { metrics, countSessionsByStatus } = setup([
            {
                tenantId: "gone",
                kind: "issuance",
                status: SessionStatus.Active,
                count: 1,
            },
        ]);
        await metrics.refresh();
        countSessionsByStatus.mockResolvedValue([]);
        await metrics.refresh();
        expect(collect(metrics)["gone/issuance/active"]).toBe(0);
        await metrics.refresh();
        expect(collect(metrics)).toEqual({});
    });
});
