import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { SessionStore } from "../../session/application/session-store.js";
import { SessionModule } from "../../session/session.module.js";
import { TrustModule } from "../../trust/trust.module.js";
import { WalletAttestationService } from "../../trust/wallet-attestation.service.js";
import { WebhookModule } from "../../webhook/webhook.module.js";
import { WebhookService } from "../../webhook/webhook.service.js";
import { CredentialConfigModule } from "../configuration/credentials/credential-config.module.js";
import {
    CREDENTIAL_CONFIGURATION_REPOSITORY,
    type CredentialConfigurationRepository,
} from "../configuration/credentials/ports/credential-configuration.repository.js";
import { IssuanceService } from "../configuration/issuance/issuance.service.js";
import { IssuanceConfigModule } from "../configuration/issuance/issuance-config.module.js";
import {
    WEBHOOK_ENDPOINT_REPOSITORY,
    type WebhookEndpointRepository,
} from "../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { WebhookEndpointModule } from "../configuration/webhook-endpoint/webhook-endpoint.module.js";
import { CredentialWalletUnit } from "../status-list/entities/credential-wallet-unit.entity.js";
import { StatusListModule } from "../status-list/status-list.module.js";
import { StatusListService } from "../status-list/status-list.service.js";
import { TypeOrmCredentialWalletUnitStore } from "./adapters/typeorm-credential-wallet-unit-store.js";
import {
    ConfigurationWalletUnitRevocationSettings,
    StatusListIssuedCredentialStatus,
    TrustWalletUnitStatusReader,
    WebhookWalletUnitRevocationNotifier,
} from "./adapters/wallet-unit-revocation.adapters.js";
import {
    WALLET_UNIT_STATUS_CHECK_SETTINGS,
    WalletUnitStatusCheckJob,
} from "./adapters/wallet-unit-status-check.job.js";
import { CheckWalletUnitStatus } from "./application/check-wallet-unit-status.js";

/**
 * Revokes issued credentials when the wallet unit attestation they were
 * bound to is revoked, for credential configurations with
 * `revokeWithWalletUnit`.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([CredentialWalletUnit]),
        StatusListModule,
        TrustModule,
        IssuanceConfigModule,
        CredentialConfigModule,
        WebhookEndpointModule,
        WebhookModule,
        SessionModule,
    ],
    providers: [
        {
            provide: CheckWalletUnitStatus,
            inject: [
                getRepositoryToken(CredentialWalletUnit),
                WalletAttestationService,
                StatusListService,
                IssuanceService,
                CREDENTIAL_CONFIGURATION_REPOSITORY,
                WebhookService,
                WEBHOOK_ENDPOINT_REPOSITORY,
                SessionStore,
            ],
            useFactory: (
                records: Repository<CredentialWalletUnit>,
                walletAttestations: WalletAttestationService,
                statusLists: StatusListService,
                issuance: IssuanceService,
                credentialConfigurations: CredentialConfigurationRepository,
                webhooks: WebhookService,
                endpoints: WebhookEndpointRepository,
                sessions: SessionStore,
            ) => {
                const logger = new Logger(CheckWalletUnitStatus.name);
                return new CheckWalletUnitStatus(
                    new TypeOrmCredentialWalletUnitStore(records),
                    new TrustWalletUnitStatusReader(walletAttestations),
                    new StatusListIssuedCredentialStatus(statusLists),
                    new ConfigurationWalletUnitRevocationSettings(
                        issuance,
                        credentialConfigurations,
                    ),
                    new WebhookWalletUnitRevocationNotifier(
                        webhooks,
                        endpoints,
                        credentialConfigurations,
                        sessions,
                    ),
                    {
                        info: (message) => logger.log(message),
                        warn: (message) => logger.warn(message),
                    },
                );
            },
        },
        {
            provide: WALLET_UNIT_STATUS_CHECK_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                intervalSeconds: config.getOrThrow<number>(
                    "WALLET_UNIT_STATUS_CHECK_INTERVAL",
                ),
            }),
        },
        WalletUnitStatusCheckJob,
    ],
})
export class WalletUnitRevocationModule {}
