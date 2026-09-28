import type { MetricService } from "nestjs-otel";
import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import { OtelSessionMetrics } from "./otel-session-metrics.js";

describe("session metrics", () => {
    it.each([undefined, "request-1"])(
        "preserves labels for creation and initial counts: %s",
        (requestId) => {
            const add = vi.fn();
            const getUpDownCounter = vi.fn(() => ({ add }));
            const metrics = new OtelSessionMetrics({
                getUpDownCounter,
            } as unknown as MetricService);
            metrics.recordCreated({ id: "id", tenantId: "tenant", requestId });
            metrics.recordInitialCount(
                "tenant",
                "verification",
                SessionStatus.Fetched,
                12,
            );
            expect(getUpDownCounter).toHaveBeenCalledOnce();
            expect(getUpDownCounter).toHaveBeenCalledWith("sessions", {
                description: "Total number of sessions by status",
            });
            expect(add.mock.calls).toEqual([
                [
                    1,
                    {
                        tenant_id: "tenant",
                        session_type: requestId ? "verification" : "issuance",
                        status: "active",
                    },
                ],
                [
                    12,
                    {
                        tenant_id: "tenant",
                        session_type: "verification",
                        status: "fetched",
                    },
                ],
            ]);
        },
    );
});
