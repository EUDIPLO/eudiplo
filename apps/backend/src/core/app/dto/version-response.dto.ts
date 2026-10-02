import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class VersionResponseDto {
    @ApiProperty({ description: "Running service version" })
    version!: string;

    @ApiPropertyOptional({
        description:
            "Git commit the service was built from. Clients compare it with their own revision to detect incompatible deployments.",
    })
    revision?: string;
}
