import {
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import {
    CHAINED_AS_SESSION_REPOSITORY,
    type ChainedAsSessionRepository,
} from "../ports/chained-as-session.repository.js";

export const CHAINED_AS_SESSION_CLEANUP_SETTINGS = Symbol(
    "CHAINED_AS_SESSION_CLEANUP_SETTINGS",
);
export interface ChainedAsSessionCleanupSettings {
    cleanupIntervalMs: number;
}

/**
 * Deletes expired sessions of the chained and OID4VP authorization servers on
 * the session tidy-up interval. Deletes are idempotent, so every replica may
 * run the job.
 */
@Injectable()
export class ChainedAsSessionCleanupJob implements OnApplicationBootstrap {
    private readonly logger = new Logger(ChainedAsSessionCleanupJob.name);

    constructor(
        private readonly scheduler: SchedulerRegistry,
        @Inject(CHAINED_AS_SESSION_REPOSITORY)
        private readonly sessions: Pick<
            ChainedAsSessionRepository,
            "deleteExpired"
        >,
        @Inject(CHAINED_AS_SESSION_CLEANUP_SETTINGS)
        private readonly settings: ChainedAsSessionCleanupSettings,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const interval = setInterval(() => {
            void this.cleanup();
        }, this.settings.cleanupIntervalMs);
        this.scheduler.addInterval("tidyUpChainedAsSessions", interval);
        await this.cleanup();
    }

    async cleanup(): Promise<void> {
        try {
            const deleted = await this.sessions.deleteExpired(new Date());
            if (deleted > 0) {
                this.logger.debug(
                    `Deleted ${deleted} expired chained authorization server session(s)`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `Chained authorization server session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
