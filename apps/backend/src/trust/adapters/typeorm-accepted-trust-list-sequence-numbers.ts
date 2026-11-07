import { LessThan, type Repository } from "typeorm";
import { TrustListSequenceNumberEntity } from "../entities/trust-list-sequence-number.entity.js";
import type { AcceptedTrustListSequenceNumbers } from "../ports/accepted-trust-list-sequence-numbers.js";

/**
 * Keeps the numbers in `trust_list_sequence_number`, one row per tenant and
 * list URL. A write only ever raises a number, so instances that accept lists
 * at the same time never lower what another one recorded.
 */
export class TypeOrmAcceptedTrustListSequenceNumbers
    implements AcceptedTrustListSequenceNumbers
{
    constructor(
        private readonly numbers: Repository<TrustListSequenceNumberEntity>,
    ) {}

    async highest(tenantId: string, url: string): Promise<number | undefined> {
        const row = await this.numbers.findOneBy({ tenantId, url });
        return row?.sequenceNumber;
    }

    async record(
        tenantId: string,
        url: string,
        sequenceNumber: number,
    ): Promise<void> {
        // Create the row unless it exists (ON CONFLICT DO NOTHING / INSERT OR
        // IGNORE), then raise it if it holds a lower number.
        await this.numbers
            .createQueryBuilder()
            .insert()
            .into(TrustListSequenceNumberEntity)
            .values({ tenantId, url, sequenceNumber })
            .orIgnore()
            .execute();
        await this.numbers.update(
            { tenantId, url, sequenceNumber: LessThan(sequenceNumber) },
            { sequenceNumber },
        );
    }

    async forgetTenant(tenantId: string): Promise<void> {
        await this.numbers.delete({ tenantId });
    }
}
