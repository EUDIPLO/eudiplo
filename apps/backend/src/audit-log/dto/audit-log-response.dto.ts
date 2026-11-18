import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
    AUDIT_ACTION_TYPES,
    AUDIT_ACTOR_TYPES,
    type AuditActionType,
    type AuditActorType,
} from "../audit-action-types.js";

export class AuditLogResponseDto {
    @ApiProperty()
    id!: string;

    @ApiProperty()
    tenantId!: string;

    @ApiProperty({ enum: AUDIT_ACTION_TYPES })
    actionType!: AuditActionType;

    @ApiProperty({ enum: AUDIT_ACTOR_TYPES })
    actorType!: AuditActorType;

    @ApiPropertyOptional()
    actorId?: string;

    @ApiPropertyOptional()
    actorDisplay?: string;

    @ApiPropertyOptional({ type: [String] })
    changedFields?: string[];

    @ApiPropertyOptional({ type: "object", additionalProperties: true })
    before?: Record<string, unknown>;

    @ApiPropertyOptional({ type: "object", additionalProperties: true })
    after?: Record<string, unknown>;

    @ApiPropertyOptional()
    requestId?: string;

    @ApiProperty()
    timestamp!: Date;
}
