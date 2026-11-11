import { inflateSync } from "node:zlib";
import { Injectable, Logger } from "@nestjs/common";
import {
    StatusListCwt,
    StatusListEntry,
    StatusType,
} from "@owf/token-status-list";
import { base64url, decodeJwt, decodeProtectedHeader } from "jose";
import { BoundedTtlCache } from "../shared/utils/bounded-ttl-cache.js";
import { toBuffer } from "../shared/utils/buffer.util.js";
import {
    isAbsoluteUri,
    MalformedStatusReferenceError,
    parseStatusListReference,
} from "./domain/status-list-reference.js";
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

/**
 * Upper bound for the decompressed `lst` of a status list token, 128 million
 * statuses at one bit each. DEFLATE compresses a list of equal statuses about
 * a thousandfold, so the compressed size does not bound this.
 */
const STATUS_LIST_MAX_INFLATED_BYTES = 16 * 1024 * 1024;

const STATUS_LIST_JWT_TYPES = new Set([
    "statuslist+jwt",
    "application/statuslist+jwt",
]);

/** Byte budget of the parsed status lists. */
const PARSED_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Memory a status list token takes, or more. A string is counted at two
 * bytes per character, the most V8 stores one with.
 */
function tokenBytes(token: string | Uint8Array): number {
    return typeof token === "string" ? token.length * 2 : token.byteLength;
}

/**
 * A status list token that must not be used: its claims do not meet
 * draft-ietf-oauth-status-list Section 8.3 for the referenced token, or its
 * list cannot be read.
 */
export class InvalidStatusListTokenError extends Error {}

/** The index a referenced token names is outside its status list. */
export class StatusListIndexOutOfRange extends InvalidStatusListTokenError {}

/**
 * The status at `index` of a decompressed status list: `bits` bits per
 * status, the first status in the least significant bits of the first byte
 * (draft-ietf-oauth-status-list Section 4.1).
 */
