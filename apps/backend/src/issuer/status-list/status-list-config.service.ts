import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { BitsPerStatus } from "@owf/token-status-list";
import { Repository } from "typeorm";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../audit-log/audit-log-context.util.js";
import { StatusListConfig } from "../../auth/tenant/entities/status-list-config.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { TokenPayload } from "../../auth/token.decorator.js";
import { UpdateStatusListConfigDto } from "./dto/update-status-list-config.dto.js";

/**
 * Service for managing status list configuration per tenant.
 */
@Injectable()
export class StatusListConfigService {
    constructor(
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        private readonly configService: ConfigService,
        private readonly tenantActionLogService: AuditLogService,
    ) {}

    /**
     * Get the default status list capacity from environment configuration.
     */
    getDefaultCapacity(): number {
        return this.configService.getOrThrow<number>("STATUS_CAPACITY");
    }

    /**
     * Get the default bits per status from environment configuration.
     */
    getDefaultBits(): BitsPerStatus {
        return this.configService.getOrThrow<BitsPerStatus>("STATUS_BITS");
    }

    /**
     * Get the default TTL (in seconds) from environment configuration.
     */
    getDefaultTtl(): number {
        return this.configService.get<number>("STATUS_TTL") ?? 3600;
    }

    /**
     * Get the default immediateUpdate setting from environment configuration.
     */
    getDefaultImmediateUpdate(): boolean {
        return (
            this.configService.get<boolean>("STATUS_IMMEDIATE_UPDATE") ?? false
        );
    }

    /**
     * Get the default enableAggregation setting from environment configuration.
     * Defaults to true to enable status list aggregation for offline validation.
     */
    getDefaultEnableAggregation(): boolean {
        return (
            this.configService.get<boolean>("STATUS_ENABLE_AGGREGATION") ?? true
        );
    }

    /**
     * Get the status list configuration for a tenant.
     * @param tenantId The tenant ID
     * @returns The status list configuration or null if not set (uses global defaults)
     */
    async getConfig(tenantId: string): Promise<StatusListConfig | null> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        return tenant.statusListConfig ?? null;
    }

    /**
     * Get the effective status list configuration for a tenant,
     * with defaults applied if no custom config exists.
     * @param tenantId The tenant ID
     * @returns The effective status list configuration with defaults applied
     */
    async getEffectiveConfig(tenantId: string): Promise<StatusListConfig> {
        const config = await this.getConfig(tenantId);
        return {
            capacity: config?.capacity ?? this.getDefaultCapacity(),
            bits: config?.bits ?? this.getDefaultBits(),
            ttl: config?.ttl ?? this.getDefaultTtl(),
            immediateUpdate:
                config?.immediateUpdate ?? this.getDefaultImmediateUpdate(),
            enableAggregation:
                config?.enableAggregation ?? this.getDefaultEnableAggregation(),
        };
    }

    /**
     * Update the status list configuration for a tenant.
     * Note: Changes only affect newly created status lists, not existing ones.
     *
     * Fields set to `null` will use the global default.
     * Fields set to a value will override the default.
     *
     * @param tenantId The tenant ID
     * @param config The new status list configuration
     * @returns The updated status list configuration
     */
    async updateConfig(
        tenantId: string,
        config: UpdateStatusListConfigDto,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ): Promise<StatusListConfig> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        const before = this.sanitizeStatusListConfigForLog(
            tenant.statusListConfig,
        );

        // Replace config entirely - null values mean "use default"
        const updatedConfig: StatusListConfig = {
            capacity: config.capacity ?? undefined,
            bits: config.bits ?? undefined,
            ttl: config.ttl ?? undefined,
            immediateUpdate: config.immediateUpdate ?? undefined,
            enableAggregation: config.enableAggregation ?? undefined,
        };

        await this.tenantRepository.update(
            { id: tenantId },
            { statusListConfig: updatedConfig },
        );

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "status_list_config_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    before,
                    this.sanitizeStatusListConfigForLog(updatedConfig),
                ),
                before,
                after: this.sanitizeStatusListConfigForLog(updatedConfig),
                requestMeta,
            });
        }

        return updatedConfig;
    }

    /**
     * Reset the status list configuration for a tenant to defaults.
     * Note: This only affects newly created status lists, not existing ones.
     * @param tenantId The tenant ID
     */
    async resetConfig(
        tenantId: string,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ): Promise<void> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        const before = this.sanitizeStatusListConfigForLog(
            tenant.statusListConfig,
        );
        tenant.statusListConfig = undefined;
        await this.tenantRepository.save(tenant);

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "status_list_config_reset",
                actor: resolveAuditActor(actorToken),
                before,
                requestMeta,
            });
        }
    }

    private sanitizeStatusListConfigForLog(
        config?: StatusListConfig | null,
    ): Record<string, unknown> | undefined {
        if (!config) {
            return undefined;
        }

        return {
            capacity: config.capacity,
            bits: config.bits,
            ttl: config.ttl,
            immediateUpdate: config.immediateUpdate,
            enableAggregation: config.enableAggregation,
        };
    }
}
