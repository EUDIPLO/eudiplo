import {
    Injectable,
    Logger,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { TRUST_LIST_RENEWAL_CHECK_INTERVAL_MS } from "../domain/trust-list-validity.js";
import { TrustListService } from "../trustlist.service.js";

/**
 * Framework scheduling only; {@link TrustListService.renewDueTrustLists} owns
 * the renewal policy and is safe to run on several replicas.
 */
@Injectable()
export class TrustListRenewalJob implements OnApplicationBootstrap {
    private readonly logger = new Logger(TrustListRenewalJob.name);

    constructor(
        private readonly scheduler: SchedulerRegistry,
        private readonly trustLists: TrustListService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const interval = setInterval(() => {
            void this.renew();
        }, TRUST_LIST_RENEWAL_CHECK_INTERVAL_MS);
        this.scheduler.addInterval("renewTrustLists", interval);
        // Lists that expired while no instance was running are renewed at startup.
        await this.renew();
    }

    private async renew(): Promise<void> {
        try {
            await this.trustLists.renewDueTrustLists();
        } catch (error) {
            this.logger.error(`Trust list renewal failed: ${error}`);
        }
    }
}
