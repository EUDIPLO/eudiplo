import { ApiProperty } from "@nestjs/swagger";

class TrustListCacheStatsDto {
    @ApiProperty({ description: "Whether the trust list cache is populated" })
    hasCache!: boolean;
}

/**
 * The status lists of the caller's tenant, or of all tenants for
 * `tenants:manage`.
 */
class StatusListCacheStatsDto {
    @ApiProperty({
        description:
            "Number of cached status list entries: those the caller's tenant used, or all for `tenants:manage`",
    })
    size!: number;

    @ApiProperty({
        description:
            "Number of cached JWT status list entries: those the caller's tenant used, or all for `tenants:manage`",
    })
    jwtCacheSize!: number;

    @ApiProperty({
        description:
            "Cached status list URIs: those the caller's tenant used, or all for `tenants:manage`",
        type: [String],
    })
    uris!: string[];
}

export class CacheStatsResponseDto {
    @ApiProperty({ type: TrustListCacheStatsDto })
    trustListCache!: TrustListCacheStatsDto;

    @ApiProperty({ type: StatusListCacheStatsDto })
    statusListCache!: StatusListCacheStatsDto;
}
