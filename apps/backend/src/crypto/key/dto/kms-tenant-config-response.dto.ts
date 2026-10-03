import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { KmsConfig } from "../schemas/kms-config.schema.js";
import { KmsConfigDto } from "./kms-config.dto.js";

export class KmsTenantConfigResponseDto {
    @ApiPropertyOptional({
        description:
            "Tenant-specific KMS configuration from <CONFIG_FOLDER>/<tenantId>/kms.json. Null when no tenant file exists. Credentials are `<redacted>`; `${ENV_VAR}` placeholders are returned as stored.",
        type: KmsConfigDto,
    })
    tenantConfig?: KmsConfig | null;

    @ApiProperty({
        description:
            "Effective configuration used at runtime for the tenant (global + tenant merge). Credentials are `<redacted>`; providers from the global configuration are shown with their non-secret settings only.",
        type: KmsConfigDto,
    })
    effectiveConfig!: KmsConfig;
}
