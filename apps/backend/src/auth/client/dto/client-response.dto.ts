import {
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
    ApiSchema,
} from "@nestjs/swagger";
import { Role } from "../../roles/role.enum.js";

/**
 * Public client representation. The OpenAPI schema keeps its historical name
 * `ClientEntity` so generated SDKs and existing consumers remain compatible.
 */
@ApiSchema({ name: "ClientEntity" })
export class ClientResponseDto {
    @ApiProperty({ description: "Unique client identifier" })
    clientId!: string;

    @ApiPropertyOptional({
        description: "Tenant identifier the client belongs to",
    })
    tenantId?: string | null;

    @ApiPropertyOptional({ description: "Client description" })
    description?: string | null;

    @ApiProperty({
        enum: Role,
        isArray: true,
        description: "Roles assigned to the client",
    })
    roles!: Role[];

    @ApiPropertyOptional({
        type: [String],
        nullable: true,
        description:
            "List of presentation config IDs this client can use. If empty/null, all configs are allowed.",
    })
    allowedPresentationConfigs?: string[] | null;

    @ApiPropertyOptional({
        type: [String],
        nullable: true,
        description:
            "List of issuance config IDs this client can use. If empty/null, all configs are allowed.",
    })
    allowedIssuanceConfigs?: string[] | null;

    @ApiHideProperty()
    clientSecret?: string;
}
