import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import { managedTrustListAt } from "../issuer/trust-list/domain/trust-list-reference.js";
import { TrustListService } from "../issuer/trust-list/trustlist.service.js";
import {
    type CollectedTrustedEntities,
    CollectTrustedEntities,
    type LoadedTrustListRef,
    type LoadedTrustListSource,
} from "./application/collect-trusted-entities.js";
import {
    addTrustListCertificates,
    TooManyTrustListCertificatesError,
} from "./domain/trust-list-certificate-limit.js";
import {
    type DiscardedTrustList,
    describeDiscardedTrustLists,
    isTrustListCurrent,
    OutdatedTrustListsError,
} from "./domain/trust-list-freshness.js";
import { LoteParserService } from "./lote-parser.service.js";
import {
    ACCEPTED_TRUST_LIST_SEQUENCE_NUMBERS,
    type AcceptedTrustListSequenceNumbers,
} from "./ports/accepted-trust-list-sequence-numbers.js";
import {
    TRUST_STORE_SETTINGS,
    type TrustStoreSettings,
} from "./trust-store-settings.js";
import {
    credentialIssuerServiceTypes,
    offersAcceptedService,
    TrustedEntity,
    TrustListRef,
    TrustListSource,
} from "./types.js";

/**
 * Built trust store with TrustedEntities preserving service groupings, the
 * lists left out as outdated (name them when a certificate is not trusted, so
 * operators can tell a lapsed list from a missing entry) and when it was
 * fetched.
 */
export type BuiltTrustStore = CollectedTrustedEntities & { fetchedAt: number };

/**
 * How long a source whose lists are all outdated, or hold more than
 * `MAX_TRUST_LIST_CERTIFICATES` certificates, is answered without fetching
 * them again, so such lists are not fetched once per request.
 */
const REFUSED_RETRY_MS = 60 * 1000;

/** Logged with lists numbered lower than one the tenant accepted before. */
const supersededHint = (tenantId: string) =>
    `. If the publisher of such a list numbered it from 1 again, DELETE /api/cache/trust-list/sequence-numbers as tenant ${JSON.stringify(tenantId)} forgets the numbers that tenant accepted`;

@Injectable()
export class TrustStoreService {
    private readonly logger = new Logger(TrustStoreService.name);
    private readonly cache = new Map<string, BuiltTrustStore>();
    private readonly refused = new Map<
        string,
        {
            error: OutdatedTrustListsError | TooManyTrustListCertificatesError;
            until: number;
        }
    >();

    constructor(
        private readonly collectTrustedEntities: CollectTrustedEntities,
        private readonly trustListService: TrustListService,
        @Inject(TRUST_STORE_SETTINGS)
        private readonly settings: TrustStoreSettings,
        private readonly loteParser: LoteParserService,
        @Inject(ACCEPTED_TRUST_LIST_SEQUENCE_NUMBERS)
        private readonly sequenceNumbers: AcceptedTrustListSequenceNumbers,
    ) {}

    /**
     * Fetch, verify and filter the source's lists, or reuse the cached result
     * for `cacheTtlMs` while its current lists stay current. Outdated lists,
     * also those numbered lower than a list accepted before, are left out
     * ({@link BuiltTrustStore.discarded}) and logged. A source whose lists
     * are all outdated, or hold more than `MAX_TRUST_LIST_CERTIFICATES`
     * certificates, is rejected for one minute without fetching them again.
     * @throws when a list cannot be fetched or verified, when every list is
     * outdated (`OutdatedTrustListsError`), or when the lists hold too many
     * certificates (`TooManyTrustListCertificatesError`); callers must fail
     * closed
     */
    async getTrustStore(
        source: TrustListSource,
        cacheTtlMs = 5 * 60 * 1000,
    ): Promise<BuiltTrustStore> {
        // Resolve managed IDs at request time: configuration import may run before
        // trust-list import, and the selected signing certificate can rotate.
        const loaded: LoadedTrustListSource = {
            ...source,
            lotes: await Promise.all(
                source.lotes.map((ref) =>
                    this.resolveReference(ref, source.tenantId),
                ),
            ),
        };
        const cacheKey = this.buildCacheKey(loaded);
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

        const refused = this.refused.get(cacheKey);
        if (refused && Date.now() < refused.until) {
            throw refused.error;
        }

        let result: CollectedTrustedEntities;
        try {
            result = await this.collectTrustedEntities.execute(loaded);
        } catch (error) {
            if (error instanceof OutdatedTrustListsError) {
                this.warnDiscarded(
                    loaded.tenantId,
                    error.discarded,
                    "no current list is left",
                );
                this.rememberRefused(cacheKey, error);
            }
            if (error instanceof TooManyTrustListCertificatesError) {
                this.rememberRefused(cacheKey, error);
            }
            throw error;
        }
        this.refused.delete(cacheKey);
        if (result.discarded.length > 0) {
            this.warnDiscarded(
                loaded.tenantId,
                result.discarded,
                "using the current lists",
            );
        }
        const store: BuiltTrustStore = { fetchedAt: Date.now(), ...result };
        this.cache.set(cacheKey, store);

        this.logger.debug(
            `Built trust store with ${store.entities.length} trusted entit${store.entities.length === 1 ? "y" : "ies"}`,
        );
        return store;
    }

