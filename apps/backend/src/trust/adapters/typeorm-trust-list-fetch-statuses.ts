import type { Repository } from "typeorm";
import { TrustListFetchStatusEntity } from "../entities/trust-list-fetch-status.entity.js";
import type {
    TrustListFetchResult,
    TrustListFetchStatus,
    TrustListFetchStatuses,
} from "../ports/trust-list-fetch-statuses.js";

/** Longest reason kept; reasons are fixed texts with a URL at most. */
const MAX_REASON_LENGTH = 1000;

/**
 * Keeps one row per tenant and list URL in `trust_list_fetch_status`. Values
 * left undefined in a write keep what the row held, so a failed fetch keeps
 * the details of the last verified one.
 */
export class TypeOrmTrustListFetchStatuses implements TrustListFetchStatuses {
    constructor(
        private readonly statuses: Repository<TrustListFetchStatusEntity>,
    ) {}

    async record(result: TrustListFetchResult, at: Date): Promise<void> {
        const verified = result.list;
        await this.statuses.upsert(
            {
                tenantId: result.tenantId,
                url: result.url,
                trustListId: result.trustListId ?? null,
                outcome: result.outcome,
                reason: result.reason?.slice(0, MAX_REASON_LENGTH) ?? null,
                checkedAt: at,
                ...(verified
                    ? {
                          verifiedAt: at,
                          nextUpdate: verified.nextUpdate ?? null,
                          sequenceNumber: verified.sequenceNumber ?? null,
                          entities: verified.entities,
                      }
                    : {}),
                ...(result.outcome === "accepted" ? { acceptedAt: at } : {}),
            },
            ["tenantId", "url"],
        );
    }

    async list(tenantId: string): Promise<TrustListFetchStatus[]> {
        const rows = await this.statuses.find({
            where: { tenantId },
            order: { checkedAt: "DESC", url: "ASC" },
        });
        return rows.map(
            ({ tenantId: _tenant, tenant: _relation, ...status }) => ({
                ...status,
                verifiedAt: status.verifiedAt ?? null,
                acceptedAt: status.acceptedAt ?? null,
            }),
        );
    }
}
