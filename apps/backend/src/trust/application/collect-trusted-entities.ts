import {
    type DiscardedTrustList,
    isTrustListCurrent,
    OutdatedTrustListsError,
} from "../domain/trust-list-freshness.js";
import {
    isSupersededTrustList,
    isTrustListSequenceNumber,
} from "../domain/trust-list-sequence.js";
import type { AcceptedTrustListSequenceNumbers } from "../ports/accepted-trust-list-sequence-numbers.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    serviceTypeMatches,
    type TrustedEntity,
    type TrustListRef,
    type TrustListSource,
} from "../types.js";

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

export class CollectTrustedEntities {
    constructor(
        private readonly lists: TrustListProvider,
        private readonly sequenceNumbers: AcceptedTrustListSequenceNumbers,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /**
     * Load every list of the source and keep the entities that offer an
     * accepted service type. A list is discarded on its own, so it adds no
     * trust, when it is no longer current ({@link isTrustListCurrent}), has
     * no usable `LoTESequenceNumber`, or is numbered lower than a list
     * accepted before from the same URL by the source's tenant (an older
     * version, possibly replayed). An accepted list raises the number
     * remembered for its URL. A list that cannot be loaded or verified still
     * fails the whole source.
     * @throws OutdatedTrustListsError when every list was discarded
     */
    async execute(
        source: LoadedTrustListSource,
    ): Promise<CollectedTrustedEntities> {
        const entities: TrustedEntity[] = [];
        const discarded: DiscardedTrustList[] = [];
        let nextUpdate: string | undefined;
        for (const ref of source.lotes) {
            // One list at a time: a source's lists come from tenant
            // configuration without a count limit, so this bounds the
            // outbound requests and list bodies in memory per request, and
            // the first failing list in source order decides the error.
            const list: VerifiedTrustList = await this.lists.loadVerified(ref); // NOSONAR: sequential on purpose, see above
            if (!isTrustListCurrent(list.nextUpdate, this.now())) {
                discarded.push({ list: ref.url, nextUpdate: list.nextUpdate });
                continue;
            }
            const older = await this.checkSequenceNumber(
                source.tenantId,
                ref,
                list.nextUpdate,
                list.sequenceNumber,
            );
            if (older) {
                discarded.push(older);
                continue;
            }
            if (
                nextUpdate === undefined ||
                Date.parse(list.nextUpdate) < Date.parse(nextUpdate)
            ) {
                nextUpdate = list.nextUpdate;
            }
            entities.push(
                ...list.entities.filter(
                    (entity) =>
                        !source.acceptedServiceTypes ||
                        entity.services.some((service) =>
                            source.acceptedServiceTypes!.some((accepted) =>
                                serviceTypeMatches(
                                    service.serviceTypeIdentifier,
                                    accepted,
                                ),
                            ),
                        ),
                ),
            );
        }
        if (discarded.length > 0 && discarded.length === source.lotes.length) {
            throw new OutdatedTrustListsError(discarded);
        }
        return { nextUpdate, entities, discarded };
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
