import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "@eudiplo/config-format/config-io.js";
import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    type KmsConfig,
    parseRawKmsConfig,
} from "../schemas/kms-config.schema.js";
import { KmsConfigService } from "./kms-config.service.js";
import { kmsConfigFilePath, kmsConfigFileSpec } from "./kms-config-file.js";
import {
    KmsSecretDestinationChangedError,
    KmsSecretNotStoredError,
    redactKmsConfig,
    restoreKmsSecrets,
} from "./kms-config-secrets.js";
import { KmsProviderRegistry } from "./kms-provider.registry.js";

@Injectable()
export class KmsTenantConfigService {
    constructor(
        private readonly configService: ConfigService,
        private readonly kmsConfigService: KmsConfigService,
        private readonly kmsProviderRegistry: KmsProviderRegistry,
    ) {}

    getTenantConfig(tenantId: string): KmsConfig | null {
        const path = this.getTenantConfigPath(tenantId);
        if (!path || !existsSync(path)) {
            return null;
        }
        const source = `tenant '${tenantId}' kms.json`;
        return parseRawKmsConfig(
            kmsConfigFileSpec(JSON.parse(readFileSync(path, "utf8")), source),
            source,
        );
    }

    getEffectiveConfig(tenantId: string): KmsConfig {
        return this.kmsConfigService.getConfig(tenantId);
    }

    /**
     * The tenant configuration for API responses: credentials are redacted,
     * `${ENV_VAR}` placeholders of the stored file are kept.
     */
    getTenantConfigView(tenantId: string): KmsConfig | null {
        const config = this.getTenantConfig(tenantId);
        return config && redactKmsConfig(config, { keepEnvPlaceholders: true });
    }

    /**
     * The effective configuration for API responses. Tenant providers are
     * shown as stored (credentials redacted, placeholders kept); providers of
     * the global configuration only with their non-secret settings.
     */
    getEffectiveConfigView(tenantId: string): KmsConfig {
        const effective = this.getEffectiveConfig(tenantId);
        const tenantProviders = new Map(
            (this.getTenantConfig(tenantId)?.providers ?? []).map(
                (provider) => [provider.id, provider],
            ),
        );
        const view = redactKmsConfig(effective, {
            keepEnvPlaceholders: false,
        });
        const tenantView = redactKmsConfig(
            { providers: [...tenantProviders.values()] },
            { keepEnvPlaceholders: true },
        );
        return {
            ...view,
            providers: view.providers.map(
                (provider) =>
                    tenantView.providers.find(
                        (entry) => entry.id === provider.id,
                    ) ?? provider,
            ),
        };
    }

    /**
     * Replace the tenant configuration from an API request. A credential sent
     * as the redaction marker keeps the stored value of the same provider, as
     * long as the address it is sent to stays the same.
     */
    updateTenantConfig(tenantId: string, config: KmsConfig): KmsConfig {
        let restored: KmsConfig;
        try {
            restored = restoreKmsSecrets(
                config,
                this.getTenantConfig(tenantId),
            );
        } catch (error) {
            if (
                error instanceof KmsSecretNotStoredError ||
                error instanceof KmsSecretDestinationChangedError
            ) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
        return this.saveTenantConfig(tenantId, restored);
    }

    saveTenantConfig(tenantId: string, config: KmsConfig): KmsConfig {
        const path = this.getTenantConfigPath(tenantId);
        if (!path) {
            throw new NotFoundException("CONFIG_FOLDER is not configured");
        }

        const validatedConfig = this.validateConfig(config);

        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(
            path,
            `${JSON.stringify(validatedConfig, null, 4)}\n`,
        );

        this.refreshTenantConfig(tenantId);
        return this.getEffectiveConfig(tenantId);
    }

    deleteTenantConfig(tenantId: string): void {
        const path = this.getTenantConfigPath(tenantId);
        if (path && existsSync(path)) {
            rmSync(path);
        }

        this.refreshTenantConfig(tenantId);
    }

    private refreshTenantConfig(tenantId: string): void {
        this.kmsConfigService.invalidateTenantCache(tenantId);
        this.kmsProviderRegistry.invalidateTenant(tenantId);
    }

    private getTenantConfigPath(tenantId: string): string | null {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder) {
            return null;
        }
        const path = kmsConfigFilePath(configFolder, tenantId);
        if (!path) {
            throw new BadRequestException(
                `Tenant ID '${tenantId}' cannot have a kms.json: it is not a folder name`,
            );
        }
        return path;
    }

    private validateConfig(config: KmsConfig): KmsConfig {
        return parseRawKmsConfig(config, "tenant KMS configuration");
    }
}
