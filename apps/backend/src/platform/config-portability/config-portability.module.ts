import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { AuthSettingsModule } from "../../auth/auth-settings.module.js";
import { ClientModule } from "../../auth/client/client.module.js";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../crypto/key/entities/key-chain.entity.js";
import { AttributeProviderEntity } from "../../issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import { ConfigurationModule } from "../../issuer/configuration/configuration.module.js";
import { CredentialConfig } from "../../issuer/configuration/credentials/entities/credential.entity.js";
import { IssuanceConfig } from "../../issuer/configuration/issuance/entities/issuance-config.entity.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { StatusListEntity } from "../../issuer/status-list/entities/status-list.entity.js";
import { StatusListModule } from "../../issuer/status-list/status-list.module.js";
import { TrustList } from "../../issuer/trust-list/entities/trust-list.entity.js";
import { TrustListModule } from "../../issuer/trust-list/trustlist.module.js";
import { RegistrarConfigEntity } from "../../registrar/entities/registrar-config.entity.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { FileEntity } from "../../storage/entities/files.entity.js";
import { FederationTrustAnchorEntity } from "../../trust/federation-trust-anchor/entities/federation-trust-anchor.entity.js";
import { FederationTrustAnchorModule } from "../../trust/federation-trust-anchor/federation-trust-anchor.module.js";
import { PresentationConfig } from "../../verifier/presentations/entities/presentation-config.entity.js";
import { PresentationsModule } from "../../verifier/presentations/presentations.module.js";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import { ConfigBundleArchiveService } from "./config-bundle-archive.service.js";
import { ConfigBundleRepositories } from "./config-bundle-repositories.service.js";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigFolderBundleService } from "./config-folder-bundle.service.js";
import { ConfigGenerationInterceptor } from "./config-generation.interceptor.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigKmsReferenceService } from "./config-kms-reference.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import { ConfigOwnershipBootstrapService } from "./config-ownership-bootstrap.service.js";
import { ConfigPortabilityController } from "./config-portability.controller.js";
import { ConfigResourceCoreModule } from "./config-resource-core.module.js";
import { ConfigResourceRouteService } from "./config-resource-route.service.js";
import { ConfigImportRunEntity } from "./entities/config-import-run.entity.js";
import { ConfigResourceMetadataEntity } from "./entities/config-resource-metadata.entity.js";

@Global()
@Module({
    imports: [
        AuditLogModule,
        AuthSettingsModule,
        ClientModule,
        ConfigResourceCoreModule,
        ConfigurationModule,
        StatusListModule,
        TrustListModule,
        FederationTrustAnchorModule,
        RegistrarModule,
        PresentationsModule,
        TypeOrmModule.forFeature([
            ConfigResourceMetadataEntity,
            ConfigImportRunEntity,
            TenantEntity,
            ClientEntity,
            KeyChainEntity,
            RegistrarConfigEntity,
            IssuanceConfig,
            CredentialConfig,
            PresentationConfig,
            AttributeProviderEntity,
            WebhookEndpointEntity,
            TrustList,
            FederationTrustAnchorEntity,
            StatusListEntity,
            FileEntity,
        ]),
    ],
    controllers: [ConfigPortabilityController],
    providers: [
        ConfigBundleRepositories,
        ConfigDocumentValidationService,
        ConfigImportJournalService,
        ConfigOwnershipService,
        ConfigResourceRouteService,
        ConfigBundleService,
        ConfigBundleArchiveService,
        ConfigKmsReferenceService,
        ConfigOwnershipBootstrapService,
        ConfigFolderBundleService,
        ConfigBundleApplyService,
        {
            provide: APP_INTERCEPTOR,
            useClass: ConfigGenerationInterceptor,
        },
    ],
    exports: [ConfigResourceCoreModule, ConfigOwnershipService],
})
export class ConfigPortabilityModule {}
