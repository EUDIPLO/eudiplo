import { HttpModule } from "@nestjs/axios";
import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { TrustListModule } from "../../issuer/trust-list/trustlist.module.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { TrustModule } from "../../trust/trust.module.js";
import { WebhookModule } from "../../webhook/webhook.module.js";
import { ResolverModule } from "../resolver/resolver.module.js";
import { MdocCredentialVerifierFormat } from "./adapters/mdoc-credential-verifier-format.js";
import { SdJwtCredentialVerifierFormat } from "./adapters/sd-jwt-credential-verifier-format.js";
import { CredentialVerifierFormatRegistry } from "./application/credential-verifier-format-registry.js";
import { VerifyPresentationResponse } from "./application/verify-presentation-response.js";
import { MetadataFetchService } from "./configuration/metadata-fetch.service.js";
import { MetadataImportService } from "./configuration/metadata-import.service.js";
import { PresentationConfigService } from "./configuration/presentation-config.service.js";
import { PresentationRegistrationCertificateService } from "./configuration/presentation-registration-certificate.service.js";
import { CredentialChainValidationService } from "./credential/credential-chain-validation.service.js";
import { MdocverifierService } from "./credential/mdocverifier/mdocverifier.service.js";
import { SdjwtvcverifierService } from "./credential/sdjwtvcverifier/sdjwtvcverifier.service.js";
import { PresentationConfig } from "./entities/presentation-config.entity.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "./presentation-settings.js";
import { PresentationManagementController } from "./presentations.controller.js";
import { TrustedAuthoritiesService } from "./trusted-authorities.service.js";

export const verifyPresentationResponseProvider: Provider = {
    provide: VerifyPresentationResponse,
    inject: [
        CredentialVerifierFormatRegistry,
        TrustedAuthoritiesService,
        PRESENTATION_SETTINGS,
    ],
    useFactory: (
        formats: CredentialVerifierFormatRegistry,
        trustedAuthorities: TrustedAuthoritiesService,
        settings: PresentationSettings,
    ) => new VerifyPresentationResponse(formats, trustedAuthorities, settings),
};

@Module({
    imports: [
        ResolverModule,
        HttpModule,
        TypeOrmModule.forFeature([PresentationConfig]),
        AuditLogModule,
        TrustListModule,
        TrustModule,
        RegistrarModule,
        WebhookModule,
    ],
    controllers: [PresentationManagementController],
    providers: [
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
        verifyPresentationResponseProvider,
        CredentialChainValidationService,
        MetadataFetchService,
    ],
    exports: [
        VerifyPresentationResponse,
        CredentialVerifierFormatRegistry,
        PresentationConfigService,
        PresentationRegistrationCertificateService,
        TrustedAuthoritiesService,
        CredentialChainValidationService,
    ],
})
export class PresentationsModule {}
