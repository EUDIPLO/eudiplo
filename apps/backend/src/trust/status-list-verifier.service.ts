import { Injectable, Logger } from "@nestjs/common";
import {
    getListFromStatusListJWT,
    getStatusListFromJWT,
    StatusList,
    StatusListCwt,
    StatusListEntry,
    StatusType,
} from "@owf/token-status-list";
import { decodeJwt } from "jose";
import { toBuffer } from "../shared/utils/buffer.util.js";
import { TrustFetchService } from "./trust-fetch.service.js";

/** Upper bound for a status list token. */
const STATUS_LIST_MAX_BYTES = 10 * 1024 * 1024;

const STATUS_LIST_TIMEOUT_MS = 10_000;

const STATUS_LIST_CWT = "application/statuslist+cwt";

/**
 * Cached status list with metadata.
 */
interface CachedStatusList {
    /** The parsed status list */
    statusList: StatusList;
    /** When the cache entry was fetched */
    fetchedAt: number;
    /** TTL from the status list JWT payload (in seconds) */
    ttl?: number;
    /** Expiration time from the JWT (exp claim) */
    exp?: number;
}

/**
 * Cached raw JWT with metadata.
 */
interface CachedJwt {
    /** The raw JWT string */
    jwt: string;
    /** When the cache entry was fetched */
    fetchedAt: number;
    /** TTL from the JWT payload (in seconds) */
    ttl?: number;
    /** Expiration time from the JWT (exp claim) */
    exp?: number;
}

/**
 * Cached raw CWT with metadata.
 */
interface CachedCwt {
    /** The raw CWT bytes */
    cwt: Uint8Array;
    /** When the cache entry was fetched */
    fetchedAt: number;
    /** TTL from the CWT payload (in seconds) */
    ttl?: number;
    /** Expiration time from the CWT (exp claim) */
    exp?: number;
}

/**
 * Result of a status check.
 */
export interface StatusCheckResult {
    /** The raw status value */
    status: number;
    /** Whether the status indicates validity (status === 0) */
    isValid: boolean;
    /** Human-readable status description */
    description: string;
}

/**
 * Service for verifying status list entries.
 * Fetches and caches status list JWTs, and checks the status of entries.
 *
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-status-list
 */
@Injectable()
export class StatusListVerifierService {
    private readonly logger = new Logger(StatusListVerifierService.name);

    /**
     * Cache of parsed status lists keyed by URI.
     * Uses a simple in-memory cache with TTL support.
     */
    private readonly cache = new Map<string, CachedStatusList>();

    /**
     * Cache of raw status list JWTs keyed by URI.
     * Used by statusListFetcher interface for SD-JWT SDK.
     */
    private readonly cachedJwts = new Map<string, CachedJwt>();

    /**
     * Cache of raw status list CWTs keyed by URI.
     * Used by the mDOC verifier, see {@link mdocFetch}.
     */
    private readonly cachedCwts = new Map<string, CachedCwt>();

    /** Default cache TTL in milliseconds (5 minutes) */
    private readonly defaultCacheTtlMs = 5 * 60 * 1000;

    constructor(private readonly trustFetch: TrustFetchService) {}

    /**
     * Get the status entry from a JWT that contains a status claim.
     * This extracts the status_list reference (uri and idx) from the JWT.
     *
     * @param jwt The JWT containing a status claim
     * @returns The status list entry reference, or undefined if no status claim
     */
    getStatusEntryFromJwt(jwt: string): StatusListEntry | undefined {
        try {
            return getStatusListFromJWT(jwt);
        } catch {
            // No status claim in JWT
            return undefined;
        }
    }

    /**
     * Check the status of a JWT that contains a status claim.
     * This will fetch the status list (with caching) and check the status at the specified index.
     *
     * @param jwt The JWT containing a status claim (e.g., wallet attestation JWT)
     * @returns The status check result, or undefined if no status claim in JWT
     */
    async checkStatusFromJwt(
        jwt: string,
    ): Promise<StatusCheckResult | undefined> {
        const statusEntry = this.getStatusEntryFromJwt(jwt);
        if (!statusEntry) {
            return undefined;
        }

        return this.checkStatus(statusEntry.uri, statusEntry.idx);
    }

    /**
     * Check the status at a specific index in a status list.
     *
     * @param statusListUri The URI of the status list JWT
     * @param index The index in the status list to check
     * @returns The status check result
     */
    async checkStatus(
        statusListUri: string,
        index: number,
    ): Promise<StatusCheckResult> {
        const statusList = await this.getStatusList(statusListUri);
        const status = statusList.getStatus(index);

        return {
            status,
            isValid: status === StatusType.Valid,
            description: this.getStatusDescription(status),
        };
    }

