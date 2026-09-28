import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { TrustListModule } from "../../issuer/trust-list/trustlist.module.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { TrustModule } from "../../trust/trust.module.js";
import { ResolverModule } from "../resolver/resolver.module.js";
import { MetadataFetchService } from "./configuration/metadata-fetch.service.js";
import { MetadataImportService } from "./configuration/metadata-import.service.js";
import { PresentationConfigService } from "./configuration/presentation-config.service.js";
import { PresentationRegistrationCertificateService } from "./configuration/presentation-registration-certificate.service.js";
import { CredentialChainValidationService } from "./credential/credential-chain-validation.service.js";
import { CredentialVerifierFormatRegistry } from "./credential/credential-verifier-format-registry.js";
import { MdocCredentialVerifierFormat } from "./credential/mdocverifier/mdoc-credential-verifier-format.js";
import { MdocverifierService } from "./credential/mdocverifier/mdocverifier.service.js";
import { SdJwtCredentialVerifierFormat } from "./credential/sdjwtvcverifier/sd-jwt-credential-verifier-format.js";
import { SdjwtvcverifierService } from "./credential/sdjwtvcverifier/sdjwtvcverifier.service.js";
import { PresentationConfig } from "./entities/presentation-config.entity.js";
import { PRESENTATION_SETTINGS } from "./presentation-settings.js";
import { PresentationManagementController } from "./presentations.controller.js";
import { PresentationsService } from "./presentations.service.js";
import { TrustedAuthoritiesService } from "./trusted-authorities.service.js";

@Module({
    imports: [
        ResolverModule,
        HttpModule,
        TypeOrmModule.forFeature([PresentationConfig]),
        AuditLogModule,
        TrustListModule,
        TrustModule,
        RegistrarModule,
    ],
    controllers: [PresentationManagementController],
    providers: [
        PresentationsService,
        PresentationConfigService,
        PresentationRegistrationCertificateService,
        MetadataImportService,
        TrustedAuthoritiesService,
        {
            provide: PRESENTATION_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
            }),
        },
        SdjwtvcverifierService,
        MdocverifierService,
        MdocCredentialVerifierFormat,
        SdJwtCredentialVerifierFormat,
        {
            provide: CredentialVerifierFormatRegistry,
            inject: [
                MdocCredentialVerifierFormat,
                SdJwtCredentialVerifierFormat,
            ],
            useFactory: (
                mdoc: MdocCredentialVerifierFormat,
                sdJwt: SdJwtCredentialVerifierFormat,
            ) => new CredentialVerifierFormatRegistry([mdoc, sdJwt]),
        },
        CredentialChainValidationService,
        MetadataFetchService,
    ],
    exports: [
        PresentationsService,
        PresentationConfigService,
        PresentationRegistrationCertificateService,
        TrustedAuthoritiesService,
        CredentialChainValidationService,
        MdocverifierService,
    ],
})
export class PresentationsModule {}
