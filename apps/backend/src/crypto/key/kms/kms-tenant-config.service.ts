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
import { KmsConfigService, mergeConfigs } from "./kms-config.service.js";
import { kmsConfigFilePath, parseKmsConfigFile } from "./kms-config-file.js";
import {
    assertNoNewKmsInstanceCredentials,
    assertNoNewKmsPlaceholders,
    assertNoNewKmsServerFiles,
    KmsInstanceCredentialsRefusedError,
    KmsPlaceholderRefusedError,
    KmsSecretDestinationChangedError,
    KmsSecretNotStoredError,
    KmsServerFileRefusedError,
    redactKmsConfig,
    restoreKmsSecrets,
} from "./kms-config-secrets.js";
import { KmsProviderRegistry } from "./kms-provider.registry.js";
import { KMS_TENANT_RESTRICTION_CODES } from "./kms-tenant-restrictions.js";

/** Why a tenant KMS configuration sent through the API is refused. */
export interface RefusedKmsSetting {
    code: "KMS_PLACEHOLDER_REFUSED" | "KMS_SETTING_REFUSED";
    message: string;
}

@Injectable()
export class KmsTenantConfigService {
    constructor(
        private readonly configService: ConfigService,
        private readonly kmsConfigService: KmsConfigService,
        private readonly kmsProviderRegistry: KmsProviderRegistry,
    ) {}

    /**
     * The tenant's own `kms.json`, or null when it has none. A tenant whose ID
     * is no folder name never has one, so reads such as bundle exports keep
     * working for it.
     */
    getTenantConfig(tenantId: string): KmsConfig | null {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        const path = configFolder && kmsConfigFilePath(configFolder, tenantId);
        if (!path || !existsSync(path)) {
            return null;
        }
        const source = `tenant '${tenantId}' kms.json`;
        return parseRawKmsConfig(
            parseKmsConfigFile(readFileSync(path, "utf8"), source),
            source,
        );
    }

    /**
     * The stored file as what a write through the API may keep of it: its
     * placeholders, host files and credentials. A file that is not JSON or
     * no valid KMS configuration gives nothing to keep, so the tenant can
     * replace it; only the operator can store such a file.
     */
    private keptTenantConfig(tenantId: string): KmsConfig | null {
        try {
            return this.getTenantConfig(tenantId);
        } catch (error) {
            if (error instanceof BadRequestException) return null;
            throw error;
        }
    }

    /**
     * False for a tenant whose ID is no folder name: it cannot store a
     * `kms.json`. True when no CONFIG_FOLDER is configured, which a save
     * reports itself.
     */
    canStoreTenantConfig(tenantId: string): boolean {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        return (
            !configFolder || kmsConfigFilePath(configFolder, tenantId) !== null
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
        // Throws the reason when the stored tenant file does not load.
        this.getEffectiveConfig(tenantId);
        // Built from the stored tenant file, never from its resolved form: a
        // resolved value is an environment variable of the backend.
        const globalView = redactKmsConfig(this.kmsConfigService.getConfig(), {
            keepEnvPlaceholders: false,
        });
        const tenantView = this.getTenantConfigView(tenantId);
        return tenantView ? mergeConfigs(globalView, tenantView) : globalView;
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
                this.keptTenantConfig(tenantId),
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

    /**
     * Why saveTenantConfig would refuse `config` for what only the operator
     * may put into a tenant `kms.json`, or undefined: a new `${VAR}`
     * placeholder, a kept one whose variable is unset or may not be used, a
     * new file of the backend's host or one that is not listed, or an
     * `aws-kms` provider without credentials. For plans; says nothing about
     * a configuration that is invalid in another way.
     */
    refusedSetting(
        tenantId: string,
        config: unknown,
    ): RefusedKmsSetting | undefined {
        try {
            const stored = this.getTenantConfig(tenantId);
            assertNoNewKmsPlaceholders(config as KmsConfig, stored);
            assertNoNewKmsServerFiles(config as KmsConfig, stored);
            assertNoNewKmsInstanceCredentials(config as KmsConfig, stored);
        } catch (error) {
            if (error instanceof KmsPlaceholderRefusedError) {
                return {
                    code: "KMS_PLACEHOLDER_REFUSED",
                    message: error.message,
                };
            }
            if (
                error instanceof KmsServerFileRefusedError ||
                error instanceof KmsInstanceCredentialsRefusedError
            ) {
                return { code: "KMS_SETTING_REFUSED", message: error.message };
            }
            return undefined;
        }
        try {
            this.kmsConfigService.resolveTenantConfig(
                config,
                "tenant KMS configuration",
            );
        } catch (error) {
            const response = (
                error as {
                    getResponse?: () => {
                        message?: string;
                        errors?: { code?: string }[];
                    };
                }
            ).getResponse?.();
            if (!response?.message) return undefined;
            const codes = (response.errors ?? []).map((issue) => issue.code);
            // A kept placeholder whose variable is unset or not listed.
            if (
                codes.includes("refused_environment_variable") ||
                codes.includes("missing_environment_variable")
            ) {
                return {
                    code: "KMS_PLACEHOLDER_REFUSED",
                    message: response.message,
                };
            }
            if (
                codes.some(
                    (code) =>
                        code !== undefined &&
                        KMS_TENANT_RESTRICTION_CODES.includes(code),
                )
            ) {
                return {
                    code: "KMS_SETTING_REFUSED",
                    message: response.message,
                };
            }
        }
        return undefined;
    }

    /**
     * Write the tenant configuration sent through the API, by an update or a
     * configuration bundle. It may keep the `${VAR}` placeholders and the
     * files of the backend's host the stored file holds but not bring in new
     * ones, nor an `aws-kms` provider without credentials (see
     * assertNoNewKmsPlaceholders, assertNoNewKmsServerFiles,
     * assertNoNewKmsInstanceCredentials).
     */
    saveTenantConfig(tenantId: string, config: KmsConfig): KmsConfig {
        const path = this.getTenantConfigPath(tenantId);
        if (!path) {
            throw new NotFoundException("CONFIG_FOLDER is not configured");
        }

        const validatedConfig = this.validateConfig(config);
        try {
            const stored = this.keptTenantConfig(tenantId);
            assertNoNewKmsPlaceholders(validatedConfig, stored);
            assertNoNewKmsServerFiles(validatedConfig, stored);
            assertNoNewKmsInstanceCredentials(validatedConfig, stored);
        } catch (error) {
            if (
                error instanceof KmsPlaceholderRefusedError ||
                error instanceof KmsServerFileRefusedError ||
                error instanceof KmsInstanceCredentialsRefusedError
            ) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
        // Nothing is written that the tenant could not load afterwards.
        this.kmsConfigService.resolveTenantConfig(
            validatedConfig,
            "tenant KMS configuration",
        );

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

    /** Path to write or delete; refuses a tenant ID that is no folder name. */
    private getTenantConfigPath(tenantId: string): string | null {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder) {
            return null;
        }
        const path = kmsConfigFilePath(configFolder, tenantId);
        if (!path) {
            throw new BadRequestException(
                `Tenant ID '${tenantId}' cannot have a kms.json: it is not a folder name. Export the tenant's configuration and import it into a tenant with a valid ID.`,
            );
        }
        return path;
    }

    private validateConfig(config: KmsConfig): KmsConfig {
        return parseRawKmsConfig(config, "tenant KMS configuration");
    }
}
