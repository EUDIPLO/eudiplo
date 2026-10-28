import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
    normalizeDocument,
    resourceId,
    schemaUrl,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConfigImportService } from "../config-import/config-import.service.js";
import { ConfigImportOrchestratorService } from "../config-import/config-import-orchestrator.service.js";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundle,
    ConfigBundleAsset,
    ConfigDocument,
    ConfigImportMode,
    ConfigImportPlan,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { generatedSecretsOf } from "./generated-secrets.js";

type FolderResource =
    | { kind: ConfigResourceKind; file: string }
    | { kind: ConfigResourceKind; directory: string };

const FOLDER_RESOURCES: FolderResource[] = [
    { kind: "KmsConfig", file: "kms.json" },
    { kind: "Client", directory: "clients" },
    { kind: "KeyChain", directory: "key-chains" },
    { kind: "KeyChainDefaults", file: "key-chain-defaults.json" },
    { kind: "RegistrarConfig", file: "registrar.json" },
    { kind: "AttributeProvider", directory: "attribute-providers" },
    { kind: "WebhookEndpoint", directory: "webhook-endpoints" },
    { kind: "IssuanceConfig", file: "issuance/issuance.json" },
    { kind: "CredentialConfig", directory: "issuance/credentials" },
    { kind: "TrustList", directory: "trust-lists" },
    {
        kind: "FederationTrustAnchor",
        directory: "federation-trust-anchors",
    },
    { kind: "PresentationConfig", directory: "presentation" },
    { kind: "StatusList", directory: "issuance/status-lists" },
];

/**
 * The tenant settings. The startup import applies `info.json` before the
 * other files (see TenantService.setupTenant), so only a reattach reads it
 * here.
 */
const TENANT_RESOURCE: FolderResource = { kind: "Tenant", file: "info.json" };

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
};

@Injectable()
export class ConfigFolderBundleService {
    private readonly logger = new Logger(ConfigFolderBundleService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly configImportService: ConfigImportService,
        private readonly migrationService: ConfigMigrationService,
        private readonly resourceRegistry: ConfigResourceRegistry,
        private readonly applyService: ConfigBundleApplyService,
        orchestrator: ConfigImportOrchestratorService,
        private readonly bundleService: ConfigBundleService,
    ) {
        orchestrator.registerPortableRunner(
            "versioned folder plan/apply",
            (tenantId, mode) => this.applyTenantFolder(tenantId, mode),
        );
    }

    async applyTenantFolder(
        tenantId: string,
        mode: ConfigImportMode,
    ): Promise<void> {
        const configRoot = resolve(
            this.configService.getOrThrow<string>("CONFIG_FOLDER"),
        );
        const tenantRoot = join(configRoot, tenantId);
        const bundle = this.buildBundle(tenantId, tenantRoot);
        const source = folderSource(tenantRoot);
        let plan: ConfigImportPlan;
        try {
            plan = await this.applyService.apply(
                tenantId,
                bundle,
                mode,
                source,
            );
        } catch (error) {
            this.warnGeneratedSecrets(tenantId, generatedSecretsOf(error));
            throw error;
        }
        this.warnGeneratedSecrets(tenantId, plan.generatedSecrets);
        for (const item of plan.items) {
            if (item.action !== "skip") continue;
            for (const issue of item.issues) {
                if (
                    issue.code === "RESOURCE_DETACHED" ||
                    issue.code === "STALE_GENERATION" ||
                    issue.code === "KEY_CHAIN_ID_RESERVED"
                ) {
                    this.logger.warn(
                        `[${tenantId}] Skipped ${item.kind} '${item.id}' (${issue.code}): ${issue.message}`,
                    );
                }
            }
        }
        const counts = plan.items.reduce<Record<string, number>>(
            (result, item) => {
                result[item.action] = (result[item.action] ?? 0) + 1;
                return result;
            },
            {},
        );
        this.logger.log(
            `[${tenantId}] Startup config ${mode} completed: ${
                Object.entries(counts)
                    .map(([action, count]) => `${count} ${action}`)
                    .join(", ") || "no resources"
            }`,
        );
    }

