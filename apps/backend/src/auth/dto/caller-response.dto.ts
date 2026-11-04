import { ApiProperty } from "@nestjs/swagger";

/**
 * The caller of the management API as the backend resolved it from the access
 * token, so the web client shows what the backend allows.
 */
export class CallerResponseDto {
    @ApiProperty({
        description:
            "Subject of the access token: the client ID for tokens of the built-in server, the `sub` claim with an external OIDC provider.",
        type: String,
        nullable: true,
        example: "my-client",
    })
    subject!: string | null;

    @ApiProperty({
        description:
            "ID of the caller's tenant, or null for a caller without one, such as the root client or a token whose tenant does not exist.",
        type: String,
        nullable: true,
        example: "my-tenant",
    })
    tenantId!: string | null;

    @ApiProperty({
        description:
            "Roles the backend grants the caller. With an external OIDC provider they may include role names EUDIPLO does not know.",
        type: [String],
        example: ["issuance:offer", "sessions:read"],
    })
    roles!: string[];
}
