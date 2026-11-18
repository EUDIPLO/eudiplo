import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
    orderedRange,
    repeatable,
    timestamp,
} from "../../shared/common/zod/query-params.js";
import type { AuditLogFilter } from "../audit-log.service.js";
import {
    AUDIT_ACTION_TYPES,
    AUDIT_ACTOR_TYPES,
    AUDIT_OBJECT_TYPES,
    type AuditActionType,
    type AuditActorType,
    type AuditObjectType,
} from "../audit-action-types.js";

const MAX_ID_LENGTH = 255;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const identifier = z.string().trim().min(1).max(MAX_ID_LENGTH);

const filterFields = {
    from: timestamp.optional(),
    to: timestamp.optional(),
    actionType: repeatable(z.enum(AUDIT_ACTION_TYPES)).optional(),
    objectType: z.enum(AUDIT_OBJECT_TYPES).optional(),
    actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
    actorId: identifier.optional(),
    requestId: identifier.optional(),
    q: identifier.optional(),
};

/**
 * Describes the filters in the OpenAPI document. The Zod schemas validate;
 * these decorators only document the parameters of both endpoints.
 */
function documentFilters(target: object): void {
    const docs: Record<keyof AuditLogFilter, PropertyDecorator> = {
        from: ApiPropertyOptional({
            type: String,
            format: "date-time",
            description:
                "Only entries recorded at or after this time (ISO 8601 with offset)",
        }),
        to: ApiPropertyOptional({
            type: String,
            format: "date-time",
            description:
                "Only entries recorded at or before this time (ISO 8601 with offset)",
        }),
        actionType: ApiPropertyOptional({
            enum: AUDIT_ACTION_TYPES,
            isArray: true,
            description:
                "Filter by action. Repeat the parameter to match any of several actions.",
        }),
        objectType: ApiPropertyOptional({
            enum: AUDIT_OBJECT_TYPES,
            description:
                "Filter by the kind of object an action is about, e.g. `oidc_client` for the actions on OpenID Connect clients but not on their secrets. Combined with `actionType`, both must match.",
        }),
        actorType: ApiPropertyOptional({
            enum: AUDIT_ACTOR_TYPES,
            description: "Filter by the kind of actor",
        }),
        actorId: ApiPropertyOptional({
            description: "Id of the user or client that acted (exact match)",
            maxLength: MAX_ID_LENGTH,
        }),
        requestId: ApiPropertyOptional({
            description:
                "The `X-Request-Id` header of the call that caused the entry (exact match). Recorded only when the caller or a reverse proxy sets the header.",
            maxLength: MAX_ID_LENGTH,
        }),
        q: ApiPropertyOptional({
            description:
                "Text to find, ignoring case, in the action (as written, `credential_config_created`, or as the web client shows it, `Credential Config Created`), in the id or name of the actor, or in the name of a changed field",
            maxLength: MAX_ID_LENGTH,
        }),
    };
    for (const [name, decorate] of Object.entries(docs)) decorate(target, name);
}

const AuditLogListQuerySchema = z
    .object({
        ...filterFields,
        // Read with parseInt as before the filters existed: a missing or
        // unreadable limit means the default, an out-of-range one is clamped.
        limit: z.preprocess(
            (value) => {
                const parsed = Number.parseInt(String(value ?? ""), 10);
                return Number.isNaN(parsed) ? undefined : parsed;
            },
            // parseInt already gave an integer; any size is clamped.
            z
                .number()
                .default(DEFAULT_LIMIT)
                .transform((limit) => Math.max(1, Math.min(limit, MAX_LIMIT))),
        ),
    })
    .refine(...orderedRange("from", "to"));

/**
 * Query of `GET /admin/audit-logs`: the newest entries that match the
 * filters, at most `limit`. Unknown parameters are ignored, as they were
 * before the filters existed.
 */
export class AuditLogListQueryDto
    extends createZodDto(AuditLogListQuerySchema)
    implements AuditLogFilter
{
    declare from?: Date;
    declare to?: Date;
    declare actionType?: AuditActionType[];
    declare objectType?: AuditObjectType;
    declare actorType?: AuditActorType;
    declare actorId?: string;
    declare requestId?: string;
    declare q?: string;

    @ApiPropertyOptional({
        type: Number,
        description: `Maximum number of entries to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
    })
    limit: number = DEFAULT_LIMIT;
}
documentFilters(AuditLogListQueryDto.prototype);

const AuditLogSearchQuerySchema = z
    .object({
        ...filterFields,
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
    })
    .strict()
    .refine(...orderedRange("from", "to"));

/**
 * Query of `GET /admin/audit-logs/search`: one page of the entries that match
 * the filters, newest first.
 */
export class AuditLogSearchQueryDto
    extends createZodDto(AuditLogSearchQuerySchema)
    implements AuditLogFilter
{
    declare from?: Date;
    declare to?: Date;
    declare actionType?: AuditActionType[];
    declare objectType?: AuditObjectType;
    declare actorType?: AuditActorType;
    declare actorId?: string;
    declare requestId?: string;
    declare q?: string;

    @ApiPropertyOptional({
        description: "Page number (1-based)",
        default: 1,
        minimum: 1,
    })
    page: number = 1;

    @ApiPropertyOptional({
        description: "Number of entries per page",
        default: 25,
        minimum: 1,
        maximum: 100,
    })
    pageSize: number = 25;
}
documentFilters(AuditLogSearchQueryDto.prototype);