    /**
     * A startup import has no caller to return generated secrets to. Name each
     * client, never its secret, and say how to get a secret that can be read.
     */
    private warnGeneratedSecrets(
        tenantId: string,
        generatedSecrets: ConfigImportPlan["generatedSecrets"],
    ): void {
        for (const { id } of generatedSecrets ?? []) {
            this.logger.warn(
                `[${tenantId}] Client '${id}' got a generated secret ("secret": "!generate"), which a startup import does not show. To get a new secret, reattach the client: POST /api/config-bundles/resources/Client/${id}/reattach/plan, then /reattach with the plan's fingerprint, or "Apply from file" under Settings > Config Portability.`,
            );
        }
    }

    /** Plans resetting one resource to its version in the startup config folder. */
    async planReattach(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<ConfigImportPlan> {
        const { bundle, source } = this.resourceBundle(tenantId, kind, id);
        return this.bundleService.plan(tenantId, bundle, "upsert", source, {
            reattach: true,
        });
    }

    /**
     * Applies the folder version of one resource and makes it file-managed
     * again, discarding changes made through the API or UI.
     */
    async reattach(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
        planFingerprint: string,
        callerRoles?: readonly string[],
    ): Promise<ConfigImportPlan> {
        const { bundle, source } = this.resourceBundle(tenantId, kind, id);
        return this.applyService.apply(
            tenantId,
            bundle,
            "upsert",
            source,
            planFingerprint,
            { reattach: true, callerRoles },
        );
    }

    private resourceBundle(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): { bundle: ConfigBundle; source: string } {
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder) {
            throw new ConflictException(
                "No CONFIG_FOLDER is configured, so there is no file version to reattach to.",
            );
        }
        const tenantRoot = join(resolve(configFolder), tenantId);
        const full = this.collectBundle(
            tenantId,
            tenantRoot,
            kind === "Tenant" ? [TENANT_RESOURCE] : FOLDER_RESOURCES,
        );
        const index = full.documents.findIndex(
            (document) =>
                normalizeDocument(document).kind === kind &&
                resourceId(document) === id,
        );
        if (index === -1) {
            throw new NotFoundException(
                `${kind} '${id}' is not defined in the config folder for tenant '${tenantId}'.`,
            );
        }
        const document = full.documents[index];
        // Only carry the images this document references, so other assets keep their current content.
        const referenced = new Set<string>();
        const collect = (value: unknown): void => {
            if (typeof value === "string") referenced.add(value);
            else if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === "object")
                Object.values(value).forEach(collect);
        };
        collect(document.spec);
        const assets = full.assets.filter((asset) =>
            referenced.has(asset.path.replace(/^images\//, "")),
        );
        const paths = new Set(assets.map((asset) => asset.path));
        return {
            source: folderSource(tenantRoot),
            bundle: {
                manifest: {
                    ...full.manifest,
                    resources: [full.manifest.resources[index]],
                    assets: full.manifest.assets.filter((asset) =>
                        paths.has(asset.path),
                    ),
                },
                documents: [document],
                assets,
            },
        };
    }

    buildBundle(tenantId: string, tenantRoot: string): ConfigBundle {
        return this.collectBundle(tenantId, tenantRoot, FOLDER_RESOURCES);
    }

    private collectBundle(
        tenantId: string,
        tenantRoot: string,
        folderResources: FolderResource[],
    ): ConfigBundle {
        const documents: ConfigDocument[] = [];
        const warnings: ConfigMigrationIssue[] = [];

        for (const resource of folderResources) {
            for (const filePath of this.resourceFiles(tenantRoot, resource)) {
                try {
                    const { document, issues } = this.loadResourceDocument(
                        resource,
                        filePath,
                    );
                    documents.push(document);
                    warnings.push(...issues);
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    throw new Error(`${filePath}: ${message}`, {
                        cause: error,
                    });
                }
            }
        }

        const assets = this.loadAssets(tenantRoot);
        const resources = documents.map((document) => ({
            kind: document.kind,
            id: resourceId(document),
            $schema: schemaUrl(document.kind),
            path: this.documentPath(tenantRoot, document),
            sha256: sha256(JSON.stringify(serializeDocument(document))),
            ownership: "file-managed" as const,
            generation: document.metadata.generation ?? 1,
        }));
        return {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion: "startup-folder",
                exportedAt: new Date(0).toISOString(),
                tenant: tenantId,
                resources,
                assets: assets.map(({ path, contentType, sha256: hash }) => ({
                    path,
                    contentType,
                    sha256: hash,
                })),
                requirements: [],
                warnings,
            },
            documents: documents.map((document) => serializeDocument(document)),
            assets,
        };
    }

