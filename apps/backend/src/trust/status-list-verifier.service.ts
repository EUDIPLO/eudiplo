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
import { BoundedTtlCache } from "../shared/utils/bounded-ttl-cache.js";
import { toBuffer } from "../shared/utils/buffer.util.js";
import { RevocationListUnavailableError } from "./revocation-policy.util.js";
import { TrustFetchService } from "./trust-fetch.service.js";

/** Upper bound for a status list token. */
const STATUS_LIST_MAX_BYTES = 10 * 1024 * 1024;

const STATUS_LIST_TIMEOUT_MS = 10_000;

const STATUS_LIST_CWT = "application/statuslist+cwt";

/** Cache time of a status list token without a ttl. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Longest cache time of a status list token, whatever its ttl says. The ttl
 * and exp are read before the token's signature is verified, so the server
 * at a URI from a presented credential chooses them. One hour is the default
 * STATUS_TTL of EUDIPLO's own status lists.
 */
const MAX_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The URIs of these caches come from presented credentials, so each cache is
 * bounded. When one is full, the least recently used status list is evicted.
 */
const CACHE_MAX_ENTRIES = 1000;

/** Byte budget of each raw token cache, counted by {@link tokenBytes}. */
const TOKEN_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Byte budget of the parsed status lists. */
const PARSED_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A parsed `StatusList` holds a JavaScript array with one number per status,
 * about 8 bytes each whatever the bits per status. The compressed token does
 * not bound this: a token of a few hundred bytes can hold millions of
 * statuses.
 */
const PARSED_BYTES_PER_STATUS = 8;

/**
 * Memory a status list token takes, or more. A string is counted at two
 * bytes per character, the most V8 stores one with.
 */
function tokenBytes(token: string | Uint8Array): number {
    return typeof token === "string" ? token.length * 2 : token.byteLength;
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
     */
    private readonly cache = new BoundedTtlCache<StatusList>({
        maxEntries: CACHE_MAX_ENTRIES,
        maxBytes: PARSED_CACHE_MAX_BYTES,
    });

    /**
     * Cache of raw status list JWTs keyed by URI.
     * Used by statusListFetcher interface for SD-JWT SDK.
     */
    private readonly cachedJwts = new BoundedTtlCache<string>({
        maxEntries: CACHE_MAX_ENTRIES,
        maxBytes: TOKEN_CACHE_MAX_BYTES,
    });

    /**
     * Cache of raw status list CWTs keyed by URI.
     * Used by the mDOC verifier, see {@link mdocFetch}.
     */
    private readonly cachedCwts = new BoundedTtlCache<Uint8Array>({
        maxEntries: CACHE_MAX_ENTRIES,
        maxBytes: TOKEN_CACHE_MAX_BYTES,
    });

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
        if (cached) {
            this.logger.debug(`Using cached status list for ${uri}`);
            return cached;
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

        this.cache.set(
            uri,
            statusList,
            // The token's size covers what the list keeps besides its
            // statuses, such as its aggregation_uri.
            tokenBytes(statusListToken) +
                statusList.totalStatuses * PARSED_BYTES_PER_STATUS,
            this.cacheExpiresAt(ttl, exp),
        );

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
            // Marks the list as unavailable for the best-effort revocation
            // policy: the message on the SD-JWT path
            // (isStatusListUnavailableError), the class on the mDOC path.
            throw new RevocationListUnavailableError(
                `Failed to fetch status list from ${uri}: ${error?.message || error}`,
            );
        }
    }

    /**
     * When a status list token fetched now leaves the cache: after its ttl
     * (in seconds, capped at {@link MAX_CACHE_TTL_MS}) or the default cache
     * time, and at its exp (epoch seconds) at the latest.
     */
    private cacheExpiresAt(ttl?: number, exp?: number): number {
        const ttlMs = ttl
            ? Math.min(ttl * 1000, MAX_CACHE_TTL_MS)
            : DEFAULT_CACHE_TTL_MS;
        const expiresAt = Date.now() + ttlMs;
        return exp ? Math.min(expiresAt, exp * 1000) : expiresAt;
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
     * Get cache statistics for monitoring. Expired entries are not counted.
     */
    getCacheStats(): { size: number; jwtCacheSize: number; uris: string[] } {
        this.cache.deleteExpired();
        this.cachedJwts.deleteExpired();
        this.cachedCwts.deleteExpired();
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
        if (cached) {
            this.logger.debug(`Using cached status list JWT for ${uri}`);
            return cached;
        }

        // Fetch and cache
        this.logger.debug(`Fetching status list JWT from ${uri}`);
        const token = await this.fetchStatusListToken(uri);
        if (typeof token !== "string") {
            throw new TypeError(
                `Status list at ${uri} returned CWT while JWT was requested`,
            );
        }
        // A copy: the token is trimmed from the response body, and V8 can keep
        // the whole body in memory for a trimmed string.
        const jwt = Buffer.from(token).toString();

        // Extract TTL and exp from the JWT payload
        const payload = decodeJwt(jwt);
        const ttl = typeof payload.ttl === "number" ? payload.ttl : undefined;
        const exp = typeof payload.exp === "number" ? payload.exp : undefined;

        this.cachedJwts.set(
            uri,
            jwt,
            tokenBytes(jwt),
            this.cacheExpiresAt(ttl, exp),
        );

        return jwt;
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
        if (cached) {
            this.logger.debug(`Using cached status list CWT for ${uri}`);
            return cached;
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
        this.cachedCwts.set(
            uri,
            token,
            tokenBytes(token),
            this.cacheExpiresAt(
                payload.timeToLive,
                payload.expirationTime
                    ? Math.floor(payload.expirationTime.getTime() / 1000)
                    : undefined,
            ),
        );

        return token;
    }

    /**
     * `fetch` for the mDOC verifier's `MdocContext`. @owf/mdoc downloads the
     * status list or ISO/IEC 18013-5 identifier list named in a presented
     * mDOC's MSO through it, so these requests get the outbound URL policy,
     * size limit and timeout of SD-JWT status lists, and status lists come
     * from the cache.
     *
     * A list that cannot be fetched, including a non-2xx response, is thrown
     * as {@link RevocationListUnavailableError} rather than returned, so the
     * best-effort revocation mode can tell it from an invalid or revoking list.
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
                throw new RevocationListUnavailableError(
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
