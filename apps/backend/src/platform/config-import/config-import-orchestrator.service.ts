import { existsSync, readdirSync } from "node:fs";
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConfigImportMode } from "../config-portability/config-resource.types.js";
import { ConfigImportModeService } from "./config-import-mode.service.js";

/**
 * Import phase definitions with their order.
 * Lower numbers run first.
 */
export enum ImportPhase {
    /** Core infrastructure (keys, certificates) */
    CORE = 10,
    /** Configuration (issuance, credential configs) */
    CONFIGURATION = 20,
    /** References (presentation configs that may reference certs) */
    REFERENCES = 30,
    /** Final phase (status lists, trust lists) */
    FINAL = 40,
}

/**
 * Type for tenant-aware import functions.
 * Each function receives the tenant ID and processes imports for that specific tenant.
 */
export type TenantImportFn = (tenantId: string) => Promise<void>;

interface RegisteredImporter {
    name: string;
    phase: ImportPhase;
    importForTenant: TenantImportFn;
}

interface TenantSetupFn {
    name: string;
    setup: (tenantId: string) => Promise<boolean>;
}

interface PortableImportRunner {
    name: string;
    run: (tenantId: string, mode: ConfigImportMode) => Promise<void>;
}

/**
 * Centralized orchestrator for configuration imports.
 * Imports are processed tenant-by-tenant to provide better log clarity
 * and isolation - if one tenant fails, others can still be imported.
 *
 * Flow:
 * 1. Discover all tenant folders
 * 2. For each tenant:
 *    a. Setup tenant (create if needed)
 *    b. Run all import phases in order (CORE → CONFIGURATION → REFERENCES → FINAL)
 * 3. Continue with next tenant even if current tenant fails
 *
 * Composition modules should register importer functions while constructing
 * capability providers, before application bootstrap.
 * The orchestrator automatically runs imports during onApplicationBootstrap.
 */
@Injectable()
export class ConfigImportOrchestratorService implements OnApplicationBootstrap {
    private readonly importers: RegisteredImporter[] = [];
    private tenantSetup: TenantSetupFn | null = null;
    private portableRunner: PortableImportRunner | null = null;
    private hasRun = false;
    private runPromise: Promise<void> | null = null;
    private readonly logger = new Logger(ConfigImportOrchestratorService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly importModeService: ConfigImportModeService,
    ) {}

    /**
     * Lifecycle hook - automatically triggers import orchestration.
     */
    async onApplicationBootstrap() {
        await this.runImports();
    }

    /**
     * Register a tenant setup function.
     * This is called first for each tenant to ensure the tenant exists.
     * @param name - Human-readable name for logging
     * @param setupFn - Function that creates/verifies tenant, returns true if tenant is valid
     */
    registerTenantSetup(
        name: string,
        setupFn: (tenantId: string) => Promise<boolean>,
    ): void {
        if (this.hasRun) {
            this.logger.warn(
                `Tenant setup "${name}" registered after orchestration already ran`,
            );
        }
        this.tenantSetup = { name, setup: setupFn };
    }

    /**
     * Register an import function for orchestration.
     * @param name - Human-readable name for logging
     * @param phase - The import phase (determines order within tenant)
     * @param importFn - The import function to call (receives tenantId)
     */
    register(name: string, phase: ImportPhase, importFn: TenantImportFn): void {
        if (this.hasRun) {
            this.logger.warn(
                `Importer "${name}" registered after orchestration already ran`,
            );
        }
        this.importers.push({ name, phase, importForTenant: importFn });
    }

    registerPortableRunner(
        name: string,
        runner: (tenantId: string, mode: ConfigImportMode) => Promise<void>,
    ): void {
        if (this.portableRunner) {
            throw new Error(
                `Portable config import runner is already registered by ${this.portableRunner.name}`,
            );
        }
        this.portableRunner = { name, run: runner };
    }

