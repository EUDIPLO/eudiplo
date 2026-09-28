import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SessionStorageConfig } from "../auth/tenant/entities/session-storage-config.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { SessionCleanupMode } from "./domain/session-retention.js";
import { UpdateSessionConfigDto } from "./dto/update-session-config.dto.js";
import { SESSION_SETTINGS, type SessionSettings } from "./session-settings.js";

/**
 * Service for managing session storage configuration per tenant.
 */
@Injectable()
export class SessionConfigService {
    constructor(
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        @Inject(SESSION_SETTINGS)
        private readonly settings: SessionSettings,
    ) {}

    /**
     * Get the default TTL from environment configuration.
     */
    getDefaultTtlSeconds(): number {
        return this.settings.defaultTtlSeconds;
    }

    /**
     * Get the default cleanup mode from environment configuration.
     */
    getDefaultCleanupMode(): SessionCleanupMode {
        return this.settings.defaultCleanupMode;
    }

    /**
     * Get the session storage configuration for a tenant.
     * @param tenantId The tenant ID
     * @returns The session storage configuration or null if not set (uses global defaults)
     */
    async getConfig(tenantId: string): Promise<SessionStorageConfig | null> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        return tenant.sessionConfig ?? null;
    }

    /**
     * Get the effective session storage configuration for a tenant,
     * with defaults applied if no custom config exists.
     * @param tenantId The tenant ID
     * @returns The effective session storage configuration with defaults applied
     */
    async getEffectiveConfig(tenantId: string): Promise<SessionStorageConfig> {
        const config = await this.getConfig(tenantId);
        return {
            ttlSeconds: config?.ttlSeconds ?? this.getDefaultTtlSeconds(),
            cleanupMode: config?.cleanupMode ?? this.getDefaultCleanupMode(),
        };
    }

    /**
     * Effective session time-to-live of a tenant in seconds: the tenant
     * override if set, otherwise the global SESSION_TTL default.
     */
    async getEffectiveTtlSeconds(tenantId: string): Promise<number> {
        const config = await this.getConfig(tenantId);
        return config?.ttlSeconds ?? this.getDefaultTtlSeconds();
    }

    /**
     * Update the session storage configuration for a tenant.
     * @param tenantId The tenant ID
     * @param config The new session storage configuration
     * @returns The updated session storage configuration
     */
    async updateConfig(
        tenantId: string,
        config: UpdateSessionConfigDto,
    ): Promise<SessionStorageConfig> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });

        // Build updated config, handling null values
        const updatedConfig: SessionStorageConfig = {
            ...tenant.sessionConfig,
        };

        // Handle ttlSeconds: null means reset to default, number means set value
        if (config.ttlSeconds === null) {
            delete updatedConfig.ttlSeconds;
        } else if (config.ttlSeconds !== undefined) {
            updatedConfig.ttlSeconds = config.ttlSeconds;
        }

        // Handle cleanupMode
        if (config.cleanupMode !== undefined) {
            updatedConfig.cleanupMode = config.cleanupMode;
        }

        await this.tenantRepository.update(
            { id: tenantId },
            { sessionConfig: updatedConfig },
        );

        return updatedConfig;
    }

    /**
     * Reset the session storage configuration for a tenant to defaults.
     * @param tenantId The tenant ID
     */
    async resetConfig(tenantId: string): Promise<void> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        tenant.sessionConfig = null;
        await this.tenantRepository.save(tenant);
    }
}
