import {
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
} from "@nestjs/swagger";
import { Role } from "../../roles/role.enum.js";

export class ClientResponseDto {
    @ApiProperty({ description: "Unique client identifier" })
    clientId!: string;

    @ApiPropertyOptional({
        description: "Tenant identifier the client belongs to",
    })
    tenantId?: string | null;

    @ApiPropertyOptional({ description: "Client description" })
    description?: string | null;

    @ApiProperty({ enum: Role, isArray: true })
    roles!: Role[];

    @ApiPropertyOptional({ type: [String] })
    allowedPresentationConfigs?: string[] | null;

    @ApiPropertyOptional({ type: [String] })
    allowedIssuanceConfigs?: string[] | null;

    @ApiHideProperty()
    clientSecret?: string;
}
