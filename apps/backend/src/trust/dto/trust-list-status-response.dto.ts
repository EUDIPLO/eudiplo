import { ApiProperty } from "@nestjs/swagger";
import type { TrustListFetchOutcome } from "../ports/trust-list-fetch-statuses.js";

/** Every outcome once; a new one fails to compile until it is listed. */
const OUTCOMES = Object.keys({
    accepted: true,
    outdated: true,
    superseded: true,
    invalidSequenceNumber: true,
    tooManyCertificates: true,
    failed: true,
} satisfies Record<TrustListFetchOutcome, true>) as TrustListFetchOutcome[];

/** How the last load of one trust list ended for the caller's tenant. */
export class TrustListStatusResponseDto {
    @ApiProperty({
        description:
            "URL of the list. A managed list referenced by ID is named by its URL below PUBLIC_URL.",
    })
    url!: string;

    @ApiProperty({
        description: "ID of the managed list, when it was referenced by ID",
        type: String,
        nullable: true,
    })
    trustListId!: string | null;

    @ApiProperty({
        description:
            "How the last load ended: `accepted`; `outdated` (no valid NextUpdate, one that has passed, or a closed list); `superseded` (LoTESequenceNumber lower than one accepted before); `invalidSequenceNumber`; `tooManyCertificates` (its source went over the certificate limit with it); `failed` (not fetched, verified or parsed). Only `accepted` lists add trust.",
        enum: OUTCOMES,
        enumName: "TrustListFetchOutcome",
    })
    outcome!: TrustListFetchOutcome;

    @ApiProperty({
        description: "Why the list was not accepted",
        type: String,
        nullable: true,
    })
    reason!: string | null;

    @ApiProperty({
        description: "When the list was last loaded, whatever the outcome",
        type: String,
        format: "date-time",
    })
    checkedAt!: Date;

    @ApiProperty({
        description:
            "When the list was last fetched and its signature verified",
        type: String,
        format: "date-time",
        nullable: true,
    })
    verifiedAt!: Date | null;

    @ApiProperty({
        description: "When the list was last accepted",
        type: String,
        format: "date-time",
        nullable: true,
    })
    acceptedAt!: Date | null;

    @ApiProperty({
        description:
            "NextUpdate as signed in the last verified list; null for a closed list or none verified yet",
        type: String,
        nullable: true,
    })
    nextUpdate!: string | null;

    @ApiProperty({
        description:
            "LoTESequenceNumber of the last verified list, when it is a whole number from 1",
        type: Number,
        nullable: true,
    })
    sequenceNumber!: number | null;

    @ApiProperty({
        description: "Number of entities in the last verified list",
        type: Number,
        nullable: true,
    })
    entities!: number | null;
}
