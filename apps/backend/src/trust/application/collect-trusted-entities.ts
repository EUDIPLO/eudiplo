import { addTrustListCertificates } from "../domain/trust-list-certificate-limit.js";
import {
    type DiscardedTrustList,
    discardReason,
    isTrustListCurrent,
    OutdatedTrustListsError,
} from "../domain/trust-list-freshness.js";
import {
    isSupersededTrustList,
    isTrustListSequenceNumber,
} from "../domain/trust-list-sequence.js";
import type { AcceptedTrustListSequenceNumbers } from "../ports/accepted-trust-list-sequence-numbers.js";
import {
    NO_TRUST_LIST_FETCH_STATUSES,
    type TrustListFetchResult,
    type TrustListFetchStatuses,
} from "../ports/trust-list-fetch-statuses.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    offersAcceptedService,
    type TrustedEntity,
    type TrustListRef,
    type TrustListSource,
} from "../types.js";
import { discardOutcome, failureReason } from "./trust-list-fetch-result.js";

/** A list reference as the trust store loads it. */
export interface LoadedTrustListRef extends TrustListRef {
    /**
     * For a list this instance manages: its `LoTESequenceNumber` in storage,
     * read before the list is fetched. The fetched list must not be numbered
     * lower, and is compared with this number instead of the numbers
     * remembered per tenant and URL, which it does not change: the stored
     * number is always current, also for a list deleted and created again,
     * which starts at 1.
     */
    storedSequenceNumber?: number;
    /**
     * For a managed list named by ID, which is fetched from `INTERNAL_URL`:
     * its URL below `PUBLIC_URL`, under which its fetch result is recorded.
     */
    publicUrl?: string;
}

/** A trust list source whose managed lists carry their stored number. */
export type LoadedTrustListSource = Omit<TrustListSource, "lotes"> & {
    lotes: LoadedTrustListRef[];
};

/** Entities of the source's current lists, and the lists left out. */
export interface CollectedTrustedEntities {
    /**
     * Earliest `NextUpdate` of the current lists, after which the result must
     * not be used any more; set whenever a list is current.
     */
    nextUpdate?: string;
    entities: TrustedEntity[];
    /** Lists left out because they are not current, in source order. */
    discarded: DiscardedTrustList[];
}

/** Longest `NextUpdate` recorded; an ISO 8601 date-time is far shorter. */
const MAX_RECORDED_NEXT_UPDATE_LENGTH = 64;

/**
 * The list's `NextUpdate` as recorded: its publisher signs it, not the
 * tenant, so only a string of date-time length is kept and anything else
 * is recorded as null.
 */
function recordableNextUpdate(nextUpdate: unknown): string | null {
    return typeof nextUpdate === "string" &&
        nextUpdate.length <= MAX_RECORDED_NEXT_UPDATE_LENGTH
        ? nextUpdate
        : null;
}

export interface CollectTrustedEntitiesOptions {
    now?: () => Date;
    /** Where each list's result is recorded; nowhere by default. */
    fetchStatuses?: TrustListFetchStatuses;
    /** Told when a result cannot be recorded; loading goes on. */
    onRecordFailed?: (error: unknown) => void;
}

export class CollectTrustedEntities {
    private readonly now: () => Date;
    private readonly fetchStatuses: TrustListFetchStatuses;
    private readonly onRecordFailed: (error: unknown) => void;

    constructor(
        private readonly lists: TrustListProvider,
        private readonly sequenceNumbers: AcceptedTrustListSequenceNumbers,
        options: CollectTrustedEntitiesOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.fetchStatuses =
            options.fetchStatuses ?? NO_TRUST_LIST_FETCH_STATUSES;
        this.onRecordFailed = options.onRecordFailed ?? (() => {});
    }

