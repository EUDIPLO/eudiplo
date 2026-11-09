import {
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CheckWalletUnitStatus } from "../application/check-wallet-unit-status.js";

export const WALLET_UNIT_STATUS_CHECK_SETTINGS = Symbol(
    "WALLET_UNIT_STATUS_CHECK_SETTINGS",
);
export interface WalletUnitStatusCheckSettings {
    /** Seconds between two checks; 0 turns the check off. */
    intervalSeconds: number;
}

/**
 * Runs {@link CheckWalletUnitStatus} after startup and then every
 * `WALLET_UNIT_STATUS_CHECK_INTERVAL` seconds. Runs never overlap: a run
 * requested while one is going starts after it, and further requests in
 * that time share that next run.
 */
@Injectable()
export class WalletUnitStatusCheckJob implements OnApplicationBootstrap {
    private readonly logger = new Logger(WalletUnitStatusCheckJob.name);
    private current?: Promise<void>;
    private next?: Promise<void>;

    constructor(
        private readonly scheduler: SchedulerRegistry,
        private readonly check: CheckWalletUnitStatus,
        @Inject(WALLET_UNIT_STATUS_CHECK_SETTINGS)
        private readonly settings: WalletUnitStatusCheckSettings,
    ) {}

    onApplicationBootstrap(): void {
        if (this.settings.intervalSeconds <= 0) return;
        const interval = setInterval(() => {
            void this.run();
        }, this.settings.intervalSeconds * 1000);
        this.scheduler.addInterval("checkWalletUnitStatus", interval);
        // In the background, so that a slow provider does not delay startup.
        void this.run();
    }

    /** Resolves once a run that started after this call has finished. */
    run(): Promise<void> {
        if (!this.current) {
            this.current = this.execute().finally(() => {
                this.current = undefined;
            });
            return this.current;
        }
        this.next ??= this.current.then(() => {
            this.next = undefined;
            return this.run();
        });
        return this.next;
    }

    private async execute(): Promise<void> {
        try {
            await this.check.execute();
        } catch (error) {
            this.logger.error(
                `Wallet unit status check failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