function readStatus(bytes: Uint8Array, bits: number, index: number): number {
    const bitOffset = index * bits;
    if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        bitOffset >= bytes.byteLength * 8
    ) {
        throw new StatusListIndexOutOfRange(
            `Status list index ${index} is outside the list`,
        );
    }
    return (
        (bytes[Math.floor(bitOffset / 8)] >> (bitOffset % 8)) &
        ((1 << bits) - 1)
    );
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

    /**
     * Decompressed lists of status list JWTs keyed by URI, see
     * {@link inflatedList}.
     */
    private readonly inflatedLists = new BoundedTtlCache<{
        jwt: string;
        bytes: Uint8Array;
    }>({
        maxEntries: CACHE_MAX_ENTRIES,
        maxBytes: PARSED_CACHE_MAX_BYTES,
    });

    constructor(private readonly trustFetch: TrustFetchService) {}

    /**
     * Get the `status_list` reference (uri and idx) of a JWT's `status`
     * claim, see {@link parseStatusListReference}.
     *
     * @param jwt The JWT that may contain a status claim
     * @returns The status list entry reference, or undefined if the JWT has
     * no `status_list` reference
     * @throws Error if the JWT cannot be decoded, and
     * MalformedStatusReferenceError if its `status` claim or `status_list`
     * reference is malformed
     */
    getStatusEntryFromJwt(jwt: string): StatusListEntry | undefined {
        return parseStatusListReference(decodeJwt(jwt).status);
    }

    /**
     * Read the status of a referenced token from a status list JWT the
     * caller already holds and whose signature it verified. Nothing is
     * fetched, so the status comes from that same token.
     *
     * The token is checked as in draft-ietf-oauth-status-list Section 8.3
     * step 4: `typ` is `statuslist+jwt`, `sub` is the URI the referenced
     * token names, `iat` is present and `exp`, if present, has not passed.
     * Without the `sub` check, the host of the URI could serve another list
     * signed by the same key, in which the index is valid.
     *
     * @param statusListJwt The status list JWT
     * @param entry The `status_list` claim of the referenced token
     * @param clockToleranceSeconds Clock skew allowed for `exp`
     * @returns The status check result
     * @throws InvalidStatusListTokenError if the token must not be used
     */
    getStatusFromStatusListJwt(
        statusListJwt: string,
        entry: StatusListEntry,
        clockToleranceSeconds = 0,
    ): StatusCheckResult {
        let header: ReturnType<typeof decodeProtectedHeader>;
        let payload: ReturnType<typeof decodeJwt>;
        try {
            header = decodeProtectedHeader(statusListJwt);
            payload = decodeJwt(statusListJwt);
        } catch (error: any) {
            throw new InvalidStatusListTokenError(
                `Status list token cannot be decoded: ${error?.message ?? error}`,
            );
        }

        const typ = typeof header.typ === "string" ? header.typ : undefined;
        if (!typ || !STATUS_LIST_JWT_TYPES.has(typ.toLowerCase())) {
            throw new InvalidStatusListTokenError(
                `Status list token has typ ${typ ?? "(none)"}, expected statuslist+jwt`,
            );
        }
        if (payload.sub !== entry.uri) {
            throw new InvalidStatusListTokenError(
                `Status list token sub ${payload.sub ?? "(none)"} does not match the status list URI ${entry.uri}`,
            );
        }
        if (typeof payload.iat !== "number") {
            throw new InvalidStatusListTokenError(
                "Status list token has no iat",
            );
        }
        const now = Math.floor(Date.now() / 1000);
        if (
            payload.exp !== undefined &&
            (typeof payload.exp !== "number" ||
                payload.exp + clockToleranceSeconds <= now)
        ) {
            throw new InvalidStatusListTokenError(
                "Status list token has expired",
            );
        }

        const claim = payload.status_list as
            | { bits?: unknown; lst?: unknown }
            | undefined;
        const bits = claim?.bits;
        if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8) {
            throw new InvalidStatusListTokenError(
                "Status list token has no valid status_list.bits",
            );
        }
        if (typeof claim?.lst !== "string") {
            throw new InvalidStatusListTokenError(
                "Status list token has no status_list.lst",
            );
        }

        const bytes = this.inflatedList(
            statusListJwt,
            entry.uri,
            claim.lst,
            typeof payload.ttl === "number" ? payload.ttl : undefined,
            payload.exp,
        );
        const status = readStatus(bytes, bits, entry.idx);

        return {
            status,
            isValid: status === StatusType.Valid,
            description: this.getStatusDescription(status),
        };
    }

    /**
     * The decompressed `lst` of a status list JWT, from cache while the same
     * token is served for the URI. Token requests of one wallet then do not
     * decompress the list every time.
     */
    private inflatedList(
        jwt: string,
        uri: string,
        lst: string,
        ttl?: number,
        exp?: number,
    ): Uint8Array {
        const cached = this.inflatedLists.get(uri);
        if (cached?.jwt === jwt) {
            return cached.bytes;
        }

        let bytes: Uint8Array;
        try {
            bytes = inflateSync(base64url.decode(lst), {
                maxOutputLength: STATUS_LIST_MAX_INFLATED_BYTES,
            });
        } catch (error: any) {
            throw new InvalidStatusListTokenError(
                `Status list cannot be decompressed (at most ${STATUS_LIST_MAX_INFLATED_BYTES} bytes): ${error?.message ?? error}`,
            );
        }

        // The token is counted too: it stays in memory through this entry
        // after getStatusListJwt's cache evicts it.
        this.inflatedLists.set(
            uri,
            { jwt, bytes },
            tokenBytes(jwt) + bytes.byteLength,
            this.cacheExpiresAt(ttl, exp),
        );
        return bytes;
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
            this.cachedJwts.delete(uri);
            this.cachedCwts.delete(uri);
            this.inflatedLists.delete(uri);
        } else {
            this.cachedJwts.clear();
            this.cachedCwts.clear();
            this.inflatedLists.clear();
        }
    }

    /**
     * Get cache statistics for monitoring. Expired entries are not counted.
     */
    getCacheStats(): { size: number; jwtCacheSize: number; uris: string[] } {
        this.cachedJwts.deleteExpired();
        this.cachedCwts.deleteExpired();
        this.inflatedLists.deleteExpired();
        return {
            size: this.inflatedLists.size,
            jwtCacheSize: this.cachedJwts.size,
            uris: Array.from(
                new Set([
                    ...this.cachedJwts.keys(),
                    ...this.cachedCwts.keys(),
                    ...this.inflatedLists.keys(),
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
     * @owf/mdoc decodes a status list `idx` as a non-negative integer and a
     * `uri` as a string, but passes any string here: a `uri` that is not an
     * absolute URI is thrown as {@link MalformedStatusReferenceError} and
     * not fetched, so best-effort mode does not take it for an unavailable
     * list.
     */
    readonly mdocFetch: typeof fetch = async (input, init) => {
        const uri = input instanceof Request ? input.url : input.toString();
        if (!isAbsoluteUri(uri)) {
            throw new MalformedStatusReferenceError(
                "The MSO references a status list or identifier list whose uri is not an absolute URI",
            );
        }
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
