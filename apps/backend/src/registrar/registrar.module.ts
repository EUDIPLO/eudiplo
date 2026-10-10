import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CryptoModule } from "../crypto/crypto.module.js";
import { OutboundUrlPolicyModule } from "../webhook/outbound-url-policy.module.js";
import { AccessCertificateService } from "./access-certificate.service.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import { RegistrarController } from "./registrar.controller.js";
import { RegistrarService } from "./registrar.service.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";
import { RegistrarConfigService } from "./registrar-config.service.js";
import { RegistrationCertificateService } from "./registration-certificate.service.js";
import { SchemaMetadataService } from "./schema-metadata/schema-metadata.service.js";

/**
 * RegistrarModule is responsible for managing the registrar service.
 * It provides the RegistrarService and imports necessary modules.
 *
 * Registrar configuration can be:
 * - Set via API endpoints under /registrar/config
 * - Imported from config files (registrar.json in tenant folder)
 */
@Module({
    imports: [
        CryptoModule,
        HttpModule,
        OutboundUrlPolicyModule,
        TypeOrmModule.forFeature([RegistrarConfigEntity]),
    ],
    controllers: [RegistrarController],
    providers: [
        RegistrarAuthService,
        RegistrarConfigService,
        RegistrationCertificateService,
        AccessCertificateService,
        SchemaMetadataService,
        RegistrarService,
    ],
    exports: [RegistrarService, RegistrarConfigService, SchemaMetadataService],
})
export class RegistrarModule {}
