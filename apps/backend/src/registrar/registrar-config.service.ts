import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { ConfigImportModeService } from "../platform/config-import/config-import-mode.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../platform/config-import/config-import-orchestrator.service.js";
import { ConfigMigrationService } from "../platform/config-portability/config-migration.service.js";
import { ConfigOwnershipService } from "../platform/config-portability/config-ownership.service.js";
import { tenantConfigFolder } from "../shared/utils/tenant-config-folder.util.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";
import type {
    CreateRegistrarConfig,
    UpdateRegistrarConfig,
} from "./schemas/registrar.schema.js";
import { CreateRegistrarConfigSchema } from "./schemas/registrar.schema.js";

/**
 * Manages per-tenant registrar configuration: CRUD, file-based import, and
 * lifecycle hooks. Auth-related credential testing is delegated to
 * {@link RegistrarAuthService}.
 */
@Injectable()
export class RegistrarConfigService {
    private readonly logger = new Logger(RegistrarConfigService.name);

    constructor(
        private readonly configService: ConfigService,
        configImportOrchestrator: ConfigImportOrchestratorService,
        @InjectRepository(RegistrarConfigEntity)
        private readonly configRepository: Repository<RegistrarConfigEntity>,
        private readonly authService: RegistrarAuthService,
        private readonly configOwnershipService: ConfigOwnershipService,
        private readonly configMigrationService: ConfigMigrationService,
        private readonly configImportModeService: ConfigImportModeService,
    ) {
        configImportOrchestrator.register(
            "registrar",
            ImportPhase.CORE,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Import registrar configuration for a tenant from the config folder.
     * Looks for a `registrar.json` file in the tenant's folder.
     */
    private async importForTenant(tenantId: string): Promise<void> {
        const configPath = this.configService.getOrThrow("CONFIG_FOLDER");
        const mode = this.configImportModeService.resolve();
        const updateExisting = mode !== "create" && mode !== "disabled";
        const tenantFolder = tenantConfigFolder(configPath, tenantId);
        // Unreachable after TenantService.setupTenant skipped the tenant.
        if (!tenantFolder) {
            throw new Error(`Tenant ID '${tenantId}' is not a folder name`);
        }
        const filePath = join(tenantFolder, "registrar.json");

        if (!existsSync(filePath)) {
            return;
        }

        try {
            const raw = readFileSync(filePath, "utf8");
            const payload = JSON.parse(raw) as Record<string, unknown>;
            const document = this.configMigrationService.isDocument(payload)
                ? payload
                : this.configMigrationService.wrapLegacy(
                      "RegistrarConfig",
                      payload,
                      "registrar",
                  );
            const upgraded = this.configMigrationService.upgrade(document);
            const blocking = upgraded.issues.filter(
                (issue) => issue.severity !== "warning",
            );
            if (blocking.length) {
                throw new Error(
                    blocking.map((issue) => issue.message).join("; "),
                );
            }
            const config = CreateRegistrarConfigSchema.parse(
                this.configMigrationService.unwrapForLegacyImporter(
                    upgraded.document,
                ),
            );
            const existing = await this.configRepository.findOneBy({
                tenantId,
            });
            if (existing && !updateExisting) {
                this.logger.debug(
                    `[${tenantId}] Registrar config already exists, skipping`,
                );
                return;
            }

            // Checked before the stored configuration is deleted.
            await this.authService.assertSafeUrls(config, {
                resolveHosts: false,
            });
            if (existing && updateExisting) {
                await this.configRepository.delete({ tenantId });
            }

            await this.replaceConfig(tenantId, config);
            await this.configOwnershipService.markApplied({
                tenantId,
                kind: "RegistrarConfig",
                resourceId: "registrar",
                ownership: "file-managed",
                generation: upgraded.document.metadata.generation ?? 1,
                source: `folder:${tenantFolder}`,
                sourceHash: createHash("sha256")
                    .update(readFileSync(filePath))
                    .digest("hex"),
            });

            this.logger.log(`[${tenantId}] Registrar config imported`);
        } catch (error: any) {
            this.logger.error(
                `[${tenantId}] Failed to import registrar config: ${error.message}`,
            );
        }
    }

    /**
     * Check if a tenant has registrar configuration.
     */
    async isEnabledForTenant(tenantId: string): Promise<boolean> {
        const config = await this.configRepository.findOneBy({ tenantId });
        return !!config;
    }

    /**
     * Called when a tenant is initialized — no-op with per-tenant config.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async onTenantInit(
        _tenant: Pick<TenantEntity, "id" | "name">,
    ): Promise<void> {}

    /**
     * Get the registrar configuration for a tenant.
     */
    getConfig(tenantId: string): Promise<RegistrarConfigEntity | null> {
        return this.configRepository.findOneBy({ tenantId });
    }

    /**
     * Create or replace the registrar configuration for a tenant. The URLs
     * are checked against the outbound URL policy and the credentials against
     * the OIDC provider before saving.
     */
    async saveConfig(
        tenantId: string,
        dto: CreateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        await this.authService.assertSafeUrls(dto);
        await this.authService.testCredentials(dto);
        return this.store(tenantId, dto);
    }

    /**
     * Create or replace the registrar configuration for a tenant without
     * checking the credentials. Configuration imports use this: the
     * registrar may be unreachable at startup, and a failed check would stop
     * the rest of the import. Wrong credentials fail on first use instead.
     * The URLs are still checked against the outbound URL policy, without
     * resolving their hosts: a host that does not resolve at startup must
     * not stop the import either. Its address is checked on first use.
     */
    async replaceConfig(
        tenantId: string,
        dto: CreateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        await this.authService.assertSafeUrls(dto, { resolveHosts: false });
        return this.store(tenantId, dto);
    }

    /**
     * Store `dto` as the whole configuration. A `clientSecret`,
     * `registrationCertificateDefaults` or `relyingPartyContact` missing from
     * `dto` removes the stored one, so a stored secret is never sent to the
     * `oidcUrl` of a replacement.
     */
    private async store(
        tenantId: string,
        dto: CreateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        const config = await this.configRepository.save({
            tenantId,
            ...dto,
            // `save` skips undefined columns and would keep the stored values.
            clientSecret: dto.clientSecret ?? null,
            registrationCertificateDefaults:
                dto.registrationCertificateDefaults ?? null,
            relyingPartyContact: dto.relyingPartyContact ?? null,
        });

        this.authService.invalidateToken(tenantId);
        this.logger.log(`[${tenantId}] Registrar configuration saved`);
        return config;
    }

    /**
     * Partially update the registrar configuration for a tenant.
     * The resulting URLs are checked against the outbound URL policy;
     * credentials are re-validated only when auth-related fields are changed.
     *
     * @throws BadRequestException when `oidcUrl` or `registrarUrl` changes
     * and `dto` does not send the stored credentials again.
     */
    async updateConfig(
        tenantId: string,
        dto: UpdateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        const existing = await this.configRepository.findOneBy({ tenantId });
        if (!existing) {
            throw new NotFoundException(
                `No registrar configuration found for tenant ${tenantId}`,
            );
        }

        this.assertCredentialsForChangedDestination(existing, dto);
        // The URLs in effect after the update, stored ones included: a PATCH
        // may leave unchanged URLs out, and the policy may have changed since.
        await this.authService.assertSafeUrls({
            registrarUrl: dto.registrarUrl ?? existing.registrarUrl,
            oidcUrl: dto.oidcUrl ?? existing.oidcUrl,
        });

        const hasAuthChanges =
            dto.oidcUrl !== undefined ||
            dto.clientId !== undefined ||
            dto.clientSecret !== undefined ||
            dto.username !== undefined ||
            dto.password !== undefined;

        if (hasAuthChanges) {
            const testConfig = {
                registrarUrl: dto.registrarUrl ?? existing.registrarUrl,
                oidcUrl: dto.oidcUrl ?? existing.oidcUrl,
                clientId: dto.clientId ?? existing.clientId,
                clientSecret: dto.clientSecret ?? existing.clientSecret,
                username: dto.username ?? existing.username,
                password: dto.password ?? existing.password,
            };
            await this.authService.testCredentials(testConfig);
        }

        await this.configRepository.save({ ...existing, ...dto, tenantId });
        this.authService.invalidateToken(tenantId);

        return this.configRepository.findOneByOrFail({ tenantId });
    }

    /**
     * The password and client secret are sent to the token endpoint of
     * `oidcUrl`, and the token they obtain to `registrarUrl`. A stored
     * credential is kept only while both stay the same; otherwise whoever may
     * edit the configuration could send it to a server of their choice
     * without knowing it.
     */
    private assertCredentialsForChangedDestination(
        existing: RegistrarConfigEntity,
        dto: UpdateRegistrarConfig,
    ): void {
        const changed = (["oidcUrl", "registrarUrl"] as const).filter(
            (field) =>
                dto[field] !== undefined && dto[field] !== existing[field],
        );
        if (!changed.length) return;
        const missing = [
            dto.password === undefined ? "password" : undefined,
            existing.clientSecret && dto.clientSecret === undefined
                ? "clientSecret"
                : undefined,
        ].filter((field) => field !== undefined);
        if (missing.length) {
            throw new BadRequestException(
                `${changed.join(" and ")} changes; send ${missing.join(" and ")} again, a stored credential is not sent to a new address`,
            );
        }
    }

    /**
     * Delete the registrar configuration for a tenant.
     */
    async deleteConfig(tenantId: string): Promise<void> {
        await this.configRepository.delete({ tenantId });
        this.authService.invalidateToken(tenantId);
        this.logger.log(`[${tenantId}] Registrar configuration deleted`);
    }
}
