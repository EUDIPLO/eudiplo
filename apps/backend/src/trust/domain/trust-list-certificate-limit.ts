import type { TrustedEntity } from "../types.js";

/**
 * The most certificates the trust lists of one source may list, all lists
 * together, counting every certificate of the entities kept from them.
 *
 * Each check of a credential, presentation or attestation against a source
 * parses all of its certificates and puts them in the pool that the
 * certificate path is built from, at about 0.15 ms per certificate. A list
 * may be up to 10 MiB, room for some 25,000 certificates, and a source has
 * any number of lists; without a limit, whoever publishes one of them, or a
 * tenant through a managed list, would decide how long every check takes on
 * the shared instance.
 */
export const MAX_TRUST_LIST_CERTIFICATES = 1000;

/**
 * The certificates of a source once the `entities` kept from `list` are
 * added to the `before` of the lists before it, counting every service of
 * each entity.
 * @throws TooManyTrustListCertificatesError when that is more than
 * {@link MAX_TRUST_LIST_CERTIFICATES}
 */
export function addTrustListCertificates(
    before: number,
    list: string,
    entities: readonly TrustedEntity[],
): number {
    const certificates = entities.reduce(
        (count, entity) => count + entity.services.length,
        before,
    );
    if (certificates > MAX_TRUST_LIST_CERTIFICATES) {
        throw new TooManyTrustListCertificatesError(list, certificates);
    }
    return certificates;
}

/**
 * The trust lists of a source list more than
 * {@link MAX_TRUST_LIST_CERTIFICATES} certificates. The source is not used,
 * as when one of its lists cannot be loaded.
 */
export class TooManyTrustListCertificatesError extends Error {
    /**
     * @param list The list whose certificates went over the limit
     * @param certificates The certificates of the source up to and including
     * that list
     */
    constructor(
        readonly list: string,
        readonly certificates: number,
    ) {
        super(
            `Trust list ${list} brings the certificates of its source to ${certificates}; at most ${MAX_TRUST_LIST_CERTIFICATES} are accepted`,
        );
        this.name = "TooManyTrustListCertificatesError";
    }
}