    /**
     * The reference as {@link CollectTrustedEntities} loads it. A managed list
     * of this instance, named by `trustListId` or by a URL below `PUBLIC_URL`
     * or `INTERNAL_URL`, carries the sequence number it has in storage, read
     * before the list is fetched: EUDIPLO numbers a list it creates again
     * from 1, so it is compared with that number rather than with the
     * numbers remembered for the tenant.
     */
    private async resolveReference(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<LoadedTrustListRef> {
        if (ref.trustListId === undefined) {
            const managed = managedTrustListAt(
                ref.url,
                [this.settings.publicUrl, this.settings.internalUrl].filter(
                    (url): url is string => !!url,
                ),
            );
            if (!managed) return ref;
            // The list is public at its URL, so reading its number for
            // another tenant of this instance reveals nothing new.
            const storedSequenceNumber =
                await this.trustListService.getSequenceNumber(
                    managed.tenantId,
                    managed.id,
                );
            return storedSequenceNumber === undefined
                ? ref
                : { ...ref, storedSequenceNumber };
        }
        const id = ref.trustListId.trim();
        if (!tenantId || !id) {
            throw new Error(
                "Managed trust lists require a tenant and a non-empty trustListId",
            );
        }
        const { verifierX509Der, sequenceNumber } =
            await this.trustListService.getVerifierAndSequenceNumber(
                tenantId,
                id,
            );
        const baseUrl = this.settings.internalUrl || this.settings.publicUrl;
        return {
            url: `${baseUrl.replace(/\/$/, "")}/issuers/${encodeURIComponent(tenantId)}/trust-list/${encodeURIComponent(id)}`,
            verifierX509Der,
            storedSequenceNumber: sequenceNumber,
        };
    }

    /**
     * The entities of a single trust list that offer a credential issuer
     * service ({@link credentialIssuerServiceTypes}), as verification keeps
     * them, for hints that do not decide trust (DCQL `trusted_authorities`
     * sent to the wallet). Managed lists are read from their stored content;
     * external lists are fetched and their signature verified like in
     * {@link getTrustStore}, sharing its cache. Either way an outdated list
     * throws {@link OutdatedTrustListsError}, and one whose kept entities
     * hold more than `MAX_TRUST_LIST_CERTIFICATES` certificates
     * {@link TooManyTrustListCertificatesError}, so no hint names issuers
     * that verification leaves out with the list.
     */
    async getListedEntities(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<TrustedEntity[]> {
        if (ref.trustListId === undefined) {
            return (
                await this.getTrustStore({
                    tenantId,
                    lotes: [ref],
                    acceptedServiceTypes: [...credentialIssuerServiceTypes],
                })
            ).entities;
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
        const entities = this.loteParser
            .parse(lote)
            .entities.filter((entity) =>
                offersAcceptedService(entity, credentialIssuerServiceTypes),
            );
        addTrustListCertificates(0, id, entities);
        return entities;
    }

    /**
     * Name discarded lists for operators; the errors that reach wallets do
     * not, see {@link OutdatedTrustListsError}.
     */
    private warnDiscarded(
        tenantId: string,
        discarded: DiscardedTrustList[],
        effect: string,
    ) {
        // Forgetting the remembered numbers only helps lists not managed here.
        const superseded = discarded.some(
            (entry) =>
                entry.sequence?.highestAccepted !== undefined &&
                !entry.sequence.stored,
        );
        this.logger.warn(
            `Discarded outdated trust list(s), ${effect}: ${describeDiscardedTrustLists(discarded)}${superseded ? supersededHint(tenantId) : ""}`,
        );
    }

    /** Remember a rejected source, dropping entries that have run out. */
    private rememberRefused(
        cacheKey: string,
        error: OutdatedTrustListsError | TooManyTrustListCertificatesError,
    ) {
        const now = Date.now();
        for (const [key, entry] of this.refused) {
            if (entry.until <= now) this.refused.delete(key);
        }
        this.refused.set(cacheKey, { error, until: now + REFUSED_RETRY_MS });
    }

    /**
     * Clear the cached trust stores, of one tenant or of all.
     * Useful for testing or when trust lists are known to have changed.
     *
     * @param tenantId Clear only this tenant's trust stores; each tenant
     * builds its own
     */
    clearCache(tenantId?: string): void {
        if (tenantId === undefined) {
            this.cache.clear();
            this.refused.clear();
            return;
        }
        for (const map of [this.cache, this.refused]) {
            for (const key of map.keys()) {
                if (tenantOfCacheKey(key) === tenantId) {
                    map.delete(key);
                }
            }
        }
    }

    /**
     * Forget the sequence numbers of the lists the tenant accepted, then
     * clear the cache so the lists are fetched again: a list whose operator
     * numbered it from 1 again is accepted. Until a list is accepted again,
     * an older version of it is accepted too. Other tenants' trust stores
     * are kept.
     */
    async forgetSequenceNumbers(tenantId: string): Promise<void> {
        await this.sequenceNumbers.forgetTenant(tenantId);
        this.clearCache(tenantId);
    }

    /** The key of a source's trust store; see {@link tenantOfCacheKey}. */
    private buildCacheKey(source: LoadedTrustListSource): string {
        return JSON.stringify({
            tenantId: source.tenantId,
            lotes: source.lotes.map((ref) => ({
                url: ref.url,
                verifierKey: ref.verifierKey ?? null,
                verifierKeyPem: ref.verifierKeyPem ?? null,
                verifierX509Der: ref.verifierX509Der ?? null,
                // A managed list stored with a higher number since the store
                // was cached is fetched again, not answered from the cache.
                storedSequenceNumber: ref.storedSequenceNumber ?? null,
            })),
            acceptedServiceTypes: source.acceptedServiceTypes ?? [],
        });
    }
}

/** The tenant of a key from {@link TrustStoreService.buildCacheKey}. */
function tenantOfCacheKey(key: string): string {
    return (JSON.parse(key) as { tenantId: string }).tenantId;
}