    /**
     * Execute all registered imports tenant-by-tenant.
     * Safe to call multiple times - only runs once.
     * Returns the same promise if called while running.
     */
    async runImports(): Promise<void> {
        // If already running, return the existing promise
        if (this.runPromise) {
            return this.runPromise;
        }

        // If already completed, return immediately
        if (this.hasRun) {
            return;
        }

        // Start the import process
        this.runPromise = this.executeImports();
        return this.runPromise;
    }

    /**
     * Discover all tenant folders in the config directory.
     */
    private discoverTenants(): string[] {
        const configPath = this.configService.get<string>("CONFIG_FOLDER");
        if (!configPath || !existsSync(configPath)) {
            return [];
        }

        return readdirSync(configPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }

    private async executeImports(): Promise<void> {
        const mode = this.importModeService.resolve();
        if (mode === "disabled") {
            this.hasRun = true;
            this.logger.log("Config import is disabled");
            return;
        }

        // Sort importers by phase
        const sortedImporters = [...this.importers].sort(
            (a, b) => a.phase - b.phase,
        );

        // Discover tenants
        const tenants = this.discoverTenants();

        this.logger.log(
            `Starting config import for ${tenants.length} tenant(s)`,
        );

        const failedTenants: string[] = [];

        for (const tenantId of tenants) {
            this.logger.debug(`[${tenantId}] Starting import`);

            try {
                // Step 1: Setup tenant (create if needed)
                if (this.tenantSetup) {
                    const isValid = await this.tenantSetup.setup(tenantId);
                    if (!isValid) {
                        this.logger.warn(
                            `[${tenantId}] Tenant setup returned invalid, skipping`,
                        );
                        continue;
                    }
                }

                // Step 2: Prefer the versioned bundle plan/apply pipeline.
                if (this.portableRunner) {
                    this.logger.debug(
                        `[${tenantId}] Running ${this.portableRunner.name} in ${mode} mode`,
                    );
                    await this.portableRunner.run(tenantId, mode);
                } else {
                    for (const importer of sortedImporters) {
                        this.logger.debug(
                            `[${tenantId}] Running ${importer.name} (phase ${importer.phase})`,
                        );
                        try {
                            await importer.importForTenant(tenantId);
                        } catch (error: any) {
                            this.logger.error(
                                { error: error.message },
                                `[${tenantId}] Failed to import ${importer.name}: ${error.message}`,
                            );
                            // Continue with next importer for this tenant
                        }
                    }
                }

                this.logger.log(`[${tenantId}] Import completed`);
            } catch (error: any) {
                const response =
                    error?.getResponse?.() ?? error?.response ?? undefined;
                const failedOperation = response?.failedOperation;
                const operationId = response?.operationId;
                const planIssues = response?.plan?.issues;
                const report = operationId
                    ? `; operation report: GET /config-bundles/operations/${operationId}`
                    : "";
                const failure = failedOperation
                    ? `; failed operation: ${failedOperation.stage}/${failedOperation.kind ?? ""}/${failedOperation.id ?? ""}`
                    : "";
                const issues = Array.isArray(planIssues)
                    ? `; blocking issues: ${planIssues
                          .filter((issue: any) => issue.severity !== "warning")
                          .map(
                              (issue: any) =>
                                  `${issue.code} at ${issue.path}: ${issue.message}`,
                          )
                          .join(" | ")}`
                    : "";
                this.logger.error(
                    {
                        error: error.message,
                        ...(operationId ? { operationId } : {}),
                        ...(failedOperation ? { failedOperation } : {}),
                    },
                    `[${tenantId}] Failed to import tenant: ${error.message}${failure}${issues}${report}`,
                );
                failedTenants.push(tenantId);
                // Continue with next tenant
            }
        }

        this.hasRun = true;

        if (failedTenants.length > 0) {
            this.logger.warn(
                `Config import completed with ${failedTenants.length} failed tenant(s): ${failedTenants.join(", ")}`,
            );
        } else {
            this.logger.log(
                `Config import completed for ${tenants.length} tenant(s)`,
            );
        }
    }
}
