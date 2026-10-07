import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FederationTrustService } from "../../../trust/federation-trust.service.js";
import { TrustModule } from "../../../trust/trust.module.js";
import { WebhookModule } from "../../../webhook/webhook.module.js";
import { WebhookService } from "../../../webhook/webhook.service.js";
import { StatusListModule } from "../../status-list/status-list.module.js";
import { AttributeProviderModule } from "../attribute-provider/attribute-provider.module.js";
import {
    ATTRIBUTE_PROVIDER_REPOSITORY,
    type AttributeProviderRepository,
} from "../attribute-provider/ports/attribute-provider.repository.js";
import { IssuanceService } from "../issuance/issuance.service.js";
import { IssuanceConfigModule } from "../issuance/issuance-config.module.js";
import { ConfiguredIssuerFederationContext } from "./adapters/issuer-federation-context.js";
import { MdocCredentialIssuerFormat } from "./adapters/mdoc-credential-issuer-format.js";
import { SdjwtvcCredentialIssuerFormat } from "./adapters/sdjwtvc-credential-issuer-format.js";
import { WebhookRemoteCredentialClaims } from "./adapters/webhook-remote-credential-claims.js";
import { ConfiguredCredentialClaimsProvider } from "./application/configured-credential-claims.provider.js";
import { CredentialIssuerFormatRegistry } from "./application/credential-issuer-format-registry.js";
import { IssueCredential } from "./application/issue-credential.js";
import { CredentialConfigModule } from "./credential-config.module.js";
import { CREDENTIAL_SETTINGS } from "./credential-settings.js";
import { CredentialsService } from "./credentials.service.js";
import { CREDENTIAL_CLAIMS_PROVIDER } from "./domain/credential-claims.js";
import { MdocIssuerService } from "./issuer/mdoc-issuer/mdoc-issuer.service.js";
import { SdjwtvcIssuerService } from "./issuer/sdjwtvc-issuer/sdjwtvc-issuer.service.js";
import {
    CREDENTIAL_CONFIGURATION_REPOSITORY,
    type CredentialConfigurationRepository,
} from "./ports/credential-configuration.repository.js";
import {
    ISSUER_FEDERATION_CONTEXT,
    type IssuerFederationContext,
} from "./ports/credential-generation-context.js";
import {
    REMOTE_CREDENTIAL_CLAIMS,
    type RemoteCredentialClaims,
} from "./ports/remote-credential-claims.js";

@Module({
    imports: [
        AttributeProviderModule,
        CredentialConfigModule,
        IssuanceConfigModule,
        StatusListModule,
        TrustModule,
        WebhookModule,
    ],
    providers: [
        CredentialsService,
        {
            provide: ISSUER_FEDERATION_CONTEXT,
            inject: [IssuanceService, FederationTrustService],
            useFactory: (
                issuance: IssuanceService,
                federation: FederationTrustService,
            ) => new ConfiguredIssuerFederationContext(issuance, federation),
        },
        {
            provide: IssueCredential,
            inject: [
                CREDENTIAL_CONFIGURATION_REPOSITORY,
                ISSUER_FEDERATION_CONTEXT,
                CredentialIssuerFormatRegistry,
            ],
            useFactory: (
                configs: CredentialConfigurationRepository,
                federation: IssuerFederationContext,
                formats: CredentialIssuerFormatRegistry,
            ) => new IssueCredential(configs, federation, formats),
        },
        {
            provide: CREDENTIAL_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
            }),
        },
        SdjwtvcIssuerService,
        MdocIssuerService,
        MdocCredentialIssuerFormat,
        SdjwtvcCredentialIssuerFormat,
        {
            provide: CredentialIssuerFormatRegistry,
            inject: [SdjwtvcCredentialIssuerFormat, MdocCredentialIssuerFormat],
            useFactory: (
                sdjwt: SdjwtvcCredentialIssuerFormat,
                mdoc: MdocCredentialIssuerFormat,
            ) => new CredentialIssuerFormatRegistry([sdjwt, mdoc]),
        },
        {
            provide: REMOTE_CREDENTIAL_CLAIMS,
            inject: [WebhookService],
            useFactory: (webhooks: WebhookService) =>
                new WebhookRemoteCredentialClaims(webhooks),
        },
        {
            provide: ConfiguredCredentialClaimsProvider,
            inject: [
                CREDENTIAL_CONFIGURATION_REPOSITORY,
                ATTRIBUTE_PROVIDER_REPOSITORY,
                REMOTE_CREDENTIAL_CLAIMS,
            ],
            useFactory: (
                configs: CredentialConfigurationRepository,
                providers: AttributeProviderRepository,
                remote: RemoteCredentialClaims,
            ) =>
                new ConfiguredCredentialClaimsProvider(
                    configs,
                    providers,
                    remote,
                ),
        },
        {
            provide: CREDENTIAL_CLAIMS_PROVIDER,
            useExisting: ConfiguredCredentialClaimsProvider,
        },
    ],
    exports: [CredentialsService, CREDENTIAL_CLAIMS_PROVIDER],
})
export class CredentialIssuanceModule {}