    /**
     * Get a status list from cache or fetch it.
     *
     * @param uri The URI of the status list JWT
     * @returns The parsed StatusList
     */
    async getStatusList(uri: string): Promise<StatusList> {
        // Check cache first
        const cached = this.cache.get(uri);
        if (cached && !this.isCacheExpired(cached)) {
            this.logger.debug(`Using cached status list for ${uri}`);
            return cached.statusList;
        }

        // Fetch and cache
        this.logger.debug(`Fetching status list from ${uri}`);
        const statusListToken = await this.fetchStatusListToken(uri);

        let statusList: StatusList;
        let ttl: number | undefined;
        let exp: number | undefined;

        if (typeof statusListToken === "string") {
            statusList = getListFromStatusListJWT(statusListToken);
            const payload = decodeJwt(statusListToken);
            ttl = typeof payload.ttl === "number" ? payload.ttl : undefined;
            exp = typeof payload.exp === "number" ? payload.exp : undefined;
        } else {
            const statusListCwt = StatusListCwt.fromToken(statusListToken);
            statusList = statusListCwt.payload.statusList;
            ttl = statusListCwt.payload.timeToLive;
            exp = statusListCwt.payload.expirationTime
                ? Math.floor(
                      statusListCwt.payload.expirationTime.getTime() / 1000,
                  )
                : undefined;
        }

        this.cache.set(uri, {
            statusList,
            fetchedAt: Date.now(),
            ttl,
            exp,
        });

        return statusList;
    }

    /**
     * Fetch a status list JWT from a URI.
     *
     * @param uri The URI to fetch
     * @param timeoutMs Timeout in milliseconds
     * @returns The raw JWT string
     */
    private async fetchStatusListToken(
        uri: string,
        timeoutMs = STATUS_LIST_TIMEOUT_MS,
        type: "jwt" | "cwt" = "jwt",
    ): Promise<string | Uint8Array> {
        try {
            const response = await this.trustFetch.get(uri, {
                timeoutMs,
                maxBytes: STATUS_LIST_MAX_BYTES,
                accept:
                    type === "cwt"
                        ? STATUS_LIST_CWT
                        : "application/statuslist+jwt",
            });

            const contentType = (response.contentType ?? "").toLowerCase();

            if (contentType.includes(STATUS_LIST_CWT)) {
                return new Uint8Array(response.bytes);
            }

            return response.body.trim();
        } catch (error: any) {
            // "Failed to fetch status list" marks the list as unavailable for
            // the best-effort revocation policy (isStatusListUnavailableError).
            throw new Error(
                `Failed to fetch status list from ${uri}: ${error?.message || error}`,
            );
        }
    }

    /**
     * Check if a cache entry is expired.
     */
    private isCacheExpired(cached: CachedStatusList): boolean {
        return this.isTimedCacheExpired(cached);
    }

    /**
     * Shared expiration logic for parsed-list and raw-token caches.
     */
    private isTimedCacheExpired(cached: {
        fetchedAt: number;
        ttl?: number;
        exp?: number;
    }): boolean {
        const now = Date.now();

        // Check if JWT has expired (exp claim)
        if (cached.exp && now >= cached.exp * 1000) {
            return true;
        }

        // Check TTL from JWT payload
        if (cached.ttl) {
            const expiresAt = cached.fetchedAt + cached.ttl * 1000;
            return now >= expiresAt;
        }

        // Fall back to default cache TTL
        return now >= cached.fetchedAt + this.defaultCacheTtlMs;
    }

    /**
     * Get a human-readable description for a status value.
     */
    private getStatusDescription(status: StatusType): string {
        switch (status) {
            case StatusType.Valid:
                return "Valid";
            case StatusType.Invalid:
                return "Invalid/Revoked";
            case StatusType.Suspended:
                return "Suspended";
            default:
                return `Unknown status (${status})`;
        }
    }

    /**
     * Clear the cache for a specific URI or all URIs.
     *
     * @param uri Optional URI to clear. If not provided, clears all.
     */
    clearCache(uri?: string): void {
        if (uri) {
            this.cache.delete(uri);
            this.cachedJwts.delete(uri);
            this.cachedCwts.delete(uri);
        } else {
            this.cache.clear();
            this.cachedJwts.clear();
            this.cachedCwts.clear();
        }
    }

