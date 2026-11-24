import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    KMS_TENANT_VARIABLES,
    parseTenantKmsVariables,
    refusedConfigVariable,
} from "../../../platform/config/config-variable-scope.js";
import {
    createValidationException,
    findRefusedEnvPlaceholderIssues,
} from "../../../shared/common/zod/zod-schema.util.js";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import {
    type KmsConfig,
    type KmsProviderConfig,
    parseRawKmsConfig,
    parseResolvedKmsConfig,
} from "../schemas/kms-config.schema.js";
import { kmsConfigFilePath, parseKmsConfigFile } from "./kms-config-file.js";
import { findKmsIdentifierPlaceholderIssues } from "./kms-identifier-placeholders.js";
import {
    findTenantKmsRestrictionIssues,
    KMS_TENANT_AWS_DEFAULT_CREDENTIALS,
    KMS_TENANT_FILES,
    parseTenantKmsFiles,
    type TenantKmsAllowances,
    valueAtPath,
} from "./kms-tenant-restrictions.js";

const DEFAULT_PROVIDER_ID = "db";

/** What one content of a tenant's `kms.json` gives; errors are kept too. */
interface TenantKmsSnapshot {
    /** The content of the file, null without a file. */
    text: string | null;
    /** The file as stored, placeholders unresolved. */
    file: KmsConfig | null;
    /** Why the file is no valid KMS configuration. */
    fileError?: unknown;
    /** The global configuration with the tenant's resolved file over it. */
    config?: KmsConfig;
    /** Why the providers of the file do not load. */
    configError?: unknown;
}

/**
 * Loads, validates and exposes the parsed `kms.json` configuration.
 *
 * Centralises file-system access and `${ENV_VAR}` placeholder resolution
 * so the rest of the KMS code only ever sees a typed, resolved view.
 * The global file is read once at construction time. A tenant file is read
 * on every call and parsed again when its content changed.
 *
 * Which variables a file may name depends on who can write it (see
 * `config-variable-scope.ts`): the global file is the operator's, a tenant
 * file can be written through the API by that tenant's administrators and
 * only resolves the variables the operator listed in `KMS_TENANT_VARIABLES`.
 * For the same reason a tenant file may only name the files of the host
 * listed in `KMS_TENANT_FILES`, and gets AWS credentials from the backend's
 * environment only with `KMS_TENANT_AWS_DEFAULT_CREDENTIALS` (see
 * `kms-tenant-restrictions.ts`). The servers of its providers must pass the
 * outbound URL policy of the instance.
 */
@Injectable()
export class KmsConfigService {
    private readonly logger = new Logger(KmsConfigService.name);
    private readonly globalConfig: KmsConfig;
    private readonly tenantConfigCache = new Map<string, TenantKmsSnapshot>();
    private readonly tenantVariables: ReadonlySet<string>;
    private readonly tenantAllowances: TenantKmsAllowances;

    constructor(
        private readonly configService: ConfigService,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
    ) {
        this.tenantVariables = parseTenantKmsVariables(
            this.configService.get<string>(KMS_TENANT_VARIABLES),
        );
        this.tenantAllowances = {
            files: parseTenantKmsFiles(
                this.configService.get<string>(KMS_TENANT_FILES),
            ),
            awsDefaultCredentials:
                this.configService.get<boolean>(
                    KMS_TENANT_AWS_DEFAULT_CREDENTIALS,
                ) === true,
            refusedUrl: (url) => this.outboundUrlPolicy.refusedUrl(url),
        };
        this.globalConfig = this.loadGlobalConfig();
        this.reportRefusedTenantFiles();
    }

    /**
     * Validate a tenant configuration and resolve its placeholders, as
     * loading the tenant's `kms.json` with this content would.
     *
     * @throws BadRequestException when it is invalid, names a variable that
     * is unset or that a tenant `kms.json` may not use, holds a placeholder
     * in an identifier (findKmsIdentifierPlaceholderIssues), or holds a setting
     * only the global file may hold (findTenantKmsRestrictionIssues).
     */
    resolveTenantConfig(input: unknown, source: string): KmsConfig {
        // Before anything is resolved: an identifier comes back from the API.
        const identifiers = findKmsIdentifierPlaceholderIssues(input);
        if (identifiers.length > 0) {
            throw createValidationException(
                identifiers,
                `${source}: ${identifiers.map((issue) => issue.message).join("; ")}`,
            );
        }
        const resolved = parseResolvedKmsConfig(
            input,
            source,
            this.refuseInTenantFile,
        );
        const issues = findTenantKmsRestrictionIssues(
            resolved,
            this.tenantAllowances,
        );
        if (issues.length > 0) {
            throw createValidationException(
                issues,
                `${source}: ${issues.map((issue) => issue.message).join("; ")}`,
            );
        }
        return resolved;
    }

    private readonly refuseInTenantFile = (name: string) =>
        refusedConfigVariable(name, "tenant-kms", this.tenantVariables);

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

