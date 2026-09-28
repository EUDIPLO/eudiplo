import type { HttpService } from "@nestjs/axios";
import { Logger } from "@nestjs/common";
import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import type { MetricService } from "nestjs-otel";
import { firstValueFrom } from "rxjs";
import type { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import type { FederationTrustSource } from "../../../../trust/types.js";
import {
    AuthorizationServerMetadataUnavailable,
    AuthorizationServerNotTrusted,
} from "../domain/authorization-server-errors.js";
import type { ExternalAuthorizationServerMetadataResolver } from "../ports/authorization-server-metadata.js";

type CachedMetadata = {
    metadata: AuthorizationServerMetadata;
    fetchedAt: number;
    expiresAt: number;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Stale entries are served for this long when a refresh fails. */
const STALE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetches external authorization server metadata over HTTP
 * (`oauth-authorization-server`, falling back to `openid-configuration`).
 * Results are cached per issuer, concurrent fetches are deduplicated, and a
 * stale entry is served for up to one hour when a refresh fails.
 */
export class HttpExternalAuthorizationServerMetadataResolver
    implements ExternalAuthorizationServerMetadataResolver
{
    private readonly logger = new Logger(
        HttpExternalAuthorizationServerMetadataResolver.name,
    );
    private readonly cache = new Map<string, CachedMetadata>();
    private readonly inFlight = new Map<
        string,
        Promise<AuthorizationServerMetadata>
    >();
    private readonly counters;

    constructor(
        private readonly http: HttpService,
        private readonly federationTrust: FederationTrustService,
        metrics?: MetricService,
    ) {
        this.counters = {
            hits: metrics?.getCounter("oid4vci_as_metadata_cache_hits_total", {
                description: "Total hits on OID4VCI AS metadata cache",
            }),
            misses: metrics?.getCounter(
                "oid4vci_as_metadata_cache_misses_total",
                { description: "Total misses on OID4VCI AS metadata cache" },
            ),
            stale: metrics?.getCounter(
                "oid4vci_as_metadata_cache_stale_total",
                {
                    description:
                        "Total stale hits on OID4VCI AS metadata cache",
                },
            ),
            fetches: metrics?.getCounter("oid4vci_as_metadata_fetches_total", {
                description: "Total outbound AS metadata fetches",
            }),
        };
    }

    async resolve(
        issuer: string,
        federation?: FederationTrustSource,
    ): Promise<AuthorizationServerMetadata> {
        await this.assertFederationTrust(issuer, federation);
        return this.fetchCached(issuer);
    }

    private async assertFederationTrust(
        issuer: string,
        federation?: FederationTrustSource,
    ): Promise<void> {
        if (!federation) return;
        if (this.federationTrust.getMode(federation) === "lote-only") return;

        const evaluation =
            await this.federationTrust.evaluateAuthorizationServerTrust(
                issuer,
                federation,
            );
        if (!evaluation.trusted) {
            throw new AuthorizationServerNotTrusted(evaluation.reason);
        }
    }

    private async fetchCached(
        issuer: string,
    ): Promise<AuthorizationServerMetadata> {
        const now = Date.now();
        const cached = this.cache.get(issuer);
        const labels = { auth_server: issuer };

        if (cached && cached.expiresAt > now) {
            this.counters.hits?.add(1, labels);
            this.logger.debug(`AS metadata cache hit for ${issuer}`);
            return cached.metadata;
        }

        const pending = this.inFlight.get(issuer);
        if (pending) {
            this.logger.debug(
                `Deduplicating in-flight AS metadata fetch for ${issuer}`,
            );
            return pending;
        }

        this.counters.misses?.add(1, labels);

        const fetchPromise = (async () => {
            this.counters.fetches?.add(1, labels);
            try {
                const metadata = await this.fetch(issuer);
                this.cache.set(issuer, {
                    metadata,
                    fetchedAt: Date.now(),
                    expiresAt: Date.now() + CACHE_TTL_MS,
                });
                return metadata;
            } catch (error) {
                if (cached && now - cached.fetchedAt <= STALE_TTL_MS) {
                    this.counters.stale?.add(1, labels);
                    this.logger.warn(
                        `Failed to fetch authorization server metadata for ${issuer}, returning stale cached metadata: ${String(error)}`,
                    );
                    return cached.metadata;
                }
                throw error;
            }
        })();

        this.inFlight.set(issuer, fetchPromise);
        try {
            return await fetchPromise;
        } finally {
            this.inFlight.delete(issuer);
        }
    }

    private async fetch(issuer: string): Promise<AuthorizationServerMetadata> {
        const get = (path: string) =>
            firstValueFrom(this.http.get(`${issuer}${path}`)).then(
                (response) => response.data as AuthorizationServerMetadata,
            );
        try {
            return await get("/.well-known/oauth-authorization-server");
        } catch {
            try {
                return await get("/.well-known/openid-configuration");
            } catch {
                throw new AuthorizationServerMetadataUnavailable();
            }
        }
    }
}
