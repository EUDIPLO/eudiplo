import { Injectable } from "@nestjs/common";
import type { UpDownCounter } from "@opentelemetry/api";
import { MetricService } from "nestjs-otel";
import {
    type SessionLifecycleContext,
    SessionStatus,
} from "../domain/session-state.js";
import type { SessionMetrics } from "../ports/session-metrics.js";

@Injectable()
export class OtelSessionMetrics implements SessionMetrics {
    private readonly gauge: UpDownCounter;
    constructor(metrics: MetricService) {
        this.gauge = metrics.getUpDownCounter("sessions", {
            description: "Total number of sessions by status",
        });
    }

    recordCreated(session: SessionLifecycleContext): void {
        this.recordInitialCount(
            session.tenantId,
            session.requestId ? "verification" : "issuance",
            SessionStatus.Active,
            1,
        );
    }

    recordStateChange(
        session: SessionLifecycleContext,
        status: SessionStatus,
    ): void {
        const kind = session.requestId ? "verification" : "issuance";
        // Preserve the existing counts, including the active decrement when
        // the caller supplies a fetched/already-terminal session.
        this.recordInitialCount(session.tenantId, kind, status, 1);
        this.recordInitialCount(
            session.tenantId,
            kind,
            SessionStatus.Active,
            -1,
        );
    }

    recordInitialCount(
        tenantId: string,
        kind: "issuance" | "verification",
        status: SessionStatus,
        count: number,
    ): void {
        this.gauge.add(count, {
            tenant_id: tenantId,
            session_type: kind,
            status,
        });
    }
}
