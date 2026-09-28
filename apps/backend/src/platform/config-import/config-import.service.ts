import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceId } from "@eudiplo/config-format/config-format.js";
import { resolveConfigVariables } from "@eudiplo/config-format/config-values.js";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConfigMigrationService } from "../config-portability/config-migration.service.js";
import { ConfigOwnershipService } from "../config-portability/config-ownership.service.js";
import { ConfigResourceRegistry } from "../config-portability/config-resource.registry.js";
import type { ConfigDocument } from "../config-portability/config-resource.types.js";
import { ConfigImportModeService } from "./config-import-mode.service.js";
import { TenantImportOptions } from "./import-options.js";

function resolveValidationSchema(schemaOrDto: unknown): any | undefined {
    if (!schemaOrDto) {
        return undefined;
    }

    const candidate = schemaOrDto as any;
    if (typeof candidate.safeParse === "function") {
        return candidate;
    }

    if (typeof candidate.schema?.safeParse === "function") {
        return candidate.schema;
    }

    return undefined;
}

@Injectable()
export class ConfigImportService {
    private readonly logger = new Logger(ConfigImportService.name);

    constructor(
        private readonly configService: ConfigService,
        @Optional()
        private readonly migrationService?: ConfigMigrationService,
        @Optional()
        private readonly ownershipService?: ConfigOwnershipService,
        @Optional()
        private readonly resourceRegistry?: ConfigResourceRegistry,
        @Optional()
        private readonly importModeService?: ConfigImportModeService,
    ) {}

    /**
     * Import configs for a specific tenant.
     * This is the preferred method when using the orchestrator's tenant-by-tenant approach.
     */
    async importConfigsForTenant<T extends object>(
        tenantId: string,
        options: TenantImportOptions<T>,
    ): Promise<void> {
        const configPath = this.configService.getOrThrow("CONFIG_FOLDER");
        const mode = this.resolveMode();
        if (mode === "disabled") return;
        const updateExisting = mode !== "create";
        const strictConfig = this.configService.get<any>(
            "CONFIG_VARIABLE_STRICT",
        );

        let counter = 0;
        const path = join(configPath, tenantId, options.subfolder);

        if (!existsSync(path)) {
            return;
        }

        const files = readdirSync(path);

        for (const file of files) {
            const filePath = join(path, file);

            // Filter by extension if provided
            if (
                options.fileExtension &&
                !file.endsWith(options.fileExtension)
            ) {
                continue;
            }

            try {
                // Load data using custom loader or default JSON loader
                let data: T;
                let portableDocument: ConfigDocument | undefined;
                const resourceKind =
                    options.resourceKind ??
                    this.resourceRegistry?.inferKind(options.resourceType);
                const raw = readFileSync(filePath, "utf8");
                if (
                    resourceKind &&
                    this.migrationService &&
                    file.endsWith(".json")
                ) {
                    const payload = this.replacePlaceholders(
                        JSON.parse(raw),
                    ) as Record<string, unknown>;
                    const fileId = file.replace(/\.json$/i, "");
                    const wrapped = this.migrationService.isDocument(payload)
                        ? payload
                        : this.migrationService.wrapLegacy(
                              resourceKind,
                              payload,
                              String(payload.id ?? payload.clientId ?? fileId),
                          );
                    const upgraded = this.migrationService.upgrade(wrapped);
                    const blocking = upgraded.issues.filter(
                        (issue) => issue.severity !== "warning",
                    );
                    if (blocking.length > 0) {
                        throw new Error(
                            `Configuration migration requires input: ${blocking
                                .map(
                                    (issue) =>
                                        `${issue.path}: ${issue.message}`,
                                )
                                .join("; ")}`,
                        );
                    }
                    if (upgraded.document.kind !== resourceKind)
                        throw new Error(
                            `Expected ${resourceKind} configuration`,
                        );
                    portableDocument = upgraded.document;
                    data = this.migrationService.unwrapForLegacyImporter(
                        upgraded.document,
                    ) as T;
                } else if (options.loadData) {
                    data = await Promise.resolve(options.loadData(filePath));
                } else {
                    const payload = JSON.parse(raw);
                    data = payload as T;
                }

                // Replace placeholders like ${ENV_VAR} or ${ENV_VAR:default}
                if (!portableDocument) data = this.replacePlaceholders(data);

                // Validate if validation schema is provided
                if (options.validationSchema) {
                    const validationResult = await this.validateConfig(
                        filePath,
                        file,
                        data,
                        options.validationSchema,
                        { name: tenantId },
                        options.resourceType,
                        options.formatValidationError,
                    );

                    if (!validationResult.isValid) {
                        throw new Error(
                            `Validation failed for ${options.resourceType} ${file}`,
                        );
                    }

                    data = validationResult.data as T;
                }

                // Check if exists
                const exists = await options
                    .checkExists(tenantId, data, file)
                    .catch(() => false);

                if (
                    exists &&
                    portableDocument &&
                    resourceKind &&
                    this.ownershipService
                ) {
                    const stored = await this.ownershipService.get(
                        tenantId,
                        resourceKind,
                        resourceId(portableDocument),
                    );
                    const incomingGeneration =
                        portableDocument.metadata.generation ?? 1;
                    if (incomingGeneration < stored.generation) {
                        throw new Error(
                            `Stale configuration generation ${incomingGeneration}; stored generation is ${stored.generation}`,
                        );
                    }
                }

                if (exists && !updateExisting) {
                    this.logger.debug(
                        `[${tenantId}] ${options.resourceType} ${file} already exists, skipping`,
                    );
                    continue;
                }

                // Delete existing if force is enabled
                if (exists && updateExisting && options.deleteExisting) {
                    await options.deleteExisting(tenantId, data, file);
                }

                // Process and store item
                await options.processItem(tenantId, data, file);
                if (portableDocument && resourceKind && this.ownershipService) {
                    await this.markFileManaged(
                        tenantId,
                        resourceKind,
                        portableDocument,
                        filePath,
                        raw,
                    );
                }
                counter++;
            } catch (error: any) {
                const reason = error?.message || "Unknown error";
                this.logger.error(
                    `[${tenantId}] Failed to import ${options.resourceType} ${file} (${filePath}): ${reason}`,
                );
                if (strictConfig === "abort") {
                    // Abort the entire import process in strict abort mode
                    throw error;
                }
            }
        }

        if (counter > 0) {
            this.logger.log(
                `[${tenantId}] ${counter} ${options.resourceType}(s) imported`,
            );
        }
    }

