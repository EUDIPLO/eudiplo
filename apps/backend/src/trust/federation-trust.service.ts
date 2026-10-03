import { X509Certificate } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { MetricService } from "nestjs-otel";
import { EvaluateFederationTrustChain } from "./application/evaluate-federation-trust-chain.js";
import { FederationTrustMode, FederationTrustSource } from "./types.js";

type FederationTrustEvaluation = {
    trusted: boolean;
    reason: string;
};

type CachedEvaluation = {
    value: FederationTrustEvaluation;
    fetchedAt: number;
    expiresAt: number;
};

const FEDERATION_TRUST_STALE_TTL_MS = 60 * 60 * 1000; // 1 hour stale grace window
const FEDERATION_TRUST_NEGATIVE_TTL_MS = 10 * 1000; // 10s negative cache for fetch failures

@Injectable()
export class FederationTrustService {
    private readonly logger = new Logger(FederationTrustService.name);
    private readonly trustCache = new Map<string, CachedEvaluation>();
    private readonly inFlightEvaluations = new Map<
        string,
        Promise<FederationTrustEvaluation>
    >();

    private readonly trustHitsCounter;
    private readonly trustMissesCounter;
    private readonly trustStaleCounter;
    private readonly trustFetchesCounter;

    clearTrustCache(): void {
        this.trustCache.clear();
        this.inFlightEvaluations.clear();
    }

    constructor(
        private readonly evaluateFederationTrustChain: EvaluateFederationTrustChain,
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
            { description: "Total outbound federation entity config fetches" },
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

    async evaluateCertificateEntityTrust(
        x5c: string[] | undefined,
        source?: FederationTrustSource,
    ): Promise<FederationTrustEvaluation> {
        if (!this.shouldUseFederation(source)) {
            return { trusted: true, reason: "federation disabled by mode" };
        }

        if (!this.isEnabled(source)) {
            return {
                trusted: false,
                reason: "federation mode requires trust anchors, none configured",
            };
        }

        if (!x5c?.length) {
            return {
                trusted: false,
                reason: "federation mode requires x5c for entity extraction",
            };
        }

        const leafEntityId = this.tryExtractEntityIdFromLeaf(x5c[0]);
        if (!leafEntityId) {
            return {
                trusted: false,
                reason: "could not extract entity id from certificate SAN/CN",
            };
        }

        return this.evaluateEntityTrust(leafEntityId, source);
    }

    async evaluateAuthorizationServerTrust(
        issuerOrBaseUrl: string,
        source?: FederationTrustSource,
    ): Promise<FederationTrustEvaluation> {
        if (!this.shouldUseFederation(source)) {
            return { trusted: true, reason: "federation disabled by mode" };
        }

        if (!this.isEnabled(source)) {
            return {
                trusted: false,
                reason: "federation mode requires trust anchors, none configured",
            };
        }

        return this.evaluateEntityTrust(issuerOrBaseUrl, source);
    }

    async evaluateEntityTrust(
        entityId: string,
        source?: FederationTrustSource,
    ): Promise<FederationTrustEvaluation> {
        if (!this.shouldUseFederation(source)) {
            return { trusted: true, reason: "federation disabled by mode" };
        }

        if (!this.isEnabled(source)) {
            return {
                trusted: false,
                reason: "federation mode requires trust anchors, none configured",
            };
        }

        const normalizedEntityId = entityId.replace(/\/$/, "");
        const cacheKey = `${normalizedEntityId}::${JSON.stringify(source?.trustAnchors ?? [])}`;

        const now = Date.now();
        const cached = this.trustCache.get(cacheKey);

        if (cached && cached.expiresAt > now) {
            this.trustHitsCounter?.add(1, { entity: normalizedEntityId });
            this.logger.debug(
                `Federation trust cache hit for ${normalizedEntityId}`,
            );
            return cached.value;
        }

        const inFlight = this.inFlightEvaluations.get(cacheKey);
        if (inFlight) {
            this.logger.debug(
                `Deduplicating in-flight trust evaluation for ${normalizedEntityId}`,
            );
            return inFlight;
        }

        this.trustMissesCounter?.add(1, { entity: normalizedEntityId });

        const evalPromise = (async (): Promise<FederationTrustEvaluation> => {
            const anchorIds = new Set(
                (source?.trustAnchors ?? []).map((anchor) =>
                    anchor.entityId.replace(/\/$/, ""),
                ),
            );

            if (anchorIds.has(normalizedEntityId)) {
                const value = {
                    trusted: true,
                    reason: "entity is a configured federation trust anchor",
                };
                this.setCache(cacheKey, source, value);
                return value;
            }

            this.trustFetchesCounter?.add(1, { entity: normalizedEntityId });

            let value: FederationTrustEvaluation;
            try {
                value = await this.evaluateFederationTrustChain.execute({
                    entityId: normalizedEntityId,
                    trustAnchors: [...anchorIds],
                });
            } catch (error) {
                this.logger.warn(
                    `Failed to fetch federation entity configuration for ${normalizedEntityId}: ${String(error)}`,
                );
                if (
                    cached &&
                    now - cached.fetchedAt <= FEDERATION_TRUST_STALE_TTL_MS
                ) {
                    this.trustStaleCounter?.add(1, {
                        entity: normalizedEntityId,
                    });
                    this.logger.warn(
                        `Failed to fetch federation entity configuration for ${normalizedEntityId}, serving stale evaluation result`,
                    );
                    return cached.value;
                }

                value = {
                    trusted: false,
                    reason: "could not fetch federation entity configuration",
                };
                this.setNegativeCache(cacheKey, value);
                return value;
            }

            this.setCache(cacheKey, source, value);
            return value;
        })();

        this.inFlightEvaluations.set(cacheKey, evalPromise);

        try {
            return await evalPromise;
        } finally {
            this.inFlightEvaluations.delete(cacheKey);
        }
    }

    private setCache(
        cacheKey: string,
        source: FederationTrustSource | undefined,
        value: FederationTrustEvaluation,
    ) {
        const ttlMs = Math.max(5, source?.cacheTtlSeconds ?? 300) * 1000;
        this.trustCache.set(cacheKey, {
            value,
            fetchedAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
        });
    }

    private setNegativeCache(
        cacheKey: string,
        value: FederationTrustEvaluation,
    ) {
        this.trustCache.set(cacheKey, {
            value,
            fetchedAt: Date.now(),
            expiresAt: Date.now() + FEDERATION_TRUST_NEGATIVE_TTL_MS,
        });
    }

    private tryExtractEntityIdFromLeaf(leafX5cBase64: string): string | null {
        try {
            const cert = new X509Certificate(
                Buffer.from(leafX5cBase64, "base64"),
            );

            if (cert.subjectAltName) {
                const uriMatch = cert.subjectAltName
                    .split(",")
                    .map((part) => part.trim())
                    .find((part) => part.startsWith("URI:"));

                if (uriMatch) {
                    return uriMatch.slice(4);
                }
            }

            // Node renders the subject as one RDN per line.
            const cnMatch = cert.subject
                .split("\n")
                .map((part) => part.trim())
                .find((part) => part.startsWith("CN="));

            return cnMatch ? cnMatch.slice(3) : null;
        } catch (error) {
            this.logger.debug(
                `Could not parse x5c leaf certificate: ${String(error)}`,
            );
            return null;
        }
    }
}
