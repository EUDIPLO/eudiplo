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
            "Effective configuration of the tenant (global + tenant merge). Credentials are `<redacted>`; providers of the tenant are shown as stored, `${ENV_VAR}` placeholders included, and providers from the global configuration with their non-secret settings only.",
        type: KmsConfigDto,
    })
    effectiveConfig!: KmsConfig;
}