    private async markFileManaged(
        tenantId: string,
        kind: import("../config-portability/config-resource.types.js").ConfigResourceKind,
        document: ConfigDocument,
        filePath: string,
        raw: string,
    ): Promise<void> {
        await this.ownershipService!.markApplied({
            tenantId,
            kind,
            resourceId: resourceId(document),
            ownership: "file-managed",
            generation: document.metadata.generation ?? 1,
            source: filePath,
            sourceHash: createHash("sha256").update(raw).digest("hex"),
        });
    }

    /**
     * Recursively replace placeholders of the form ${VAR} or ${VAR:default} in all string properties.
     * ${VAR} -> replaced with process.env.VAR if defined; if undefined and no default given, logs a warning and leaves placeholder intact.
     * ${VAR:default} -> replaced with env value if defined, otherwise with "default".
     */
    replacePlaceholders<T>(input: T): T {
        const configured = this.configService.get<any>(
            "CONFIG_VARIABLE_STRICT",
        );
        const strict =
            configured === true ||
            configured === "true" ||
            configured === "abort" ||
            configured === "skip";
        const result = resolveConfigVariables(input, process.env);
        if (strict && result.issues.length)
            throw new Error(
                result.issues
                    .map((issue) => `${issue.path}: ${issue.message}`)
                    .join("; "),
            );
        for (const issue of result.issues)
            this.logger.warn(`${issue.path}: ${issue.message}`);
        return result.value;
    }

    private resolveMode():
        | "disabled"
        | import("../config-portability/config-resource.types.js").ConfigImportMode {
        if (this.importModeService) {
            return this.importModeService.resolve();
        }
        if (!this.configService.get<boolean>("CONFIG_IMPORT")) {
            return "disabled";
        }
        return this.configService.get<boolean>("CONFIG_IMPORT_FORCE")
            ? "upsert"
            : "create";
    }

    /**
     * Validate configuration against a Zod schema or parse-capable DTO.
     */
    async validateConfig<T extends object>(
        filePath: string,
        file: string,
        payload: any,
        schemaOrDto: any,
        tenant: { name: string },
        resourceType: string,
        formatError?: (error: unknown) => any,
    ): Promise<{ isValid: boolean; data: T }> {
        const schema = resolveValidationSchema(schemaOrDto);
        if (!schema) {
            throw new Error(
                `Validation requested for ${resourceType} ${file} (${filePath}) but no Zod schema was provided`,
            );
        }

        const parsed = schema.safeParse(payload) as
            | { success: true; data: T }
            | { success: false; error: any };

        if (!parsed.success) {
            const formatter =
                formatError ||
                ((error: unknown) => {
                    if (
                        error &&
                        typeof error === "object" &&
                        "path" in error &&
                        "message" in error
                    ) {
                        return error;
                    }
                    return { message: "Invalid config" };
                });

            this.logger.error(
                { errors: parsed.error.issues.map(formatter) },
                `[${tenant.name}] Validation failed for ${resourceType} ${file} (${filePath})`,
            );

            return { isValid: false, data: payload };
        }

        return { isValid: true, data: parsed.data as T };
    }

    /**
     * Extract nested error messages from validation errors
     */
    extractErrorMessages(error: unknown): string[] {
        if (
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
        ) {
            return [(error as { message: string }).message];
        }

        return ["Invalid config"];
    }

    formatNestedValidationError(error: unknown): string {
        return this.extractErrorMessages(error).join(", ");
    }
}
