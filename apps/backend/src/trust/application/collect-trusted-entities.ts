import {
    type DiscardedTrustList,
    isTrustListCurrent,
    OutdatedTrustListsError,
} from "../domain/trust-list-freshness.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    serviceTypeMatches,
    type TrustedEntity,
    type TrustListSource,
} from "../types.js";

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
        private readonly now: () => Date = () => new Date(),
    ) {}

    /**
     * Load every list of the source and keep the entities that offer an
     * accepted service type. A list that is no longer current
     * ({@link isTrustListCurrent}) is discarded on its own, so it adds no
     * trust; a list that cannot be loaded or verified still fails the whole
     * source.
     * @throws OutdatedTrustListsError when every list was discarded
     */
    async execute(source: TrustListSource): Promise<CollectedTrustedEntities> {
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
}
