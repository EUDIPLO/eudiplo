import { addTrustListCertificates } from "../domain/trust-list-certificate-limit.js";
import {
    type DiscardedTrustList,
    hasUnavailableTrustList,
    isTrustListCurrent,
    OutdatedTrustListsError,
    UnavailableTrustedListsError,
} from "../domain/trust-list-freshness.js";
import {
    isSupersededTrustList,
    isTrustListSequenceNumber,
} from "../domain/trust-list-sequence.js";
import {
    MAX_FOLLOWED_TRUSTED_LISTS,
    TooManyTrustedListsError,
} from "../domain/trusted-list-services.js";
import type { AcceptedTrustListSequenceNumbers } from "../ports/accepted-trust-list-sequence-numbers.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    isTrustedListRef,
    offersAcceptedService,
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
    /**
     * Lists left out because they are not current, or, reached through a
     * list of trusted lists, could not be loaded; in source order.
     */
    discarded: DiscardedTrustList[];
}

/** What the lists of a source have added so far. */
interface Collection {
    entities: TrustedEntity[];
    discarded: DiscardedTrustList[];
    nextUpdate?: string;
    certificates: number;
    /** Lists accepted that can name issuers: all but lists of trusted lists. */
    accepted: number;
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
     * no usable sequence number (`LoTESequenceNumber`, or `TSLSequenceNumber`
     * of an ETSI TS 119 612 Trusted List), or is numbered lower than a list
     * accepted before from the same URL by the source's tenant (an older
     * version, possibly replayed). An accepted list raises the number
     * remembered for its URL. A list that cannot be loaded or verified still
     * fails the whole source, and so do lists that together hold more than
     * `MAX_TRUST_LIST_CERTIFICATES` certificates for the entities kept;
     * the lists after the one that goes over the limit are not loaded. The
     * number of that list is remembered all the same: it is signed, so an
     * older version of the list cannot be replayed once the source fits again.
     *
     * A Trusted List of type list of trusted lists (LOTL) names no issuers;
     * once accepted, the national lists it points to are loaded one level
     * deep, each verified with the certificates the LOTL publishes for it and
     * checked like any list. Such a list that cannot be loaded or verified is
     * discarded on its own, so one unreachable list does not stop the others.
     * An outdated LOTL is discarded with the lists it points to.
     * @throws OutdatedTrustListsError when every list was discarded as not
     * current
     * @throws UnavailableTrustedListsError when every list was discarded and
     * a Trusted List among them could not be loaded
     * @throws TooManyTrustListCertificatesError when the entities kept hold
     * more than `MAX_TRUST_LIST_CERTIFICATES` certificates
     * @throws TooManyTrustedListsError when a LOTL points to more than
     * `MAX_FOLLOWED_TRUSTED_LISTS` lists to follow
     */
    async execute(
        source: LoadedTrustListSource,
    ): Promise<CollectedTrustedEntities> {
        const collection: Collection = {
            entities: [],
            discarded: [],
            certificates: 0,
            accepted: 0,
        };
        for (const ref of source.lotes) {
            // One list at a time: a source's lists come from tenant
            // configuration without a count limit, so this bounds the
            // outbound requests and list bodies in memory per request, and
            // the first failing list in source order decides the error.
            const list: VerifiedTrustList = await this.lists.loadVerified(ref); // NOSONAR: sequential on purpose, see above
            const accepted = await this.accept(source, ref, list, collection);
            if (accepted && list.pointers) {
                await this.follow(source, ref, list.pointers, collection);
            }
        }
        const { entities, discarded, nextUpdate } = collection;
        if (discarded.length > 0 && collection.accepted === 0) {
            throw hasUnavailableTrustList(discarded)
                ? new UnavailableTrustedListsError(discarded)
                : new OutdatedTrustListsError(discarded);
        }
        return { nextUpdate, entities, discarded };
    }

    /**
     * Load the lists a LOTL points to, one at a time like the source's own
     * lists, discarding each that cannot be loaded. Their own pointers are
     * not followed.
     */
    private async follow(
        source: LoadedTrustListSource,
        lotl: TrustListRef,
        pointers: TrustListRef[],
        collection: Collection,
    ) {
        if (pointers.length > MAX_FOLLOWED_TRUSTED_LISTS) {
            throw new TooManyTrustedListsError(lotl.url, pointers.length);
        }
        for (const ref of pointers) {
            let list: VerifiedTrustList;
            try {
                list = await this.lists.loadVerified(ref); // NOSONAR: sequential on purpose, see execute
            } catch (error) {
                collection.discarded.push({
                    list: ref.url,
                    nextUpdate: undefined,
                    trustedList: true,
                    unavailable:
                        error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            await this.accept(
                source,
                ref,
                { ...list, pointers: undefined },
                collection,
            );
        }
    }

    /**
     * Add the list's entities of an accepted service type to the collection,
     * or discard the list when it is not current or older than one accepted
     * before. Returns whether it was accepted.
     */
    private async accept(
        source: LoadedTrustListSource,
        ref: LoadedTrustListRef,
        list: VerifiedTrustList,
        collection: Collection,
    ): Promise<boolean> {
        const trustedList = isTrustedListRef(ref) ? { trustedList: true } : {};
        if (!isTrustListCurrent(list.nextUpdate, this.now())) {
            collection.discarded.push({
                list: ref.url,
                nextUpdate: list.nextUpdate,
                ...trustedList,
            });
            return false;
        }
        const older = await this.checkSequenceNumber(
            source.tenantId,
            ref,
            list.nextUpdate,
            list.sequenceNumber,
        );
        if (older) {
            collection.discarded.push({ ...older, ...trustedList });
            return false;
        }
        if (
            collection.nextUpdate === undefined ||
            Date.parse(list.nextUpdate) < Date.parse(collection.nextUpdate)
        ) {
            collection.nextUpdate = list.nextUpdate;
        }
        if (list.pointers) return true;
        collection.accepted++;
        const kept = list.entities.filter((entity) =>
            offersAcceptedService(entity, source.acceptedServiceTypes),
        );
        collection.certificates = addTrustListCertificates(
            collection.certificates,
            ref.url,
            kept,
        );
        collection.entities.push(...kept);
        return true;
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
