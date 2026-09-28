import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";
import { DeferredTransactionEntity } from "../entities/deferred-transaction.entity.js";
import type {
    DeferredTransactionData,
    DeferredTransactionRepository,
} from "../ports/deferred-transaction.repository.js";

export class TypeOrmDeferredTransactionRepository
    implements DeferredTransactionRepository
{
    constructor(
        @InjectRepository(DeferredTransactionEntity)
        private readonly repository: Repository<DeferredTransactionEntity>,
    ) {}

    async create(transaction: DeferredTransactionData): Promise<void> {
        await this.repository.save(this.repository.create(transaction));
    }

    async findPending(tenantId: string, transactionId: string) {
        return this.findByStatus(
            tenantId,
            transactionId,
            DeferredTransactionStatus.Pending,
        );
    }

    async find(tenantId: string, transactionId: string) {
        return this.map(
            await this.repository.findOneBy({ tenantId, transactionId }),
        );
    }

    async markReady(
        tenantId: string,
        transactionId: string,
        credential: string,
    ) {
        await this.repository.update(
            { tenantId, transactionId },
            { status: DeferredTransactionStatus.Ready, credential },
        );
        return this.find(tenantId, transactionId).then((transaction) => {
            if (!transaction)
                throw new Error("Deferred transaction disappeared");
            return transaction;
        });
    }

    async markFailed(
        tenantId: string,
        transactionId: string,
        errorMessage: string,
    ) {
        await this.repository.update(
            { tenantId, transactionId },
            { status: DeferredTransactionStatus.Failed, errorMessage },
        );
        return this.find(tenantId, transactionId).then((transaction) => {
            if (!transaction)
                throw new Error("Deferred transaction disappeared");
            return transaction;
        });
    }

    async markRetrieved(
        tenantId: string,
        transactionId: string,
    ): Promise<boolean> {
        const result = await this.repository.update(
            {
                tenantId,
                transactionId,
                status: DeferredTransactionStatus.Ready,
            },
            { status: DeferredTransactionStatus.Retrieved },
        );
        return (result.affected ?? 0) > 0;
    }

    async markExpired(tenantId: string, transactionId: string): Promise<void> {
        await this.repository.update(
            { tenantId, transactionId },
            { status: DeferredTransactionStatus.Expired },
        );
    }

    async deleteExpired(now: Date): Promise<void> {
        await this.repository.delete({ expiresAt: LessThan(now) });
    }

    private async findByStatus(
        tenantId: string,
        transactionId: string,
        status: DeferredTransactionStatus,
    ) {
        return this.map(
            await this.repository.findOneBy({
                tenantId,
                transactionId,
                status,
            }),
        );
    }

    private map(
        transaction: DeferredTransactionEntity | null,
    ): DeferredTransactionData | null {
        if (!transaction) return null;
        return {
            transactionId: transaction.transactionId,
            tenantId: transaction.tenantId,
            sessionId: transaction.sessionId,
            credentialConfigurationId: transaction.credentialConfigurationId,
            issuanceSetId: transaction.issuanceSetId,
            holderCnf: transaction.holderCnf,
            status: transaction.status,
            credential: transaction.credential,
            errorMessage: transaction.errorMessage,
            interval: transaction.interval,
            expiresAt: transaction.expiresAt,
        };
    }
}
