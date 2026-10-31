import { existsSync, readFileSync } from "node:fs";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    type KmsConfig,
    type KmsProviderConfig,
    parseResolvedKmsConfig,
} from "../schemas/kms-config.schema.js";
import { kmsConfigFilePath, kmsConfigFileSpec } from "./kms-config-file.js";

const DEFAULT_PROVIDER_ID = "db";

/**
 * Loads, validates and exposes the parsed `kms.json` configuration.
 *
 * Centralises file-system access and `${ENV_VAR}` placeholder resolution
 * so the rest of the KMS code only ever sees a typed, resolved view.
 * The file is read once at construction time; subsequent calls are
 * pure reads.
 */
@Injectable()
export class KmsConfigService {
    private readonly logger = new Logger(KmsConfigService.name);
    private readonly globalConfig: KmsConfig;
    private readonly tenantConfigCache = new Map<string, KmsConfig>();

    constructor(private readonly configService: ConfigService) {
        this.globalConfig = this.loadGlobalConfig();
    }

    getDefaultProviderId(tenantId?: string): string {
        return this.getConfig(tenantId).defaultProvider || DEFAULT_PROVIDER_ID;
    }

    getProviders(tenantId?: string): KmsProviderConfig[] {
        return this.getConfig(tenantId).providers;
    }

    getConfig(tenantId?: string): KmsConfig {
        if (!tenantId) {
            return this.globalConfig;
        }

        const cached = this.tenantConfigCache.get(tenantId);
        if (cached) {
            return cached;
        }

        const tenantConfig = this.loadTenantConfig(tenantId);
        const merged = tenantConfig
            ? mergeConfigs(this.globalConfig, tenantConfig)
            : this.globalConfig;
        this.tenantConfigCache.set(tenantId, merged);
        return merged;
    }

    invalidateTenantCache(tenantId: string): void {
        this.tenantConfigCache.delete(tenantId);
    }

    invalidateAllCaches(): void {
        this.tenantConfigCache.clear();
    }

    private loadGlobalConfig(): KmsConfig {
        const globalPath = this.resolveConfigPath();
        if (!globalPath) {
            return defaultConfig();
        }

        try {
            const raw = readFileSync(globalPath, "utf8");
            const source = "global kms.json";
            return parseResolvedKmsConfig(
                kmsConfigFileSpec(JSON.parse(raw), source),
                source,
            );
        } catch (err) {
            this.logger.warn(
                `Failed to read global kms.json at ${globalPath}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            throw err;
        }
    }

    private loadTenantConfig(tenantId: string): KmsConfig | null {
        const tenantPath = this.resolveConfigPath(tenantId);
        if (!tenantPath) {
            return null;
        }

        try {
            const raw = readFileSync(tenantPath, "utf8");
            const source = `tenant '${tenantId}' kms.json`;
            return parseResolvedKmsConfig(
                kmsConfigFileSpec(JSON.parse(raw), source),
                source,
            );
        } catch (err) {
            this.logger.warn(
                `Failed to read tenant kms.json for '${tenantId}' at ${tenantPath}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            throw err;
        }
    }

    private resolveConfigPath(tenantId?: string): string | null {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder) {
            return null;
        }

        const path = kmsConfigFilePath(configFolder, tenantId);
        return path && existsSync(path) ? path : null;
    }
}

function defaultConfig(): KmsConfig {
    return {
        defaultProvider: DEFAULT_PROVIDER_ID,
        providers: [
            {
                id: DEFAULT_PROVIDER_ID,
                type: "db",
                description: "Default database provider",
            },
        ],
    };
}

function mergeConfigs(global: KmsConfig, tenant: KmsConfig): KmsConfig {
    const mergedProviders = new Map<string, KmsProviderConfig>();

    for (const provider of global.providers ?? []) {
        mergedProviders.set(provider.id, provider);
    }

    for (const provider of tenant.providers ?? []) {
        mergedProviders.set(provider.id, provider);
    }

    return {
        defaultProvider: tenant.defaultProvider || global.defaultProvider,
        providers: [...mergedProviders.values()],
    };
}