    /**
     * Get cache statistics for monitoring.
     */
    getCacheStats(): { size: number; jwtCacheSize: number; uris: string[] } {
        return {
            size: this.cache.size,
            jwtCacheSize: this.cachedJwts.size,
            uris: Array.from(
                new Set([
                    ...this.cache.keys(),
                    ...this.cachedJwts.keys(),
                    ...this.cachedCwts.keys(),
                ]),
            ),
        };
    }

    /**
     * Get a status list JWT from cache or fetch it.
     * This is useful when you need the raw JWT string (e.g., for SDK's statusListFetcher).
     * The JWT is cached based on its TTL/exp claims.
     *
     * @param uri The URI of the status list JWT
     * @returns The raw JWT string
     */
    async getStatusListJwt(uri: string): Promise<string> {
        // Check if we have a valid cached entry
        const cached = this.cachedJwts.get(uri);
        if (cached && !this.isJwtCacheExpired(cached)) {
            this.logger.debug(`Using cached status list JWT for ${uri}`);
            return cached.jwt;
        }

        // Fetch and cache
        this.logger.debug(`Fetching status list JWT from ${uri}`);
        const token = await this.fetchStatusListToken(uri);
        if (typeof token !== "string") {
            throw new TypeError(
                `Status list at ${uri} returned CWT while JWT was requested`,
            );
        }
        const jwt = token;

        // Extract TTL and exp from the JWT payload
        const payload = decodeJwt(jwt);
        const ttl = typeof payload.ttl === "number" ? payload.ttl : undefined;
        const exp = typeof payload.exp === "number" ? payload.exp : undefined;

        this.cachedJwts.set(uri, {
            jwt,
            fetchedAt: Date.now(),
            ttl,
            exp,
        });

        return jwt;
    }

    /**
     * Check if a JWT cache entry is expired.
     */
    private isJwtCacheExpired(cached: CachedJwt): boolean {
        return this.isTimedCacheExpired(cached);
    }

    /**
     * Get a status list CWT from cache or fetch it.
     * The CWT is cached based on its ttl/exp claims.
     *
     * @param uri The URI of the status list CWT
     * @returns The raw CWT bytes
     */
    async getStatusListCwt(uri: string): Promise<Uint8Array> {
        const cached = this.cachedCwts.get(uri);
        if (cached && !this.isTimedCacheExpired(cached)) {
            this.logger.debug(`Using cached status list CWT for ${uri}`);
            return cached.cwt;
        }

        this.logger.debug(`Fetching status list CWT from ${uri}`);
        const token = await this.fetchStatusListToken(
            uri,
            STATUS_LIST_TIMEOUT_MS,
            "cwt",
        );
        if (typeof token === "string") {
            throw new TypeError(
                `Status list at ${uri} was not served as ${STATUS_LIST_CWT}`,
            );
        }

        const { payload } = StatusListCwt.fromToken(token);
        this.cachedCwts.set(uri, {
            cwt: token,
            fetchedAt: Date.now(),
            ttl: payload.timeToLive,
            exp: payload.expirationTime
                ? Math.floor(payload.expirationTime.getTime() / 1000)
                : undefined,
        });

        return token;
    }

    /**
     * `fetch` for the mDOC verifier's `MdocContext`. @owf/mdoc downloads the
     * status list or ISO/IEC 18013-5 identifier list named in a presented
     * mDOC's MSO through it, so these requests get the outbound URL policy,
     * size limit and timeout of SD-JWT status lists, and status lists come
     * from the cache.
     *
     * Failures are thrown rather than returned as a non-2xx response, so a
     * status list that cannot be fetched fails with "Failed to fetch status
     * list" as on the SD-JWT path, which the best-effort revocation policy
     * treats as unavailable.
     */
    readonly mdocFetch: typeof fetch = async (input, init) => {
        const uri = input instanceof Request ? input.url : input.toString();
        const accept = new Headers(init?.headers).get("accept") ?? "";

        if (accept.includes(STATUS_LIST_CWT)) {
            const cwt = await this.getStatusListCwt(uri);
            return new Response(toBuffer(cwt), {
                headers: { "content-type": STATUS_LIST_CWT },
            });
        }

        // Identifier lists are not cached.
        const response = await this.trustFetch
            .get(uri, {
                timeoutMs: STATUS_LIST_TIMEOUT_MS,
                maxBytes: STATUS_LIST_MAX_BYTES,
                accept: accept || undefined,
            })
            .catch((error: any) => {
                throw new Error(
                    `Failed to fetch identifier list from ${uri}: ${error?.message || error}`,
                );
            });
        return new Response(toBuffer(response.bytes), {
            headers: response.contentType
                ? { "content-type": response.contentType }
                : undefined,
        });
    };
}
