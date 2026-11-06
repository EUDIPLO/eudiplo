import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import { TrustListService } from "../issuer/trust-list/trustlist.service.js";
import {
    type CollectedTrustedEntities,
    CollectTrustedEntities,
} from "./application/collect-trusted-entities.js";
import {
    type DiscardedTrustList,
    describeDiscardedTrustLists,
    isTrustListCurrent,
    OutdatedTrustListsError,
} from "./domain/trust-list-freshness.js";
import { LoteParserService } from "./lote-parser.service.js";
import {
    TRUST_STORE_SETTINGS,
    type TrustStoreSettings,
} from "./trust-store-settings.js";
import { TrustedEntity, TrustListRef, TrustListSource } from "./types.js";

/**
 * Built trust store with TrustedEntities preserving service groupings, the
 * lists left out as outdated (name them when a certificate is not trusted, so
 * operators can tell a lapsed list from a missing entry) and when it was
 * fetched.
 */
export type BuiltTrustStore = CollectedTrustedEntities & { fetchedAt: number };

/**
 * How long a source whose lists are all outdated is answered without fetching
 * them again, so lapsed lists are not fetched once per request.
 */
const OUTDATED_RETRY_MS = 60 * 1000;

@Injectable()
export class TrustStoreService {
    private readonly logger = new Logger(TrustStoreService.name);
    private readonly cache = new Map<string, BuiltTrustStore>();
    private readonly outdated = new Map<
        string,
        { error: OutdatedTrustListsError; until: number }
    >();

    constructor(
        private readonly collectTrustedEntities: CollectTrustedEntities,
        private readonly trustListService: TrustListService,
        @Inject(TRUST_STORE_SETTINGS)
        private readonly settings: TrustStoreSettings,
        private readonly loteParser: LoteParserService,
    ) {}

    /**
     * Fetch, verify and filter the source's lists, or reuse the cached result
     * for `cacheTtlMs` while its current lists stay current. Outdated lists
     * are left out ({@link BuiltTrustStore.discarded}) and logged. A source
     * whose lists are all outdated is rejected for one minute without
     * fetching them again.
     * @throws when a list cannot be fetched or verified, or when every list
     * is outdated (`OutdatedTrustListsError`); callers must fail closed
     */
    async getTrustStore(
        source: TrustListSource,
        cacheTtlMs = 5 * 60 * 1000,
    ): Promise<BuiltTrustStore> {
        // Resolve managed IDs at request time: configuration import may run before
        // trust-list import, and the selected signing certificate can rotate.
        source = {
            ...source,
            lotes: await Promise.all(
                source.lotes.map(async (ref) => {
                    if (ref.trustListId === undefined) return ref;
                    const id = ref.trustListId.trim();
                    if (!source.tenantId || !id) {
                        throw new Error(
                            "Managed trust lists require a tenant and a non-empty trustListId",
                        );
                    }
                    const verifierX509Der =
                        await this.trustListService.getVerifierX509Der(
                            source.tenantId,
                            id,
                        );
                    const baseUrl =
                        this.settings.internalUrl || this.settings.publicUrl;
                    return {
                        url: `${baseUrl.replace(/\/$/, "")}/issuers/${encodeURIComponent(source.tenantId)}/trust-list/${encodeURIComponent(id)}`,
                        verifierX509Der,
                    };
                }),
            ),
        };
        const cacheKey = this.buildCacheKey(source);
        const cached = this.cache.get(cacheKey);

        // A cached store whose earliest current list has reached its
        // NextUpdate is refetched: the list operator may have published a
        // newer one.
        if (
            cached &&
            Date.now() - cached.fetchedAt < cacheTtlMs &&
            (cached.nextUpdate === undefined ||
                isTrustListCurrent(cached.nextUpdate, new Date()))
        ) {
            return cached;
        }

        const outdated = this.outdated.get(cacheKey);
        if (outdated && Date.now() < outdated.until) {
            throw outdated.error;
        }

        let result: CollectedTrustedEntities;
        try {
            result = await this.collectTrustedEntities.execute(source);
        } catch (error) {
            if (error instanceof OutdatedTrustListsError) {
                this.warnDiscarded(error.discarded, "no current list is left");
                this.rememberOutdated(cacheKey, error);
            }
            throw error;
        }
        this.outdated.delete(cacheKey);
        if (result.discarded.length > 0) {
            this.warnDiscarded(result.discarded, "using the current lists");
        }
        const store: BuiltTrustStore = { fetchedAt: Date.now(), ...result };
        this.cache.set(cacheKey, store);

        this.logger.debug(
            `Built trust store with ${store.entities.length} trusted entit${store.entities.length === 1 ? "y" : "ies"}`,
        );
        return store;
    }

    /**
     * Trusted entities of a single trust list, for hints that do not decide
     * trust (DCQL `trusted_authorities` sent to the wallet). Managed lists are
     * read from their stored content; external lists are fetched and their
     * signature verified like in {@link getTrustStore}, sharing its cache.
     * Either way an outdated list throws {@link OutdatedTrustListsError}, so
     * no hint names issuers that verification leaves out with the list.
     */
    async getListedEntities(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<TrustedEntity[]> {
        if (ref.trustListId === undefined) {
            return (await this.getTrustStore({ tenantId, lotes: [ref] }))
                .entities;
        }
        const id = ref.trustListId.trim();
        const { data } = await this.trustListService.findOne(tenantId, id);
        if (!data) return [];
        // Stored as `{ LoTE: ... }`; lists created by older releases lack the wrapper.
        const lote = ((data as { LoTE?: LoTE }).LoTE ?? data) as LoTE;
        const nextUpdate = lote.ListAndSchemeInformation?.NextUpdate;
        if (!isTrustListCurrent(nextUpdate, new Date())) {
            // The caller logs the error with the list it names.
            throw new OutdatedTrustListsError([{ list: id, nextUpdate }]);
        }
        return this.loteParser.parse(lote).entities;
    }

    /**
     * Name discarded lists for operators; the errors that reach wallets do
     * not, see {@link OutdatedTrustListsError}.
     */
    private warnDiscarded(discarded: DiscardedTrustList[], effect: string) {
        this.logger.warn(
            `Discarded outdated trust list(s), ${effect}: ${describeDiscardedTrustLists(discarded)}`,
        );
    }

    /** Remember a rejected source, dropping entries that have run out. */
    private rememberOutdated(cacheKey: string, error: OutdatedTrustListsError) {
        const now = Date.now();
        for (const [key, entry] of this.outdated) {
            if (entry.until <= now) this.outdated.delete(key);
        }
        this.outdated.set(cacheKey, { error, until: now + OUTDATED_RETRY_MS });
    }

    /**
     * Clear the cached trust store.
     * Useful for testing or when trust lists are known to have changed.
     */
    clearCache(): void {
        this.cache.clear();
        this.outdated.clear();
    }

    private buildCacheKey(source: TrustListSource): string {
        return JSON.stringify({
            tenantId: source.tenantId,
            lotes: source.lotes.map((ref) => ({
                url: ref.url,
                verifierKey: ref.verifierKey ?? null,
                verifierKeyPem: ref.verifierKeyPem ?? null,
                verifierX509Der: ref.verifierX509Der ?? null,
            })),
            acceptedServiceTypes: source.acceptedServiceTypes ?? [],
        });
    }
}
