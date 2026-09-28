import {
    Inject,
    Injectable,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CleanupSessions } from "../application/cleanup-sessions.js";
import { InitializeSessionMetrics } from "../application/initialize-session-metrics.js";

export const SESSION_MAINTENANCE_SETTINGS = Symbol(
    "SESSION_MAINTENANCE_SETTINGS",
);
export interface SessionMaintenanceSettings {
    cleanupIntervalMs: number;
}

/** Framework scheduling only; use cases own maintenance policy and orchestration. */
@Injectable()
export class SessionMaintenanceJob implements OnApplicationBootstrap {
    constructor(
        private readonly scheduler: SchedulerRegistry,
        private readonly cleanup: CleanupSessions,
        private readonly initializeMetrics: InitializeSessionMetrics,
        @Inject(SESSION_MAINTENANCE_SETTINGS)
        private readonly settings: SessionMaintenanceSettings,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const interval = setInterval(() => {
            void this.cleanup.execute();
        }, this.settings.cleanupIntervalMs);
        this.scheduler.addInterval("tidyUpSessions", interval);
        await this.initializeMetrics.execute();
        await this.cleanup.execute();
    }
}
