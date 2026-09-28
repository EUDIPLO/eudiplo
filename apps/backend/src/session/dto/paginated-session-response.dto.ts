import { ApiProperty } from "@nestjs/swagger";
import type { SessionSummary } from "../domain/session-list.js";
import { Session } from "../entities/session.entity.js";

/**
 * Paginated response for the session list endpoint.
 */
export class PaginatedSessionResponseDto {
    /**
     * The sessions for the current page.
     */
    @ApiProperty({ type: [Session] })
    items!: SessionSummary[];

    /**
     * Total number of sessions matching the query.
     */
    @ApiProperty({ description: "Total number of sessions matching the query" })
    total!: number;

    /**
     * Current page number (1-based).
     */
    @ApiProperty({ description: "Current page number (1-based)" })
    page!: number;

    /**
     * Number of items per page.
     */
    @ApiProperty({ description: "Number of items per page" })
    pageSize!: number;

    /**
     * Total number of pages.
     */
    @ApiProperty({ description: "Total number of pages" })
    totalPages!: number;
}
