import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../../audit-log/audit-log-context.util.js";
import { Role } from "../../../auth/roles/role.enum.js";
import { Secured } from "../../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../../auth/token.decorator.js";
import { createConfigBodyPipe } from "../../../shared/common/zod/zod-schema.util.js";
import {
    assertUpstreamSecretsKeptOnlyForSameIssuer,
    redactSecrets,
    restoreSecrets,
} from "../../../shared/utils/write-only-secrets.util.js";
import type { IssuanceConfiguration } from "./domain/issuance-configuration.js";
import { IssuanceDto } from "./dto/issuance.dto.js";
import { UpdateIssuanceDto } from "./dto/update-issuance.dto.js";
import { IssuanceConfig } from "./entities/issuance-config.entity.js";
import { IssuanceService } from "./issuance.service.js";
import { IssuanceConfigSchema } from "./schemas/issuance.schema.js";

/** Fields a GET response adds to the configuration. */
const readOnly = [
    "tenantId",
    "tenant",
    "registrationCertificateCache",
    "createdAt",
    "updatedAt",
];

/**
 * Upstream client secrets of chained servers are write-only: returned as
 * `<redacted>`, which keeps the stored secret of the server with the same id.
 */
const SECRET = "authorizationServers.*.upstream.clientSecret";
const redact = (config: IssuanceConfiguration) => redactSecrets(config, SECRET);

@ApiTags("Issuer")
@Secured([Role.Issuances])
@Controller("issuer/config")
export class IssuanceConfigController {
    constructor(private readonly issuanceService: IssuanceService) {}

    /**
     * Returns the issuance configurations for this tenant. Creates a default one if it does not exist.
     * @returns
     */
    @Get()
    @ApiOperation({ summary: "Get issuance configuration" })
    @ApiResponse({ status: 200, type: IssuanceConfig })
    async getIssuanceConfigurations(
        @Token() user: TokenPayload,
    ): Promise<IssuanceConfiguration> {
        return redact(
            await this.issuanceService
                .getIssuanceConfiguration(user.entity!.id)
                .catch(() =>
                    this.issuanceService.storeIssuanceConfiguration(
                        user.entity!.id,
                        {} as IssuanceDto,
                    ),
                ),
        );
    }

    /**
     * Stores the issuance configuration for this tenant.
     * @param config
     * @returns
     */
    @Post()
    @ApiOperation({ summary: "Create or replace issuance configuration" })
    @ApiBody({ type: UpdateIssuanceDto })
    @ApiResponse({ status: 200, type: IssuanceConfig })
    async storeIssuanceConfiguration(
        // The stored configuration is updated field by field.
        @Body(
            createConfigBodyPipe(IssuanceConfigSchema, {
                readOnly,
                partial: true,
            }),
        )
        config: UpdateIssuanceDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        const stored = await this.issuanceService
            .getIssuanceConfiguration(user.entity!.id)
            .catch(() => undefined);
        assertUpstreamSecretsKeptOnlyForSameIssuer(
            config.authorizationServers,
            stored?.authorizationServers,
        );
        return redact(
            await this.issuanceService.storeIssuanceConfiguration(
                user.entity!.id,
                restoreSecrets(config, stored, SECRET),
                user,
                requestMeta,
            ),
        );
    }

    /**
     * Force-reissue issuer registration certificate cache.
     */
    @Post("registration-cert/reissue")
    @ApiOperation({
        summary: "Reissue issuer registration certificate",
        description:
            "Bypasses and refreshes the issuer registration certificate cache, revoking the previous active certificate when replaced.",
    })
    @ApiResponse({
        status: 201,
        description: "Updated issuance configuration",
        type: IssuanceConfig,
    })
    @ApiResponse({
        status: 400,
        description:
            "Registration certificate is not enabled/generate mode or registrar is unavailable",
    })
    async reissueRegistrationCertificate(
        @Token() user: TokenPayload,
    ): Promise<IssuanceConfiguration> {
        return redact(
            await this.issuanceService.reissueRegistrationCertificate(
                user.entity!.id,
            ),
        );
    }
}
