import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
    SESSION_SORT_FIELDS,
    type SessionListQuery,
} from "../domain/session-list.js";
import { isUuidPrefix } from "../domain/session-search.js";
import { SessionStatus } from "../domain/session-state.js";

const MAX_ID_LENGTH = 255;
const MAX_SEARCH_LENGTH = 4096;

// ISO 8601 with an explicit offset, so the range never depends on server time zone.
const timestamp = z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value));
const identifier = z.string().trim().min(1).max(MAX_ID_LENGTH);

const SessionQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        // A repeated query parameter arrives as an array, a single one as a string.
        status: z
            .union([z.enum(SessionStatus), z.array(z.enum(SessionStatus))])
            .transform((value) => (Array.isArray(value) ? value : [value]))
            .optional(),
        type: z.enum(["issuance", "presentation"]).optional(),
        createdFrom: timestamp.optional(),
        createdTo: timestamp.optional(),
        updatedFrom: timestamp.optional(),
        updatedTo: timestamp.optional(),
        requestId: identifier.optional(),
        credentialConfigurationId: identifier.optional(),
        failureCode: identifier.optional(),
        id: z
            .string()
            .trim()
            .refine(isUuidPrefix, "id must be the beginning of a session id")
            .optional(),
        q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
        sortBy: z.enum(SESSION_SORT_FIELDS).optional(),
        sortOrder: z.enum(["asc", "desc"]).optional(),
    })
    .strict()
    .refine(
        (query) =>
            !query.createdFrom ||
            !query.createdTo ||
            query.createdFrom <= query.createdTo,
        {
            message: "createdFrom must not be after createdTo",
            path: ["createdFrom"],
        },
    )
    .refine(
        (query) =>
            !query.updatedFrom ||
            !query.updatedTo ||
            query.updatedFrom <= query.updatedTo,
        {
            message: "updatedFrom must not be after updatedTo",
            path: ["updatedFrom"],
        },
    );

/**
 * Query parameters for filtering and paginating the session list.
 * All filters are combined (AND) and scoped to the caller's tenant.
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
     * Filter sessions by status. Repeat the parameter to match any of several
     * statuses, e.g. `status=active&status=fetched` for pending sessions.
     */
    @ApiPropertyOptional({
        enum: SessionStatus,
        isArray: true,
        description:
            "Filter by session status. Repeat the parameter to match any of several statuses.",
    })
    status?: SessionStatus[];

    /**
     * Filter sessions by type (issuance or presentation).
     */
    @ApiPropertyOptional({
        enum: ["issuance", "presentation"],
        description: "Filter by session type",
    })
    type?: SessionListQuery["type"];

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description: "Only sessions created at or after this time (ISO 8601)",
    })
    createdFrom?: Date;

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description: "Only sessions created at or before this time (ISO 8601)",
    })
    createdTo?: Date;

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description:
            "Only sessions last updated at or after this time (ISO 8601)",
    })
    updatedFrom?: Date;

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description:
            "Only sessions last updated at or before this time (ISO 8601)",
    })
    updatedTo?: Date;

    @ApiPropertyOptional({
        description: "Presentation configuration id (exact match)",
        maxLength: MAX_ID_LENGTH,
    })
    requestId?: string;

    @ApiPropertyOptional({
        description:
            "Credential configuration id of an issuance offer (exact match). Only sessions created since this filter exists record it.",
        maxLength: MAX_ID_LENGTH,
    })
    credentialConfigurationId?: string;

    @ApiPropertyOptional({
        description: "Machine-readable failure code (exact match)",
        maxLength: MAX_ID_LENGTH,
    })
    failureCode?: string;

    @ApiPropertyOptional({
        description: "Beginning of the session id",
        example: "3f2a",
    })
    id?: string;

    @ApiPropertyOptional({
        description:
            "Search term: a session id or its beginning, a wallet nonce, a pre-authorized code, a caller reference, or a pasted credential offer or OID4VP request link.",
        maxLength: MAX_SEARCH_LENGTH,
    })
    q?: string;

    /**
     * Field to sort by.
     */
    @ApiPropertyOptional({
        enum: SESSION_SORT_FIELDS,
        description: "Field to sort by (default: updatedAt)",
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
