import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
    normalizeDocument,
    resourceId,
    schemaUrl,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { tenantConfigFolder } from "../../shared/utils/tenant-config-folder.util.js";
import { ConfigImportService } from "../config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    formatBlockingIssue,
} from "../config-import/config-import-orchestrator.service.js";
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

/**
 * Body of the `400` that the reattach endpoints answer when a file of the
 * tenant folder cannot be imported. The startup import logs its `message` as
 * "Failed to import tenant".
 */
interface ConfigFolderInvalidResponse {
    code: "CONFIG_FOLDER_INVALID";
    /**
     * `<file>: <reason>`; for blocking issues, each as the startup import
     * logs it: `<code> in <kind>/<id> at <path>: <message>`.
     */
    message: string;
    /** The file, relative to the tenant folder, with `/` separators. */
    file: string;
    /**
     * The blocking issues of the file, as the plan of a bundle reports them
     * for a document: the migration's required inputs or validation errors,
     * each naming the resource; else one `CONFIG_FILE_INVALID` issue with the
     * reason, for a file that is no JSON, holds another resource kind or has
     * an unresolved placeholder.
     */
    issues: ConfigMigrationIssue[];
}

/** A file whose migration stopped with required inputs or errors. */
class BlockingIssuesError extends Error {
    constructor(readonly issues: ConfigMigrationIssue[]) {
        super(issues.map(formatBlockingIssue).join("; "));
    }
}

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
        const tenantRoot = tenantConfigFolder(
            this.configService.getOrThrow<string>("CONFIG_FOLDER"),
            tenantId,
        );
        // Unreachable after TenantService.setupTenant skipped the tenant.
        if (!tenantRoot) {
            throw new Error(`Tenant ID '${tenantId}' is not a folder name`);
        }
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
        const tenantRoot = tenantConfigFolder(configFolder, tenantId);
        if (!tenantRoot) {
            throw new ConflictException(
                `Tenant ID '${tenantId}' is not a folder name, so it has no config folder to reattach to.`,
            );
        }
        // Only the files of the requested kind, so a file of another kind
        // that does not import does not block this reattach. The plan checks
        // references against the database, not against other folder files.
        const full = this.collectBundle(
            tenantId,
            tenantRoot,
            kind === "Tenant"
                ? [TENANT_RESOURCE]
                : FOLDER_RESOURCES.filter((resource) => resource.kind === kind),
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
                    throw invalidFile(tenantRoot, filePath, error);
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
        const rawPayload = parseJsonFile(filePath);
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
            // The ID of the plan item a bundle would report; a document
            // without one is named after its file.
            const owner = {
                kind: result.document.kind,
                id: documentId(result.document) ?? id,
            };
            throw new BlockingIssuesError(
                blocking.map((issue) => ({ ...issue, resource: owner })),
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

/**
 * A file of the tenant folder cannot be imported. The operator fixes the file,
 * so the API answers `400`, not `500`; the startup import logs the message.
 */
function invalidFile(
    tenantRoot: string,
    filePath: string,
    error: unknown,
): BadRequestException {
    const file = relative(tenantRoot, filePath).split(sep).join("/");
    const reason = error instanceof Error ? error.message : String(error);
    const issues: ConfigMigrationIssue[] =
        error instanceof BlockingIssuesError
            ? error.issues
            : [
                  {
                      severity: "error",
                      code: "CONFIG_FILE_INVALID",
                      path: "",
                      message: reason,
                  },
              ];
    const response: ConfigFolderInvalidResponse = {
        code: "CONFIG_FOLDER_INVALID",
        message: `${file}: ${reason}`,
        file,
        issues,
    };
    return new BadRequestException(response, { cause: error });
}

/**
 * The parser's message quotes an excerpt of the file, which may be a key or a
 * secret, and the reason reaches API callers, so it is not repeated.
 */
function parseJsonFile(filePath: string): Record<string, unknown> {
    let text: string;
    try {
        text = readFileSync(filePath, "utf8");
    } catch {
        throw new Error("cannot be read");
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error("is not valid JSON");
    }
}

function documentId(document: ConfigDocument): string | undefined {
    try {
        return resourceId(document);
    } catch {
        return undefined;
    }
}

function folderSource(tenantRoot: string): string {
    return `folder:${tenantRoot}`;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}
