import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { JWK } from "jose";
import { MetricService } from "nestjs-otel";
import {
    CREDENTIAL_ISSUER_METADATA_TYPE,
    findFederationProtocolKey,
} from "./domain/federation-protocol-keys.js";
import {
    FEDERATION_RESOLVER,
    type FederationResolution,
    FederationResolutionError,
    type FederationResolver,
} from "./ports/federation-resolver.js";
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
    private readonly inFlight = new Map<
        string,
        Promise<FederationResolution>
    >();

    private readonly trustHitsCounter;
    private readonly trustMissesCounter;
    private readonly trustStaleCounter;
    private readonly trustFetchesCounter;

    clearTrustCache(): void {
        this.cache.clear();
        this.lastResolutions.clear();
        this.inFlight.clear();
    }

    constructor(
        @Inject(FEDERATION_RESOLVER)
        private readonly resolver: FederationResolver,
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
        const trustAnchors = source!.trustAnchors.map((anchor) => ({
            entityId: anchor.entityId,
        }));
        // Entity IDs are compared exactly (OpenID Federation Section 16), so
        // the cache key uses them unchanged.
        const key = JSON.stringify([
            entityId,
            trustAnchors.map((anchor) => anchor.entityId),
            metadataTypes ?? [],
        ]);
        const labels = { entity: entityId };

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

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `map.set` that drops the oldest entries above the size bound. */
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > FEDERATION_CACHE_MAX_ENTRIES) {
        map.delete(map.keys().next().value as string);
    }
}
