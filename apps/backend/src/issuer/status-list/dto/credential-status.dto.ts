import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * The current status of one credential issued in a session, as published in
 * its status list.
 */
export class CredentialStatusDto {
    @ApiProperty({
        description: "Credential configuration the credential was issued for.",
    })
    credentialConfigurationId!: string;

    @ApiProperty({ description: "ID of the status list holding the entry." })
    statusListId!: string;

    @ApiProperty({ description: "Index of the entry in the status list." })
    index!: number;

    @ApiProperty({
        description:
            "Current status: 0 = valid, 1 = revoked, 2 = suspended. Lists with more bits per entry can hold higher values.",
    })
    status!: number;

    @ApiProperty({
        description:
            "Bits per entry of the status list. Suspension (2) needs at least 2.",
        enum: [1, 2, 4, 8],
    })
    bits!: number;

    @ApiPropertyOptional({
        description:
            "When the status value last changed, through POST /api/session/revoke or the active-credential limit (ISO 8601). Absent if it has not changed since issuance, or only changed before this field was recorded.",
        format: "date-time",
    })
    statusUpdatedAt?: string;
}
