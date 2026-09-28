import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { SessionListQuery } from "../domain/session-list.js";
import { SessionStatus } from "../domain/session-state.js";

const SessionQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        status: z.enum(SessionStatus).optional(),
        type: z.enum(["issuance", "presentation"]).optional(),
        sortBy: z.enum(["id", "status", "createdAt", "requestId"]).optional(),
        sortOrder: z.enum(["asc", "desc"]).optional(),
    })
    .strict();

/**
 * Query parameters for filtering and paginating the session list.
 */
export class SessionQueryDto
    extends createZodDto(SessionQuerySchema)
    implements SessionListQuery
{
    /**
     * Page number (1-based).
     */
    @ApiPropertyOptional({
        description: "Page number (1-based)",
        default: 1,
        minimum: 1,
    })
    page: number = 1;

    /**
     * Number of items per page (max 100).
     */
    @ApiPropertyOptional({
        description: "Number of items per page",
        default: 25,
        minimum: 1,
        maximum: 100,
    })
    pageSize: number = 25;

    /**
     * Filter sessions by status.
     */
    @ApiPropertyOptional({
        enum: SessionStatus,
        description: "Filter by session status",
    })
    status?: SessionStatus;

    /**
     * Filter sessions by type (issuance or presentation).
     */
    @ApiPropertyOptional({
        enum: ["issuance", "presentation"],
        description: "Filter by session type",
    })
    type?: SessionListQuery["type"];

    /**
     * Field to sort by.
     */
    @ApiPropertyOptional({
        enum: ["id", "status", "createdAt", "requestId"],
        description: "Field to sort by",
    })
    sortBy?: SessionListQuery["sortBy"];

    /**
     * Sort order (asc or desc).
     */
    @ApiPropertyOptional({
        enum: ["asc", "desc"],
        description: "Sort direction",
    })
    sortOrder?: SessionListQuery["sortOrder"];
}
