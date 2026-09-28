import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { ClientResponseDto } from "../../client/dto/client-response.dto.js";
import { TenantEntity } from "../entities/tenant.entity.js";

export class TenantClientCredentialsDto {
    @ApiProperty({ description: "Generated client identifier" })
    clientId!: string;

    @ApiProperty({ description: "Generated client secret" })
    clientSecret!: string;
}

const TenantBaseResponseDto = OmitType(TenantEntity, ["clients"] as const);

export class TenantCreateResponseDto extends TenantBaseResponseDto {
    @ApiPropertyOptional({
        description: "One-time generated client credentials for admin access",
        type: TenantClientCredentialsDto,
    })
    client?: TenantClientCredentialsDto;
}

export class TenantResponseDto extends TenantBaseResponseDto {
    @ApiPropertyOptional({
        description: "Managed clients attached to the tenant",
        type: [ClientResponseDto],
    })
    clients?: ClientResponseDto[];
}
