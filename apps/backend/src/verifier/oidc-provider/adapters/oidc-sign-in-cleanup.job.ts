import {
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import {
    OIDC_SIGN_IN_REPOSITORY,
    type OidcSignInRepository,
} from "../ports/oidc-sign-in.repository.js";

/** How often expired sign-ins are deleted. */
export const OIDC_SIGN_IN_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Deletes expired sign-ins. Deletes are idempotent, so every replica may run
 * the job.
 */
@Injectable()
export class OidcSignInCleanupJob implements OnApplicationBootstrap {
    private readonly logger = new Logger(OidcSignInCleanupJob.name);

    constructor(
        private readonly scheduler: SchedulerRegistry,
        @Inject(OIDC_SIGN_IN_REPOSITORY)
        private readonly signIns: Pick<OidcSignInRepository, "deleteExpired">,
    ) {}

    onApplicationBootstrap(): void {
        const interval = setInterval(() => {
            void this.cleanup();
        }, OIDC_SIGN_IN_CLEANUP_INTERVAL_MS);
        interval.unref();
        this.scheduler.addInterval("tidyUpOidcSignIns", interval);
    }

    async cleanup(): Promise<void> {
        try {
            const deleted = await this.signIns.deleteExpired(new Date());
            if (deleted > 0) {
                this.logger.debug(`Deleted ${deleted} expired sign-in(s)`);
            }
        } catch (error) {
            this.logger.warn(
                `Sign-in cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
