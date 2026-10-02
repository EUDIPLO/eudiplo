import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import { TrustListService } from "../issuer/trust-list/trustlist.service.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { LoteParserService } from "./lote-parser.service.js";
import {
    TRUST_STORE_SETTINGS,
    type TrustStoreSettings,
} from "./trust-store-settings.js";
import { TrustedEntity, TrustListRef, TrustListSource } from "./types.js";

/**
 * Built trust store with TrustedEntities preserving service groupings.
 */
export type BuiltTrustStore = {
    fetchedAt: number;
    nextUpdate?: string;
    /** TrustedEntities with their services (issuance + revocation) grouped */
    entities: TrustedEntity[];
};

@Injectable()
export class TrustStoreService {
    private readonly logger = new Logger(TrustStoreService.name);
    private readonly cache = new Map<string, BuiltTrustStore>();

    constructor(
        private readonly collectTrustedEntities: CollectTrustedEntities,
        private readonly trustListService: TrustListService,
        @Inject(TRUST_STORE_SETTINGS)
        private readonly settings: TrustStoreSettings,
        private readonly loteParser: LoteParserService,
    ) {}

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

        if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
            return cached;
        }

        const result = await this.collectTrustedEntities.execute(source);
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
     * Staleness is not checked here; verification still fails closed on it.
     */
    async getListedEntities(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<TrustedEntity[]> {
        if (ref.trustListId === undefined) {
            return (await this.getTrustStore({ tenantId, lotes: [ref] }))
                .entities;
        }
        const { data } = await this.trustListService.findOne(
            tenantId,
            ref.trustListId.trim(),
        );
        if (!data) return [];
        // Stored as `{ LoTE: ... }`; lists created by older releases lack the wrapper.
        const lote = ((data as { LoTE?: LoTE }).LoTE ?? data) as LoTE;
        return this.loteParser.parse(lote).entities;
    }

    /**
     * Clear the cached trust store.
     * Useful for testing or when trust lists are known to have changed.
     */
    clearCache(): void {
        this.cache.clear();
    }

    private buildCacheKey(source: TrustListSource): string {
        return JSON.stringify({
            tenantId: source.tenantId,
            lotes: source.lotes.map((ref) => ({
                url: ref.url,
                verifierKey: ref.verifierKey ?? null,
                verifierX509Der: ref.verifierX509Der ?? null,
            })),
            acceptedServiceTypes: source.acceptedServiceTypes ?? [],
        });
    }
}
