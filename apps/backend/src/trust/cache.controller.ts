import { Controller, Delete, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { requireTenantContext } from "../auth/tenant-context.util.js";
import { Token, type TokenPayload } from "../auth/token.decorator.js";
import { CacheStatsResponseDto } from "./dto/cache-stats-response.dto.js";
import { FederationTrustService } from "./federation-trust.service.js";
import { StatusListVerifierService } from "./status-list-verifier.service.js";
import { TrustStoreService } from "./trust-store.service.js";

/** What a caller clears with `DELETE /cache` and `/cache/trust-list`. */
const CLEAR_SCOPE =
    "With `issuance:manage` or `presentation:manage`, only the entries of the caller's tenant: its trust lists, and the status lists and OpenID Federation resolutions it used. Status lists and resolutions are shared, so another tenant that uses one of them too fetches it again. With `tenants:manage`, the entries of all tenants.";

/** What a caller sees with `GET /cache/stats`. */
const STATS_SCOPE =
    "With `issuance:manage` or `presentation:manage`, only the status lists the caller's tenant used; with `tenants:manage`, those of all tenants.";

/** What a caller clears with `DELETE /cache/status-list`. */
const STATUS_LIST_CLEAR_SCOPE =
    "With `issuance:manage` or `presentation:manage`, only the status lists the caller's tenant used; another tenant that uses one of them too fetches it again. With `tenants:manage`, those of all tenants.";

/**
 * The tenant whose cache entries the caller sees and clears, or undefined
 * for the whole instance. `tenants:manage` is the platform operator's role,
 * so it covers every tenant; any other caller needs a tenant.
 */
function cacheScope(token: TokenPayload): string | undefined {
    return token.roles.includes(Role.Tenants)
        ? undefined
        : requireTenantContext(token);
}

/**
 * Controller for managing trust and status list caches.
 * Useful for forcing a refresh when trust lists or status lists are known to have changed.
 * The caches are shared by all tenants; see {@link cacheScope} for what a
 * caller sees and clears.
 *
 * Note: Caches are stored in RAM only - a server restart will also clear them.
 * The trust list sequence numbers a tenant accepted are no cache: they are
 * kept in the database until `DELETE /cache/trust-list/sequence-numbers` or
 * deleting the tenant removes them.
 */
@ApiTags("Cache Management")
@Controller("cache")
// tenants:manage needs no tenant; cacheScope requires one for the other roles.
@Secured([Role.Issuances, Role.Presentations, Role.Tenants], {
    tenant: "optional",
})
export class CacheController {
    constructor(
        private readonly trustStoreService: TrustStoreService,
        private readonly statusListVerifierService: StatusListVerifierService,
        private readonly federationTrustService: FederationTrustService,
    ) {}

    /**
     * Get cache statistics for monitoring.
     */
    @Get("stats")
    @ApiOperation({
        summary: "Get cache statistics",
        description: `Returns statistics about the trust list and status list caches. ${STATS_SCOPE}`,
    })
    @ApiResponse({
        status: 200,
        description: "Cache statistics",
        type: CacheStatsResponseDto,
    })
    getStats(@Token() token: TokenPayload): CacheStatsResponseDto {
        const statusListStats = this.statusListVerifierService.getCacheStats(
            cacheScope(token),
        );
        return {
            trustListCache: {
                // Trust store has a single cache entry
                hasCache: true, // We can't easily check without accessing private property
            },
            statusListCache: {
                size: statusListStats.size,
                jwtCacheSize: statusListStats.jwtCacheSize,
                uris: statusListStats.uris,
            },
        };
    }

    /**
     * Clear all caches (trust lists, federation trust results and status lists).
     */
    @Delete()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: "Clear all caches",
        description: `Clears the trust list, OpenID Federation trust and status list caches. Next verification will fetch fresh data. ${CLEAR_SCOPE}`,
    })
    @ApiResponse({
        status: 204,
        description: "All caches cleared successfully",
    })
    clearAllCaches(@Token() token: TokenPayload) {
        const tenantId = cacheScope(token);
        this.trustStoreService.clearCache(tenantId);
        this.federationTrustService.clearTrustCache(tenantId);
        this.clearStatusLists(tenantId);
    }

    /**
     * Clear the trust caches (trust lists and federation trust results).
     */
    @Delete("trust-list")
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: "Clear trust list cache",
        description: `Clears the trust list cache and the OpenID Federation trust cache. Next verification will fetch fresh trust lists and re-evaluate federation trust. ${CLEAR_SCOPE}`,
    })
    @ApiResponse({
        status: 204,
        description: "Trust list cache cleared successfully",
    })
    clearTrustListCache(@Token() token: TokenPayload) {
        const tenantId = cacheScope(token);
        this.trustStoreService.clearCache(tenantId);
        this.federationTrustService.clearTrustCache(tenantId);
    }

    /**
     * Forget the trust list sequence numbers the caller's tenant accepted.
     */
    @Delete("trust-list/sequence-numbers")
    // Tenant roles only: this one acts on the caller's tenant.
    @Secured([Role.Issuances, Role.Presentations])
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: "Forget accepted trust list sequence numbers",
        description:
            "EUDIPLO remembers, per tenant and trust list URL, the highest LoTESequenceNumber it accepted, and discards a list numbered lower as an older version. This forgets the numbers of the caller's tenant and clears its trust list cache, so a list whose publisher numbered it from 1 again is accepted. Until a list is fetched again, an older version of it is accepted too. Lists managed by this EUDIPLO instance are compared with their stored number and are not affected.",
    })
    @ApiResponse({
        status: 204,
        description: "Sequence numbers forgotten",
    })
    async forgetTrustListSequenceNumbers(@Token() token: TokenPayload) {
        await this.trustStoreService.forgetSequenceNumbers(
            requireTenantContext(token),
        );
    }

    /**
     * Clear the status list (revocation) cache.
     */
    @Delete("status-list")
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: "Clear status list cache",
        description: `Clears the status list (revocation) cache. Next status check will fetch fresh status lists. ${STATUS_LIST_CLEAR_SCOPE}`,
    })
    @ApiResponse({
        status: 204,
        description: "Status list cache cleared successfully",
    })
    clearStatusListCache(@Token() token: TokenPayload) {
        this.clearStatusLists(cacheScope(token));
    }

    private clearStatusLists(tenantId: string | undefined) {
        if (tenantId === undefined) {
            this.statusListVerifierService.clearCache();
        } else {
            this.statusListVerifierService.clearTenantCache(tenantId);
        }
    }
}