    /**
     * Load every list of the source and keep the entities that offer an
     * accepted service type. A list is discarded on its own, so it adds no
     * trust, when it is no longer current ({@link isTrustListCurrent}), has
     * no usable `LoTESequenceNumber`, or is numbered lower than a list
     * accepted before from the same URL by the source's tenant (an older
     * version, possibly replayed). An accepted list raises the number
     * remembered for its URL. A list that cannot be loaded or verified still
     * fails the whole source, and so do lists that together hold more than
     * `MAX_TRUST_LIST_CERTIFICATES` certificates for the entities kept;
     * the lists after the one that goes over the limit are not loaded. The
     * number of that list is remembered all the same: it is signed, so an
     * older version of the list cannot be replayed once the source fits again.
     * How each loaded list ended is recorded per tenant and URL
     * ({@link TrustListFetchStatuses}); the lists not loaded are not.
     * @throws OutdatedTrustListsError when every list was discarded
     * @throws TooManyTrustListCertificatesError when the entities kept hold
     * more than `MAX_TRUST_LIST_CERTIFICATES` certificates
     */
    async execute(
        source: LoadedTrustListSource,
    ): Promise<CollectedTrustedEntities> {
        const entities: TrustedEntity[] = [];
        const discarded: DiscardedTrustList[] = [];
        let nextUpdate: string | undefined;
        let certificates = 0;
        for (const ref of source.lotes) {
            const record = (
                result: Omit<TrustListFetchResult, "tenantId" | "url">,
            ) => this.record(source.tenantId, ref, result);
            // One list at a time: a source's lists come from tenant
            // configuration without a count limit, so this bounds the
            // outbound requests and list bodies in memory per request, and
            // the first failing list in source order decides the error.
            let list: VerifiedTrustList;
            try {
                list = await this.lists.loadVerified(ref); // NOSONAR: sequential on purpose, see above
            } catch (error) {
                await record(failureReason(error));
                throw error;
            }
            const verified = {
                nextUpdate: recordableNextUpdate(list.nextUpdate),
                sequenceNumber: isTrustListSequenceNumber(list.sequenceNumber)
                    ? list.sequenceNumber
                    : undefined,
                entities: list.entities.length,
            };
            const discard = async (entry: DiscardedTrustList) => {
                discarded.push(entry);
                await record({
                    outcome: discardOutcome(entry),
                    reason: discardReason(entry),
                    list: verified,
                });
            };
            if (!isTrustListCurrent(list.nextUpdate, this.now())) {
                await discard({ list: ref.url, nextUpdate: list.nextUpdate });
                continue;
            }
            const older = await this.checkSequenceNumber(
                source.tenantId,
                ref,
                list.nextUpdate,
                list.sequenceNumber,
            );
            if (older) {
                await discard(older);
                continue;
            }
            if (
                nextUpdate === undefined ||
                Date.parse(list.nextUpdate) < Date.parse(nextUpdate)
            ) {
                nextUpdate = list.nextUpdate;
            }
            const kept = list.entities.filter((entity) =>
                offersAcceptedService(entity, source.acceptedServiceTypes),
            );
            try {
                certificates = addTrustListCertificates(
                    certificates,
                    // The error names the list; it is recorded for the
                    // tenant, so never by its INTERNAL_URL.
                    ref.publicUrl ?? ref.url,
                    kept,
                );
            } catch (error) {
                await record({ ...failureReason(error), list: verified });
                throw error;
            }
            await record({ outcome: "accepted", list: verified });
            entities.push(...kept);
        }
        if (discarded.length > 0 && discarded.length === source.lotes.length) {
            throw new OutdatedTrustListsError(discarded);
        }
        return { nextUpdate, entities, discarded };
    }

    /** Record a list's result; a failure to record does not fail the load. */
    private async record(
        tenantId: string,
        ref: LoadedTrustListRef,
        result: Omit<TrustListFetchResult, "tenantId" | "url">,
    ): Promise<void> {
        try {
            await this.fetchStatuses.record(
                {
                    tenantId,
                    url: ref.publicUrl ?? ref.url,
                    ...(ref.trustListId === undefined
                        ? {}
                        : { trustListId: ref.trustListId }),
                    ...result,
                },
                this.now(),
            );
        } catch (error) {
            this.onRecordFailed(error);
        }
    }

    /**
     * The current list as discarded for its `LoTESequenceNumber`: none that
     * is usable, or one lower than the highest accepted before. Undefined when
     * the number is accepted; a number higher than the one remembered for the
     * list's URL is remembered from then on.
     */
    private async checkSequenceNumber(
        tenantId: string,
        ref: LoadedTrustListRef,
        nextUpdate: string,
        sequenceNumber: unknown,
    ): Promise<DiscardedTrustList | undefined> {
        if (!isTrustListSequenceNumber(sequenceNumber)) {
            return {
                list: ref.url,
                nextUpdate,
                sequence: { number: sequenceNumber },
            };
        }
        const managed = ref.storedSequenceNumber !== undefined;
        const highestAccepted = managed
            ? ref.storedSequenceNumber
            : await this.sequenceNumbers.highest(tenantId, ref.url);
        if (isSupersededTrustList(sequenceNumber, highestAccepted)) {
            return {
                list: ref.url,
                nextUpdate,
                sequence: {
                    number: sequenceNumber,
                    highestAccepted,
                    ...(managed ? { stored: true } : {}),
                },
            };
        }
        if (
            !managed &&
            (highestAccepted === undefined || sequenceNumber > highestAccepted)
        ) {
            await this.sequenceNumbers.record(
                tenantId,
                ref.url,
                sequenceNumber,
            );
        }
        return undefined;
    }
}
