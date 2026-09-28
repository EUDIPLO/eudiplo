import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import { InternalClientsProvider } from "./adapters/internal-clients.service.js";
import { KeycloakClientsProvider } from "./adapters/keycloak-clients.service.js";
import { ClientController } from "./client.controller.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client.provider.js";
import { ClientEntity } from "./entities/client.entity.js";

@Module({
    imports: [TypeOrmModule.forFeature([ClientEntity])],
    providers: [
        {
            provide: CLIENTS_PROVIDER,
            inject: [
                ConfigService,
                getRepositoryToken(ClientEntity),
                ConfigImportService,
                ConfigImportOrchestratorService,
            ],
            useFactory: (
                configService: ConfigService,
                repo: Repository<ClientEntity>,
                configImportService: ConfigImportService,
                configImportOrchestrator: ConfigImportOrchestratorService,
            ): ClientsProvider => {
                const useKeycloak = !!configService.get<string>("OIDC"); // if OIDC base/realm is configured, pick KC
                const provider = useKeycloak
                    ? new KeycloakClientsProvider(
                          configService,
                          repo,
                          configImportService,
                      )
                    : new InternalClientsProvider(
                          configService,
                          repo,
                          configImportService,
                      );
                configImportOrchestrator.register(
                    "clients",
                    ImportPhase.CORE,
                    (tenantId) => provider.importForTenant(tenantId),
                );
                return provider;
            },
        },
    ],
    exports: [CLIENTS_PROVIDER],
    controllers: [ClientController],
})
export class ClientModule {}
