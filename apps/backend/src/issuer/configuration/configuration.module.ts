import { Module } from "@nestjs/common";
import { StatusListModule } from "../status-list/status-list.module.js";
import { AttributeProviderModule } from "./attribute-provider/attribute-provider.module.js";
import { CredentialConfigModule } from "./credentials/credential-config.module.js";
import { CredentialIssuanceModule } from "./credentials/credential-issuance.module.js";
import { IssuanceConfigModule } from "./issuance/issuance-config.module.js";
import { WebhookEndpointModule } from "./webhook-endpoint/webhook-endpoint.module.js";

/**
 * Configuration Module - Manages issuer configurations and credential definitions
 *
 * Responsibilities:
 * - Issuance configuration management
 * - Credential type definitions
 * - Credential schemas and metadata
 */
@Module({
    imports: [
        AttributeProviderModule,
        CredentialConfigModule,
        CredentialIssuanceModule,
        IssuanceConfigModule,
        StatusListModule,
        WebhookEndpointModule,
    ],
    exports: [
        AttributeProviderModule,
        CredentialConfigModule,
        CredentialIssuanceModule,
        IssuanceConfigModule,
        StatusListModule,
        WebhookEndpointModule,
    ],
})
export class ConfigurationModule {}
