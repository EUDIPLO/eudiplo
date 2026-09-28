import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    serviceTypeMatches,
    type TrustedEntity,
    type TrustListSource,
} from "../types.js";

export class CollectTrustedEntities {
    constructor(private readonly lists: TrustListProvider) {}
    async execute(source: TrustListSource): Promise<VerifiedTrustList> {
        const entities: TrustedEntity[] = [];
        let nextUpdate: string | undefined;
        for (const ref of source.lotes) {
            const list = await this.lists.loadVerified(ref);
            nextUpdate = nextUpdate ?? list.nextUpdate;
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
        return { nextUpdate, entities };
    }
}
