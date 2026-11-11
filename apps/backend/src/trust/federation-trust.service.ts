import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { JWK } from "jose";
import { MetricService } from "nestjs-otel";
import {
    CREDENTIAL_ISSUER_METADATA_TYPE,
    findFederationProtocolKey,
} from "./domain/federation-protocol-keys.js";
import { pinnedTrustAnchorMismatch } from "./domain/federation-statement-signature.js";
import {
    FEDERATION_RESOLVER,
    type FederationResolution,
    FederationResolutionError,
    type FederationResolver,
    type FederationTrustAnchor,
} from "./ports/federation-resolver.js";
import {
    FEDERATION_TRUST_ANCHOR_KEYS,
    type FederationTrustAnchorKeys,
} from "./ports/federation-trust-anchor-keys.js";
import { FederationTrustMode, FederationTrustSource } from "./types.js";

type FederationTrustEvaluation = {
    trusted: boolean;
    reason: string;
};

type CachedResolution =
    | {
          resolution: FederationResolution;
          expiresAt: number;
          obtainedAt: number;
      }
    | { error: FederationResolutionError; expiresAt: number };

/** Failed resolutions are retried after this time. */
const FEDERATION_NEGATIVE_TTL_MS = 10 * 1000;

/**
 * How long after it was obtained a resolution may be reused while the
 * federation cannot be reached. An entity its superior removed could
 * otherwise stay trusted until the chain expires by failing its own
 * requests.
 */
const FEDERATION_STALE_TTL_MS = 15 * 60 * 1000;

/**
 * Upper bound of cached entries. Entity IDs come from presented
 * credentials, so the cache must not grow with every new one.
 */
const FEDERATION_CACHE_MAX_ENTRIES = 1000;

/** A credential issuer key found in trusted federation metadata. */
export interface FederationIssuerKey {
    jwk: JWK;
    resolution: FederationResolution;
}

/**
 * OpenID Federation trust decisions on top of the configured
 * {@link FederationResolver}. Resolutions are cached for `cacheTtlSeconds`,
 * never beyond the `exp` of the trust chain. A verification failure is final
 * until the negative cache expires; only when the federation cannot be
 * reached is an earlier resolution reused, for at most 15 minutes after it
 * was obtained and only while its chain is valid.
 */
@Injectable()
export class FederationTrustService {
    private readonly logger = new Logger(FederationTrustService.name);
    private readonly cache = new Map<string, CachedResolution>();
    /** The last successful resolution per key, for transport failures. */
    private readonly lastResolutions = new Map<
        string,
        { resolution: FederationResolution; obtainedAt: number }
    >();
    /** Unpinned trust anchors already warned about, per tenant. */
    private readonly unpinnedWarnings = new Map<string, true>();
    private readonly inFlight = new Map<
        string,
        Promise<FederationResolution>
    >();
    /**
     * The tenants that used each cache key since it was last cleared.
     * Tenants with the same trust anchors and keys share entries, so a
     * tenant clears only the entries it used itself. It holds more keys than
     * the cache, so a cached key keeps its tenants.
     */
    private readonly tenantsByKey = new Map<string, Set<string>>();

    private readonly trustHitsCounter;
    private readonly trustMissesCounter;
    private readonly trustStaleCounter;
    private readonly trustFetchesCounter;

    /**
     * Clear cached resolutions, of all tenants or only those `tenantId`
     * used. A resolution another tenant shares is resolved again for it too.
     * The last successful resolution, the fallback while the federation
     * cannot be reached, is dropped too once no other tenant uses it; a
     * tenant that shares it keeps its fallback.
     */
    clearTrustCache(tenantId?: string): void {
        if (tenantId === undefined) {
            this.cache.clear();
            this.lastResolutions.clear();
            this.inFlight.clear();
            this.unpinnedWarnings.clear();
            this.tenantsByKey.clear();
            return;
        }
        for (const [key, tenants] of [...this.tenantsByKey]) {
            if (tenants.delete(tenantId)) {
                this.cache.delete(key);
                if (tenants.size === 0) {
                    this.lastResolutions.delete(key);
                    this.inFlight.delete(key);
                    this.tenantsByKey.delete(key);
                }
            }
        }
        for (const warning of [...this.unpinnedWarnings.keys()]) {
            if ((JSON.parse(warning) as unknown[])[0] === tenantId) {
                this.unpinnedWarnings.delete(warning);
            }
        }
    }

    constructor(
        @Inject(FEDERATION_RESOLVER)
        private readonly resolver: FederationResolver,
        @Inject(FEDERATION_TRUST_ANCHOR_KEYS)
        private readonly anchorKeys: FederationTrustAnchorKeys,
        @Optional() private readonly metricService?: MetricService,
    ) {
        this.trustHitsCounter = this.metricService?.getCounter(
            "federation_trust_cache_hits_total",
            { description: "Total hits on federation trust cache" },
        );
        this.trustMissesCounter = this.metricService?.getCounter(
            "federation_trust_cache_misses_total",
            { description: "Total misses on federation trust cache" },
        );
        this.trustStaleCounter = this.metricService?.getCounter(
            "federation_trust_cache_stale_total",
            { description: "Total stale hits on federation trust cache" },
        );
        this.trustFetchesCounter = this.metricService?.getCounter(
            "federation_trust_fetches_total",
            { description: "Total federation trust chain resolutions" },
        );
    }

