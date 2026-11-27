import { HttpModule } from "@nestjs/axios";
import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { provideKeyChainReferenceSource } from "../../crypto/key/key-chain-reference-source.provider.js";
import { provideTrustListReferenceSource } from "../../issuer/trust-list/trust-list-reference-source.provider.js";
import { TrustListModule } from "../../issuer/trust-list/trustlist.module.js";
import { provideFederationTrustAnchorReferenceSource } from "../../trust/federation-trust-anchor/adapters/federation-trust-anchor-reference-source.provider.js";
import { FederationTrustAnchorModule } from "../../trust/federation-trust-anchor/federation-trust-anchor.module.js";
import { TrustModule } from "../../trust/trust.module.js";
import { WebhookModule } from "../../webhook/webhook.module.js";
import { ResolverModule } from "../resolver/resolver.module.js";
import { MdocCredentialVerifierFormat } from "./adapters/mdoc-credential-verifier-format.js";
import { SdJwtCredentialVerifierFormat } from "./adapters/sd-jwt-credential-verifier-format.js";
import { TypeOrmPresentationConfigFederationTrustAnchorReferences } from "./adapters/typeorm-presentation-config-federation-trust-anchor-references.js";
import { TypeOrmPresentationConfigKeyChainReferences } from "./adapters/typeorm-presentation-config-key-chain-references.js";
import { TypeOrmPresentationConfigTrustListReferences } from "./adapters/typeorm-presentation-config-trust-list-references.js";
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
        FederationTrustAnchorModule,
        WebhookModule,
    ],
    controllers: [PresentationManagementController],
    providers: [
        PresentationConfigService,
        PresentationRegistrationCertificateService,
        MetadataImportService,
        TrustedAuthoritiesService,
        provideTrustListReferenceSource(
            TypeOrmPresentationConfigTrustListReferences,
            PresentationConfig,
        ),
        provideFederationTrustAnchorReferenceSource(
            TypeOrmPresentationConfigFederationTrustAnchorReferences,
            PresentationConfig,
        ),
        provideKeyChainReferenceSource(
            TypeOrmPresentationConfigKeyChainReferences,
            PresentationConfig,
        ),
        {
            provide: PRESENTATION_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService): PresentationSettings => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
                skipOveraskingCheck:
                    config.get<boolean>("SKIP_OVERASKING_CHECK") ?? false,
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
        PRESENTATION_SETTINGS,
    ],
})
export class PresentationsModule {}
