import { HttpModule, HttpService } from "@nestjs/axios";
import { Global, Logger, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DataEncryptionService } from "./data-encryption.service.js";
import { initializeEncryptionTransformer } from "./encrypted-column.transformer.js";
import {
    AwsSecretsManagerEncryptionKeyProvider,
    AzureKeyVaultEncryptionKeyProvider,
    ENCRYPTION_KEY_PROVIDER,
    EncryptionKeyProvider,
    EncryptionKeySource,
    EnvEncryptionKeyProvider,
    VaultEncryptionKeyProvider,
} from "./providers/index.js";

/**
 * Global module that provides encryption services for data at rest.
 * The key is loaded and the column transformers are initialized while the
 * DataEncryptionService provider is created, so providers that inject it
 * (such as the TypeORM connection, whose migrations encrypt stored secrets)
 * start only once the key is available.
 *
 * Key source is configured via ENCRYPTION_KEY_SOURCE environment variable:
 * - "env" (default): Derive key from MASTER_SECRET
 * - "vault": Fetch from HashiCorp Vault at runtime
 * - "aws": Fetch from AWS Secrets Manager at runtime
 * - "azure": Fetch from Azure Key Vault at runtime
 */
@Global()
@Module({
    imports: [ConfigModule, HttpModule],
    providers: [
        {
            provide: ENCRYPTION_KEY_PROVIDER,
            useFactory: (
                configService: ConfigService,
                httpService: HttpService,
            ) => {
                const keySource =
                    configService.get<EncryptionKeySource>(
                        "ENCRYPTION_KEY_SOURCE",
                    ) || "env";

                const logger = new Logger("EncryptionKeyProviderFactory");
                logger.log(`Using encryption key source: ${keySource}`);

                switch (keySource) {
                    case "vault":
                        return new VaultEncryptionKeyProvider(
                            configService,
                            httpService,
                        );
                    case "aws":
                        return new AwsSecretsManagerEncryptionKeyProvider(
                            configService,
                        );
                    case "azure":
                        return new AzureKeyVaultEncryptionKeyProvider(
                            configService,
                        );
                    case "env":
                    default:
                        return new EnvEncryptionKeyProvider(configService);
                }
            },
            inject: [ConfigService, HttpService],
        },
        {
            provide: DataEncryptionService,
            useFactory: async (keyProvider: EncryptionKeyProvider) => {
                const service = new DataEncryptionService(keyProvider);
                await service.initialize();
                initializeEncryptionTransformer(service);
                return service;
            },
            inject: [ENCRYPTION_KEY_PROVIDER],
        },
    ],
    exports: [DataEncryptionService, ENCRYPTION_KEY_PROVIDER],
})
export class DataEncryptionModule {}
