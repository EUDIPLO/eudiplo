import { Inject, Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TypeOrmDpopProofReplayRegistry } from "./typeorm-dpop-proof-replay-registry.js";

/** Removes expired DPoP proof `jti` entries. */
@Injectable()
export class DpopProofJtiCleanupJob {
    constructor(
        @Inject(TypeOrmDpopProofReplayRegistry)
        private readonly proofs: TypeOrmDpopProofReplayRegistry,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES)
    cleanup(): void {
        void this.proofs.deleteExpired(new Date());
    }
}
