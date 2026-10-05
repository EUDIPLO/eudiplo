import { HttpModule } from "@nestjs/axios";
import { DynamicModule, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { OutboundUrlPolicyModule } from "../../webhook/outbound-url-policy.module.js";
import { CertService } from "./cert/cert.service.js";
import { CertificateBuilderService } from "./cert/certificate-builder.service.js";
import { CrlValidationService } from "./cert/crl-validation.service.js";
import { CryptoImplementationModule } from "./crypto-implementation/crypto-implementation.module.js";
import { KeyChainEntity } from "./entities/key-chain.entity.js";
import { KeyChainController } from "./key-chain.controller.js";
import { KeyChainService } from "./key-chain.service.js";
import { KeyChainImportService } from "./key-chain-import.service.js";
import { KeyChainSigningService } from "./key-chain-signing.service.js";
import { KeyRotationService } from "./key-rotation.service.js";
import { KmsConfigService } from "./kms/kms-config.service.js";
import { KmsProviderRegistry } from "./kms/kms-provider.registry.js";
import { KmsTenantConfigService } from "./kms/kms-tenant-config.service.js";

@Global()
export class KeyModule {
    static forRoot(): DynamicModule {
        return {
            module: KeyModule,
            imports: [
                HttpModule,
                ConfigModule,
                CryptoImplementationModule,
                OutboundUrlPolicyModule,
                TypeOrmModule.forFeature([KeyChainEntity, TenantEntity]),
            ],
            controllers: [KeyChainController],
            providers: [
                KmsConfigService,
                KmsProviderRegistry,
                KmsTenantConfigService,
                CertificateBuilderService,
                KeyChainSigningService,
                KeyChainImportService,
                KeyChainService,
                KeyRotationService,
                CertService,
                CrlValidationService,
            ],
            exports: [
                KeyChainService,
                KmsTenantConfigService,
                KmsProviderRegistry,
                CertService,
                CrlValidationService,
            ],
        };
    }
}
