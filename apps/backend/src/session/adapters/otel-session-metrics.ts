import {
    Inject,
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import type { ObservableGauge, ObservableResult } from "@opentelemetry/api";
import { MetricService } from "nestjs-otel";
import { SessionStatus } from "../domain/session-state.js";
import {
    SESSION_REPOSITORY,
    type SessionCount,
    type SessionRepository,
} from "../ports/session.repository.js";

/** Minimum time between two database reads for the gauge. */
export const SESSION_METRICS_REFRESH_INTERVAL_MS = 30_000;

const SESSION_KINDS = ["issuance", "verification"] as const;

/**
 * The `sessions` gauge: current number of sessions per tenant, session type
 * and status, read from the database. Deleted sessions, restarts and several
 * replicas therefore cannot skew it; every replica reports the same values,
 * so dashboards aggregate with `max` per label set instead of `sum`.
 *
 * Collection never waits for the database: it reports the last snapshot and
 * starts a refresh in the background once that snapshot is older than
 * {@link SESSION_METRICS_REFRESH_INTERVAL_MS}.
 */
@Injectable()
export class OtelSessionMetrics implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(OtelSessionMetrics.name);
    private readonly gauge: ObservableGauge;
    private readonly callback = (result: ObservableResult) =>
        this.observe(result);
    private counts: SessionCount[] = [];
    /** Tenants of the previous snapshot, so their series drop to 0 once. */
    private previousTenants = new Set<string>();
    private refreshedAt = Number.NEGATIVE_INFINITY;
    private refreshing?: Promise<void>;

    constructor(
        metrics: MetricService,
        @Inject(SESSION_REPOSITORY)
        private readonly sessions: Pick<
            SessionRepository,
            "countSessionsByStatus"
        >,
    ) {
        this.gauge = metrics.getObservableGauge("sessions", {
            description: "Number of sessions by tenant, type and status",
        });
    }

    onModuleInit(): void {
        this.gauge.addCallback(this.callback);
        void this.refresh();
    }

    onModuleDestroy(): void {
        this.gauge.removeCallback(this.callback);
    }

    /** Reports the cached snapshot, zero-filled per tenant, type and status. */
    observe(result: ObservableResult): void {
        if (
            Date.now() - this.refreshedAt >=
            SESSION_METRICS_REFRESH_INTERVAL_MS
        )
            void this.refresh();
        const counts = new Map(
            this.counts.map((entry) => [
                key(entry.tenantId, entry.kind, entry.status),
                entry.count,
            ]),
        );
        const tenants = new Set([
            ...this.previousTenants,
            ...this.counts.map((entry) => entry.tenantId),
        ]);
        for (const tenantId of tenants) {
            for (const kind of SESSION_KINDS) {
                for (const status of Object.values(SessionStatus)) {
                    result.observe(
                        counts.get(key(tenantId, kind, status)) ?? 0,
                        {
                            tenant_id: tenantId,
                            session_type: kind,
                            status,
                        },
                    );
                }
            }
        }
    }

    /** Reads the counts once at a time; a failed read keeps the last snapshot. */
    refresh(): Promise<void> {
        this.refreshing ??= this.sessions
            .countSessionsByStatus()
            .then((counts) => {
                this.previousTenants = new Set(
                    this.counts.map((entry) => entry.tenantId),
                );
                this.counts = counts;
            })
            .catch((error: unknown) => {
                this.logger.warn(
                    `Failed to read session counts for metrics: ${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
                this.refreshedAt = Date.now();
                this.refreshing = undefined;
            });
        return this.refreshing;
    }
}

function key(tenantId: string, kind: string, status: string): string {
    return JSON.stringify([tenantId, kind, status]);
}