    getMode(source?: FederationTrustSource): FederationTrustMode {
        return source?.mode ?? "hybrid";
    }

    isEnabled(source?: FederationTrustSource): boolean {
        return Boolean(source?.trustAnchors?.length);
    }

    shouldUseLote(source?: FederationTrustSource): boolean {
        const mode = this.getMode(source);
        return mode === "lote-only" || mode === "hybrid";
    }

    shouldUseFederation(source?: FederationTrustSource): boolean {
        const mode = this.getMode(source);
        return mode === "federation-only" || mode === "hybrid";
    }

    /**
     * Whether an authorization server is a federation entity with
     * `oauth_authorization_server` or `openid_provider` metadata whose trust
     * chain leads to a configured trust anchor.
     */
    async evaluateAuthorizationServerTrust(
        issuerOrBaseUrl: string,
        source?: FederationTrustSource,
    ): Promise<FederationTrustEvaluation> {
        if (!this.shouldUseFederation(source)) {
            return { trusted: true, reason: "federation disabled by mode" };
        }
        // An upstream OpenID provider publishes openid_provider metadata.
        const types = ["oauth_authorization_server", "openid_provider"];
        try {
            const resolution = await this.resolveEntity(
                issuerOrBaseUrl,
                source,
                types,
            );
            // Sections 5.1.3 and 5.1.4: the issuer is the entity identifier.
            const mismatch = types.find(
                (type) =>
                    resolution.metadata[type] !== undefined &&
                    resolution.metadata[type].issuer !== resolution.entityId,
            );
            if (mismatch) {
                return {
                    trusted: false,
                    reason: `${mismatch} issuer of ${resolution.entityId} is missing or not its entity identifier`,
                };
            }
            return {
                trusted: true,
                reason: `authorization server chains to trust anchor ${resolution.trustAnchor}`,
            };
        } catch (error) {
            return { trusted: false, reason: reasonOf(error) };
        }
    }

    /**
     * The signing key `kid` of credential issuer `issuer`, taken from the
     * `openid_credential_issuer` metadata of its validated trust chain.
     *
     * @throws FederationResolutionError when the issuer is not trusted, its
     * chain cannot be resolved or its metadata has no key `kid`
     */
    async resolveCredentialIssuerKey(
        issuer: string,
        kid: string,
        source?: FederationTrustSource,
    ): Promise<FederationIssuerKey> {
        const resolution = await this.resolveEntity(issuer, source, [
            CREDENTIAL_ISSUER_METADATA_TYPE,
        ]);
        const jwk = findFederationProtocolKey(
            resolution.metadata,
            CREDENTIAL_ISSUER_METADATA_TYPE,
            kid,
        );
        if (!jwk) {
            throw new FederationResolutionError(
                `${CREDENTIAL_ISSUER_METADATA_TYPE} metadata of ${issuer} has no key '${kid}'`,
                "untrusted",
            );
        }
        return { jwk, resolution };
    }

    /**
     * The trust anchors of `source` the tenant registered with pinned keys.
     * Trust anchors without them are left out: their entity configuration
     * could only be checked against the keys it publishes itself.
     *
     * @throws FederationResolutionError when none is registered
     */
    private async pinnedTrustAnchors(
        source: FederationTrustSource,
    ): Promise<FederationTrustAnchor[]> {
        const entityIds = [
            ...new Set(source.trustAnchors.map((anchor) => anchor.entityId)),
        ];
        const pinned = source.tenantId
            ? await this.anchorKeys.findPinnedKeys(source.tenantId, entityIds)
            : new Map();
        const unpinned = entityIds.filter((id) => !pinned.has(id));
        const warning = JSON.stringify([source.tenantId, unpinned]);
        if (unpinned.length > 0 && !this.unpinnedWarnings.has(warning)) {
            setBounded(this.unpinnedWarnings, warning, true);
            this.logger.warn(
                `Federation trust anchors without pinned keys are not trusted: ${unpinned.join(", ")}. Register them as federation trust anchors of tenant ${source.tenantId ?? "(none)"}.`,
            );
        }
        const anchors = entityIds
            .filter((id) => pinned.has(id))
            .map((id) => ({ entityId: id, jwks: pinned.get(id)! }));
        if (anchors.length === 0) {
            throw new FederationResolutionError(
                `no trust anchor of ${entityIds.join(", ")} is registered with pinned keys`,
                "untrusted",
            );
        }
        return anchors;
    }

