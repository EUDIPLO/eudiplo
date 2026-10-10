import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { SessionStatus } from "../domain/session-state.js";

/**
 * Number of sessions per status. Lists every status of `SessionStatus`;
 * a status without sessions counts 0.
 */
export class SessionStatusCountsDto
    implements Record<`${SessionStatus}`, number>
{
    @ApiProperty({ description: "Sessions waiting for the wallet" })
    active!: number;

    @ApiProperty({
        description:
            "Issuance: first credential issued. Presentation: the wallet fetched the request object.",
    })
    fetched!: number;

    @ApiProperty({
        description:
            "Issuance: the wallet reported credential_accepted. Presentation: response verified.",
    })
    completed!: number;

    @ApiProperty({ description: "Sessions that expired before completion" })
    expired!: number;

    @ApiProperty({
        description:
            "Issuance: the wallet reported credential_failure or credential_deleted. Presentation: verification failed, or the wallet sent an error.",
    })
    failed!: number;

    @ApiProperty({
        description: "Offers and requests an operator cancelled",
    })
    cancelled!: number;
}

/**
 * Session counts of one type.
 */
export class SessionTypeStatsDto {
    @ApiProperty({ description: "Number of sessions of this type" })
    total!: number;

    @ApiProperty({
        type: SessionStatusCountsDto,
        description:
            "Number of sessions per status, 0 for a status without any",
    })
    byStatus!: SessionStatusCountsDto;

    @ApiProperty({
        type: String,
        format: "date-time",
        nullable: true,
        description:
            "Last update of the most recently updated completed session, or null when none completed",
    })
    lastCompletedAt!: Date | null;
}

/**
 * Session counts of the caller's tenant. A type is present only when the
 * caller may read its sessions, as in the session list.
 */
export class SessionStatsResponseDto {
    @ApiPropertyOptional({
        type: SessionTypeStatsDto,
        description:
            "Issuance sessions; present only when the caller may read them, as in GET /api/session",
    })
    issuance?: SessionTypeStatsDto;

    @ApiPropertyOptional({
        type: SessionTypeStatsDto,
        description:
            "Presentation sessions; present only when the caller may read them, as in GET /api/session",
    })
    presentation?: SessionTypeStatsDto;
}