        return this.getTenantSnapshot(tenantId).config;
    }

    /**
     * The tenant's own `kms.json` as stored, placeholders unresolved, or
     * null. Also for a file whose providers do not load, for example
     * because it names a variable it may not use.
     *
     * @throws when the file is no valid KMS configuration
     */
    getTenantFile(tenantId: string): KmsConfig | null {
        const snapshot = this.tenantSnapshot(tenantId);
        if (snapshot.fileError) throw snapshot.fileError;
        return snapshot.file;
    }

    /**
     * The tenant's configuration together with the stored file it was built
     * from, from one read: what a provider ID resolves to and whose the
     * provider is must not come from two states of the file.
     *
     * @throws like getConfig when the file cannot be loaded
     */
    getTenantSnapshot(tenantId: string): {
        config: KmsConfig;
        file: KmsConfig | null;
    } {
        const snapshot = this.tenantSnapshot(tenantId);
        if (!snapshot.config) throw snapshot.configError;
        return { config: snapshot.config, file: snapshot.file };
    }

    /**
     * What the tenant's `kms.json` gives, loaded again when the content of
     * the file is no longer what the cached result was built from. The
     * cache is per process, and several processes may share the folder: a
     * process that did not write the file would otherwise keep the provider
     * an ID named before, for example the global one that the tenant's own
     * provider now replaces. The content is compared, not the file's
     * metadata, which a second write can repeat.
     */
    private tenantSnapshot(tenantId: string): TenantKmsSnapshot {
        const text = this.readTenantFile(tenantId);
        const cached = this.tenantConfigCache.get(tenantId);
        if (cached?.text === text) {
            return cached;
        }

        const snapshot = this.loadTenantSnapshot(tenantId, text);
        this.tenantConfigCache.set(tenantId, snapshot);
        return snapshot;
    }

    private loadTenantSnapshot(
        tenantId: string,
        text: string | null,
    ): TenantKmsSnapshot {
        if (text === null) {
            return { text, file: null, config: this.globalConfig };
        }
        const source = `tenant '${tenantId}' kms.json`;
        let spec: unknown;
        let file: KmsConfig;
        try {
            spec = parseKmsConfigFile(text, source);
            file = parseRawKmsConfig(spec, source);
        } catch (err) {
            this.warnTenantFile(tenantId, err);
            return { text, file: null, fileError: err, configError: err };
        }
        try {
            return {
                text,
                file,
                config: mergeConfigs(
                    this.globalConfig,
                    this.resolveTenantConfig(spec, source),
                ),
            };
        } catch (err) {
            this.warnTenantFile(tenantId, err);
            return { text, file, configError: err };
        }
    }

    private warnTenantFile(tenantId: string, err: unknown): void {
        this.logger.warn(
            `Failed to read tenant kms.json for '${tenantId}': ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    private readTenantFile(tenantId: string): string | null {
        const path = this.resolveConfigPath(tenantId);
        if (!path) return null;
        try {
            return readFileSync(path, "utf8");
        } catch (err) {
            // Removed since it was found.
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
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
                parseKmsConfigFile(raw, source),
                source,
                (name) => refusedConfigVariable(name, "global"),
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

    /**
     * Log every tenant `kms.json` that names a variable it may not use or
     * holds a setting only the global file may hold. Such a file fails to
     * load when the tenant first needs a key, so the operator should hear
     * about it at startup, for example after an upgrade.
     */
    private reportRefusedTenantFiles(): void {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder || !existsSync(configFolder)) {
            return;
        }
        let tenantIds: string[];
        try {
            tenantIds = readdirSync(resolve(configFolder), {
                withFileTypes: true,
            })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch {
            return;
        }
        for (const tenantId of tenantIds) {
            const path = this.resolveConfigPath(tenantId);
            if (!path) continue;
            try {
                const source = `tenant '${tenantId}' kms.json`;
                const spec = parseKmsConfigFile(
                    readFileSync(path, "utf8"),
                    source,
                );
                // Before the schema, as when the file is loaded: it may not
                // accept an identifier with a placeholder.
                const reportVariables = (issues: { message: string }[]) =>
                    this.logger.error(
                        `${path} cannot be loaded, so the tenant's key operations fail: ${[...new Set(issues.map((issue) => issue.message))].join("; ")}. If you did not write these placeholders, treat the named variables as disclosed.`,
                    );
                const identifiers = findKmsIdentifierPlaceholderIssues(spec);
                if (identifiers.length > 0) {
                    // Without the schema: it may not accept such an identifier.
                    reportVariables([
                        ...identifiers,
                        ...findRefusedEnvPlaceholderIssues(
                            spec,
                            this.refuseInTenantFile,
                        ),
                    ]);
                    continue;
                }
                const raw = parseRawKmsConfig(spec, source);
                const variables = findRefusedEnvPlaceholderIssues(
                    raw,
                    this.refuseInTenantFile,
                );
                if (variables.length > 0) {
                    reportVariables(variables);
                    continue;
                }
                // Checked as stored: a path behind a placeholder is the
                // operator's and is checked when the file is loaded, as are
                // request paths, whose baseUrl may be a placeholder.
                const settings = findTenantKmsRestrictionIssues(
                    raw,
                    this.tenantAllowances,
                )
                    .filter(
                        (issue) =>
                            issue.code === "missing_aws_credentials" ||
                            ((issue.code === "refused_server_file" ||
                                issue.code === "refused_outbound_url") &&
                                !HOLDS_PLACEHOLDER.test(
                                    String(valueAtPath(raw, issue.path)),
                                )),
                    )
                    .map((issue) => issue.message);
                if (settings.length > 0) {
                    this.logger.error(
                        `${path} cannot be loaded, so the tenant's key operations fail: ${settings.join("; ")}. If you did not write these settings, check what the backend loaded or read for this tenant.`,
                    );
                }
            } catch {
                // An invalid file is reported when the tenant loads it.
            }
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

const HOLDS_PLACEHOLDER = /\$\{[A-Z0-9_]+\}/;

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

/** A tenant configuration over the global one: a provider with the same `id` replaces. */
export function mergeConfigs(global: KmsConfig, tenant: KmsConfig): KmsConfig {
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