    private loadResourceDocument(
        resource: FolderResource,
        filePath: string,
    ): { document: ConfigDocument; issues: ConfigMigrationIssue[] } {
        const rawPayload = JSON.parse(readFileSync(filePath, "utf8")) as Record<
            string,
            unknown
        >;
        const payload =
            this.configImportService.replacePlaceholders(rawPayload);
        const fileId = filePath
            .split(/[\\/]/)
            .pop()!
            .replace(/\.json$/i, "");
        const singletonId = this.resourceRegistry.get(
            resource.kind,
        ).singletonId;
        const id = String(
            (payload.metadata as Record<string, unknown> | undefined)?.id ??
                singletonId ??
                payload.id ??
                payload.clientId ??
                fileId,
        );
        const input = this.migrationService.isDocument(payload)
            ? payload
            : this.migrationService.wrapLegacy(resource.kind, payload, id);
        const result = this.migrationService.upgrade(input);
        if (result.document.kind !== resource.kind) {
            throw new Error(
                `contains ${result.document.kind}, expected ${resource.kind}`,
            );
        }
        const blocking = result.issues.filter(
            (issue) => issue.severity !== "warning",
        );
        if (blocking.length > 0) {
            throw new Error(
                `requires input: ${blocking
                    .map((issue) => `${issue.path}: ${issue.message}`)
                    .join("; ")}`,
            );
        }
        return { document: result.document, issues: result.issues };
    }

    private resourceFiles(
        tenantRoot: string,
        resource: FolderResource,
    ): string[] {
        if ("file" in resource) {
            const path = join(tenantRoot, resource.file);
            return existsSync(path) ? [path] : [];
        }
        const directory = join(tenantRoot, resource.directory);
        if (!existsSync(directory)) {
            return [];
        }
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => join(directory, entry.name))
            .sort((left, right) => left.localeCompare(right));
    }

    private loadAssets(tenantRoot: string): ConfigBundleAsset[] {
        const directory = join(tenantRoot, "images");
        if (!existsSync(directory)) {
            return [];
        }
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
            .map((entry) => {
                const data = readFileSync(join(directory, entry.name));
                return {
                    path: `images/${entry.name}`,
                    contentType:
                        MIME_TYPES[extname(entry.name).toLowerCase()] ??
                        "application/octet-stream",
                    sha256: sha256(data),
                    data: data.toString("base64"),
                };
            })
            .sort((left, right) => left.path.localeCompare(right.path));
    }

    private documentPath(tenantRoot: string, document: ConfigDocument): string {
        const definition = [TENANT_RESOURCE, ...FOLDER_RESOURCES].find(
            (candidate) => candidate.kind === document.kind,
        )!;
        if ("file" in definition) {
            return definition.file;
        }
        return `${definition.directory}/${resourceId(document)}.json`;
    }
}

function folderSource(tenantRoot: string): string {
    return `folder:${tenantRoot}`;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}