    /**
     * Resolves and validates the trust chain of `entityId` to one of the
     * trust anchors of `source`.
     *
     * @throws FederationResolutionError
     */
    async resolveEntity(
        entityId: string,
        source: FederationTrustSource | undefined,
        metadataTypes?: string[],
    ): Promise<FederationResolution> {
        if (!this.isEnabled(source)) {
            throw new FederationResolutionError(
                "federation mode requires trust anchors, none configured",
                "untrusted",
            );
        }
        const trustAnchors = await this.pinnedTrustAnchors(source!);
        // Entity IDs are compared exactly (OpenID Federation Section 16), so
        // the cache key uses them unchanged. Tenants may pin different keys
        // for the same trust anchor, so the keys are part of the key.
        const key = JSON.stringify([
            entityId,
            trustAnchors.map((anchor) => [
                anchor.entityId,
                createHash("sha256")
                    .update(JSON.stringify(anchor.jwks))
                    .digest("base64url"),
            ]),
            metadataTypes ?? [],
        ]);
        const labels = { entity: entityId };
        if (source!.tenantId !== undefined) {
            const tenants = this.tenantsByKey.get(key) ?? new Set<string>();
            tenants.add(source!.tenantId);
            setBounded(
                this.tenantsByKey,
                key,
                tenants,
                2 * FEDERATION_CACHE_MAX_ENTRIES,
            );
        }

        const now = Date.now();
        const ttlMs = Math.max(5, source!.cacheTtlSeconds ?? 300) * 1000;
        const cached = this.cache.get(key);
        // Tenants share entries; each caller's own TTL applies on read.
        if (
            cached &&
            cached.expiresAt > now &&
            (!("obtainedAt" in cached) || now - cached.obtainedAt < ttlMs)
        ) {
            this.trustHitsCounter?.add(1, labels);
            if ("error" in cached) throw cached.error;
            return cached.resolution;
        }

        const pending = this.inFlight.get(key);
        if (pending) return pending;

        this.trustMissesCounter?.add(1, labels);
        const resolve = (async () => {
            this.trustFetchesCounter?.add(1, labels);
            try {
                const resolution = await this.resolver.resolveEntity({
                    entityId,
                    trustAnchors,
                    metadataTypes,
                });
                await assertPinnedTrustAnchor(resolution, trustAnchors);
                setBounded(this.cache, key, {
                    resolution,
                    obtainedAt: Date.now(),
                    expiresAt: Math.min(
                        Date.now() + ttlMs,
                        Date.parse(resolution.expiresAt),
                    ),
                });
                setBounded(this.lastResolutions, key, {
                    resolution,
                    obtainedAt: Date.now(),
                });
                return resolution;
            } catch (error) {
                // An unexpected error is not a known outage, so it does not
                // bring an earlier resolution back.
                const failure =
                    error instanceof FederationResolutionError
                        ? error
                        : new FederationResolutionError(
                              reasonOf(error),
                              "untrusted",
                          );
                const last = this.lastResolutions.get(key);
                if (
                    failure.failure === "unavailable" &&
                    last &&
                    Date.now() - last.obtainedAt <= FEDERATION_STALE_TTL_MS &&
                    Date.parse(last.resolution.expiresAt) > Date.now()
                ) {
                    this.trustStaleCounter?.add(1, labels);
                    this.logger.warn(
                        `Could not resolve federation entity ${entityId}, reusing the resolution from ${new Date(last.obtainedAt).toISOString()}: ${failure.message}`,
                    );
                    return last.resolution;
                }
                if (failure.failure === "untrusted") {
                    // A rejected chain must never be replaced by an older one.
                    this.lastResolutions.delete(key);
                }
                this.logger.warn(
                    `Federation entity ${entityId} is not trusted: ${failure.message}`,
                );
                setBounded(this.cache, key, {
                    error: failure,
                    expiresAt: Date.now() + FEDERATION_NEGATIVE_TTL_MS,
                });
                throw failure;
            }
        })();

        this.inFlight.set(key, resolve);
        try {
            return await resolve;
        } finally {
            this.inFlight.delete(key);
        }
    }
}

/**
 * The resolved chain must end at a configured trust anchor whose entity
 * configuration is signed with a pinned key. The local resolver checks this
 * already; it is repeated for every resolver, so a trust engine cannot
 * resolve to a trust anchor with other keys. It does not verify the rest of
 * an engine's chain or its metadata: the engine is trusted for those.
 */
async function assertPinnedTrustAnchor(
    resolution: FederationResolution,
    trustAnchors: FederationTrustAnchor[],
): Promise<void> {
    const anchor = trustAnchors.find(
        (candidate) => candidate.entityId === resolution.trustAnchor,
    );
    const mismatch = anchor
        ? await pinnedTrustAnchorMismatch(
              resolution.trustChain.at(-1),
              anchor.entityId,
              anchor.jwks.keys,
          )
        : `trust anchor ${resolution.trustAnchor} is not configured`;
    if (mismatch) throw new FederationResolutionError(mismatch, "untrusted");
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `map.set` that drops the oldest entries above `maxEntries`. */
function setBounded<V>(
    map: Map<string, V>,
    key: string,
    value: V,
    maxEntries = FEDERATION_CACHE_MAX_ENTRIES,
): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > maxEntries) {
        map.delete(map.keys().next().value as string);
    }
}
