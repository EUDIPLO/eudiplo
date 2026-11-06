import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import { AUTH_SETTINGS, type AuthSettings } from "../auth-settings.js";
import { AuthSettingsModule } from "../auth-settings.module.js";
import { IdpManagedClientsProvider } from "./adapters/idp-managed-clients.service.js";
import { InternalClientsProvider } from "./adapters/internal-clients.service.js";
import { KeycloakClientsProvider } from "./adapters/keycloak-clients.service.js";
import { ClientController } from "./client.controller.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client.provider.js";
import { ClientAccessService } from "./client-access.service.js";
import { ClientEntity } from "./entities/client.entity.js";

/** The clients adapter of the authentication mode. */
export const clientsProvider: Provider = {
    provide: CLIENTS_PROVIDER,
    inject: [
        AUTH_SETTINGS,
        ConfigService,
        getRepositoryToken(ClientEntity),
        ConfigImportService,
        ConfigImportOrchestratorService,
    ],
    useFactory: (
        settings: AuthSettings,
        configService: ConfigService,
        repo: Repository<ClientEntity>,
        configImportService: ConfigImportService,
        configImportOrchestrator: ConfigImportOrchestratorService,
    ): ClientsProvider => {
        const providers = {
            builtin: () =>
                new InternalClientsProvider(
                    configService,
                    repo,
                    configImportService,
                ),
            keycloak: () =>
                new KeycloakClientsProvider(
                    configService,
                    repo,
                    configImportService,
                ),
            generic: () => new IdpManagedClientsProvider(repo),
        };
        const provider: ClientsProvider = providers[settings.mode]();
        configImportOrchestrator.register(
            "clients",
            ImportPhase.CORE,
            (tenantId) => provider.importForTenant(tenantId),
        );
        return provider;
    },
};

@Module({
    imports: [TypeOrmModule.forFeature([ClientEntity]), AuthSettingsModule],
    providers: [clientsProvider, ClientAccessService],
    exports: [CLIENTS_PROVIDER, ClientAccessService],
    controllers: [ClientController],
})
export class ClientModule {}
