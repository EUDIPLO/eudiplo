import { Inject, Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
    DEFERRED_TRANSACTION_REPOSITORY,
    type DeferredTransactionRepository,
} from "../ports/deferred-transaction.repository.js";

/** Deletes expired deferred transactions every hour. */
@Injectable()
export class DeferredTransactionCleanupJob {
    constructor(
        @Inject(DEFERRED_TRANSACTION_REPOSITORY)
        private readonly transactions: DeferredTransactionRepository,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async cleanup(): Promise<void> {
        await this.transactions.deleteExpired(new Date());
    }
}
