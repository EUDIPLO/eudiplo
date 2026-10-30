import { createHash } from "node:crypto";
import { sanitizeClaimFields } from "@eudiplo/config-format/claim-constraints.js";
import { assertConfigBundle } from "@eudiplo/config-format/config-bundle.js";
import {
    CONFIG_SINGLETON_IDS,
    resourceId,
    schemaUrl,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import {
    type ConfigChange,
    configChanges,
    stableConfigJson,
} from "@eudiplo/config-format/config-values.js";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { compare as compareSecret } from "bcrypt";
import { Not, Repository } from "typeorm";
import {
    DEFAULT_KEY_CHAIN_ENTRIES,
    type DefaultKeyChains,
    defaultKeyChainsOrNull,
} from "../../auth/tenant/domain/tenant-data.js";
import {
    type KeyChainConfigurationChange,
    KeyChainReferences,
} from "../../crypto/key/application/key-chain-references.js";
import { accessTokenKeyChainUsageRefusal } from "../../crypto/key/domain/access-token-keys.js";
import { defaultKeyChainUsageRefusal } from "../../crypto/key/domain/default-access-key-chain.js";
import {
    describeKeyChainReferences,
    isKeyChainReferenceKind,
    keyChainReferenceId,
} from "../../crypto/key/domain/key-chain-reference.js";
import {
    type KeyChainEntity,
    KeyUsage,
} from "../../crypto/key/entities/key-chain.entity.js";
import { KmsTenantConfigService } from "../../crypto/key/kms/kms-tenant-config.service.js";
import { withoutRemovedChainedVp } from "../../issuer/configuration/issuance/domain/removed-authorization-servers.js";
import {
    type ConfigurationChange,
    TrustListReferences,
} from "../../issuer/trust-list/application/trust-list-references.js";
import {
    describeTrustListReferences,
    isTrustListReferenceKind,
    trustListReferenceId,
} from "../../issuer/trust-list/domain/trust-list-reference.js";
import { trustListConfig } from "../../issuer/trust-list/trust-list-config.js";
import { FileEntity } from "../../storage/entities/files.entity.js";
import { FilesService } from "../../storage/files.service.js";
import {
    type FederationTrustAnchorConfigurationChange,
    FederationTrustAnchorReferences,
} from "../../trust/federation-trust-anchor/application/federation-trust-anchor-references.js";
import {
    describeFederationTrustAnchorReferences,
    federationTrustAnchorReferenceId,
    isFederationTrustAnchorReferenceKind,
} from "../../trust/federation-trust-anchor/domain/federation-trust-anchor-reference.js";
import { ConfigBundleRepositories } from "./config-bundle-repositories.service.js";
import {
    ConfigDocumentValidationService,
    UNRESOLVED_PLACEHOLDER,
} from "./config-document-validation.service.js";
import { ConfigKmsReferenceService } from "./config-kms-reference.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import {
    ConfigOwnershipService,
    sourceInScope,
} from "./config-ownership.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundle,
    ConfigBundleRequirement,
    ConfigDocument,
    ConfigFile,
    ConfigImportMode,
    ConfigImportPlan,
    ConfigImportPlanItem,
    ConfigMigrationIssue,
    ConfigPlanOptions,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { documentAppliedAsIs } from "./config-source-hash.js";
import {
    appliedKeyChainType,
    appliedKmsProvider,
    appliedRotationPolicy,
    keyChainSettingsSpec,
} from "./key-chain-document.js";

const OMITTED_FIELDS = new Set([
    "tenant",
    "tenantId",
    "createdAt",
    "updatedAt",
    "registrationCertificateCache",
    "readerAuthCache",
    "cwt",
    "list",
    "statusList",
    "previousJwk",
    "previousCertificate",
    "previousKeyExpiry",
    "lastRotatedAt",
]);

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * The configuration revision also leaves out signed artifacts such as a trust
 * list's `jwt`, which change when the list is signed again, not when its
 * configuration changes. Exports keep `jwt`: an imported registration
 * certificate is configuration.
 */
const REVISION_OMITTED_FIELDS = new Set([...OMITTED_FIELDS, "jwt"]);

function canonicalize(
    value: unknown,
    omitted: ReadonlySet<string> = OMITTED_FIELDS,
): unknown {
    if (Array.isArray(value))
        return value.map((item) => canonicalize(item, omitted));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key, item]) => !omitted.has(key) && item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item, omitted)]),
    );
}

function pathMatches(pattern: string, path: string): boolean {
    const expected = pattern.split(".");
    const actual = path.split(".");
    return (
        expected.length === actual.length &&
        expected.every((part, index) => part === "*" || part === actual[index])
    );
}

/** The action a plan item gets from its state, in order of precedence. */
function planAction(state: {
    blocked: boolean;
    skip: boolean;
    unchanged: boolean;
    exists: boolean;
}): ConfigImportPlanItem["action"] {
    if (state.blocked) return "blocked";
    if (state.skip) return "skip";
    if (state.unchanged) return "unchanged";
    return state.exists ? "update" : "create";
}

/** The plan items by `<kind>/<id>`. */
function planActions(
    items: ConfigImportPlanItem[],
): Map<string, ConfigImportPlanItem> {
    return new Map(items.map((item) => [`${item.kind}/${item.id}`, item]));
}

/** Records a blocking issue on its plan item, if any, and in `issues`. */
function block(
    item: ConfigImportPlanItem | undefined,
    issues: ConfigMigrationIssue[],
    issue: ConfigMigrationIssue,
): void {
    if (item) {
        item.issues.push(issue);
        item.action = "blocked";
    }
    issues.push(issue);
}

function placeholder(
    kind: ConfigResourceKind,
    id: string,
    path: string,
): string {
    // Splitting avoids a trailing `_+$` match, which backtracks on long IDs.
    return `${kind}_${id}_${path}`
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .join("_")
        .toUpperCase();
}

@Injectable()
export class ConfigBundleService {
    constructor(
        private readonly repos: ConfigBundleRepositories,
        @InjectRepository(FileEntity)
        private readonly files: Repository<FileEntity>,
        private readonly filesService: FilesService,
        private readonly kmsTenantConfigService: KmsTenantConfigService,
        private readonly kmsReferenceService: ConfigKmsReferenceService,
        private readonly registry: ConfigResourceRegistry,
        private readonly migrationService: ConfigMigrationService,
        private readonly documentValidationService: ConfigDocumentValidationService,
        private readonly ownershipService: ConfigOwnershipService,
        private readonly configService: ConfigService,
        private readonly trustListReferences: TrustListReferences,
        private readonly federationTrustAnchorReferences: FederationTrustAnchorReferences,
        private readonly keyChainReferences: KeyChainReferences,
    ) {}

    private get tenants() {
        return this.repos.tenants;
    }
    private get clients() {
        return this.repos.clients;
    }
    private get keyChains() {
        return this.repos.keyChains;
    }
    private get registrarConfigs() {
        return this.repos.registrarConfigs;
    }
    private get issuanceConfigs() {
        return this.repos.issuanceConfigs;
    }
    private get credentialConfigs() {
        return this.repos.credentialConfigs;
    }
    private get presentationConfigs() {
        return this.repos.presentationConfigs;
    }
    private get attributeProviders() {
        return this.repos.attributeProviders;
    }
    private get webhookEndpoints() {
        return this.repos.webhookEndpoints;
    }

    private get federationTrustAnchors() {
        return this.repos.federationTrustAnchors;
    }
    private get trustLists() {
        return this.repos.trustLists;
    }
    private get statusLists() {
        return this.repos.statusLists;
    }

    async exportBundle(tenantId: string): Promise<ConfigBundle> {
        const tenant = await this.tenants.findOneByOrFail({ id: tenantId });
        const requirements: ConfigBundleRequirement[] = [];
        const warnings: ConfigMigrationIssue[] = [];
        const documents: ConfigDocument[] = [];

        await this.addDocument(
            documents,
            requirements,
            tenantId,
            "Tenant",
            "tenant",
            this.tenantSpec(tenant),
        );

        for (const client of await this.clients.find({ where: { tenantId } })) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "Client",
                client.clientId,
                this.clientSpec(client, requirements),
                false,
            );
        }

        const kmsConfig = this.kmsTenantConfigService.getTenantConfig(tenantId);
        if (kmsConfig) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "KmsConfig",
                "kms",
                kmsConfig as unknown as Record<string, unknown>,
            );
        }

        // The tenant's encryption key chain is system-owned, not configuration.
        for (const keyChain of await this.keyChains.find({
            where: { tenantId, usage: KeyUsage.Sign },
        })) {
            const spec = this.keyChainSpec(keyChain);
            if (!keyChain.externalKeyId) {
                requirements.push({
                    code: "PRIVATE_KEY_REQUIRED",
                    resource: { kind: "KeyChain", id: keyChain.id },
                    path: "/spec/keySource",
                    message:
                        "Safe export does not include database-held private keys. Supply the key material or regenerate explicitly.",
                });
            }
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "KeyChain",
                keyChain.id,
                spec,
                false,
            );
        }

        const defaultKeyChains = defaultKeyChainsOrNull(
            tenant.defaultKeyChains,
        );
        if (defaultKeyChains) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "KeyChainDefaults",
                "defaults",
                { ...defaultKeyChains },
            );
        }

        const registrar = await this.registrarConfigs.findOneBy({ tenantId });
        if (registrar) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "RegistrarConfig",
                "registrar",
                this.canonicalEntitySpec("RegistrarConfig", registrar),
            );
        }

        const issuance = await this.issuanceConfigs.findOneBy({ tenantId });
        if (issuance) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "IssuanceConfig",
                "issuance",
                this.canonicalEntitySpec("IssuanceConfig", issuance),
            );
        }

        await this.addEntities(
            documents,
            requirements,
            tenantId,
            "CredentialConfig",
            await this.credentialConfigs.find({ where: { tenantId } }),
        );
        await this.addEntities(
            documents,
            requirements,
            tenantId,
            "PresentationConfig",
            await this.presentationConfigs.find({ where: { tenantId } }),
        );
        await this.addEntities(
            documents,
            requirements,
            tenantId,
            "AttributeProvider",
            await this.attributeProviders.find({ where: { tenantId } }),
        );
        await this.addEntities(
            documents,
            requirements,
            tenantId,
            "WebhookEndpoint",
            await this.webhookEndpoints.find({ where: { tenantId } }),
        );
        await this.addEntities(
            documents,
            requirements,
            tenantId,
            "FederationTrustAnchor",
            await this.federationTrustAnchors.find({ where: { tenantId } }),
        );
        for (const trustList of await this.trustLists.find({
            where: { tenantId },
        })) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "TrustList",
                trustList.id,
                trustListConfig(trustList),
            );
        }

        for (const status of await this.statusLists.find({
            where: { tenantId },
        })) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "StatusList",
                status.id,
                this.statusListSpec(status),
            );
        }

        await this.rewriteAssetReferences(tenantId, documents);
        documents.sort((left, right) =>
            `${left.kind}/${resourceId(left)}`.localeCompare(
                `${right.kind}/${resourceId(right)}`,
            ),
        );
        const assets = await this.exportAssets(tenantId);
        const resources = documents.map((document) => {
            const definition = this.registry.get(document.kind);
            const serialized = JSON.stringify(serializeDocument(document));
            return {
                kind: document.kind,
                id: resourceId(document),
                $schema: schemaUrl(document.kind),
                path:
                    definition.bundlePath ??
                    `${definition.legacyFolders.at(-1)}/${resourceId(document)}.json`,
                sha256: sha256(serialized),
                ownership: document.metadata.ownership ?? "unmanaged",
                generation: document.metadata.generation ?? 1,
            };
        });

        return {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion:
                    this.configService.get("VERSION") ??
                    process.env.VERSION ??
                    "main",
                exportedAt: new Date().toISOString(),
                tenant: tenantId,
                resources,
                assets: assets.map(({ path, contentType, sha256 }) => ({
                    path,
                    contentType,
                    sha256,
                })),
                requirements,
                warnings,
            },
            documents: documents.map((document) => serializeDocument(document)),
            assets,
        };
    }

    /**
     * Exports one resource as a configuration document: the format of the
     * files in the config folder and of the documents in a bundle. Secrets
     * become placeholders like in the bundle export, but a key chain held in
     * the database keeps its private keys, like `GET /key-chain/{id}/export`,
     * so importing the document restores the same keys.
     */
    async exportDocument(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<ConfigFile> {
        const singletonId = CONFIG_SINGLETON_IDS[kind];
        const spec =
            singletonId && id !== singletonId
                ? undefined
                : await this.exportSpec(tenantId, kind, id);
        if (!spec) {
            throw new NotFoundException(`${kind} '${id}' not found`);
        }
        const documents: ConfigDocument[] = [];
        await this.addDocument(
            documents,
            [],
            tenantId,
            kind,
            id,
            spec,
            // A client names a placeholder for its secret; key chains keep their keys.
            kind !== "Client" && kind !== "KeyChain",
        );
        await this.rewriteAssetReferences(tenantId, documents);
        return serializeDocument(documents[0]);
    }

    private async exportSpec(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<Record<string, unknown> | undefined> {
        if (kind === "Client") {
            const client = await this.clients.findOneBy({
                tenantId,
                clientId: id,
            });
            return client ? this.clientSpec(client, []) : undefined;
        }
        // The tenant's encryption key chain is system-owned, not configuration.
        if (
            kind === "KeyChain" &&
            (await this.keyChains.countBy({
                tenantId,
                id,
                usage: KeyUsage.Sign,
            })) === 0
        ) {
            return undefined;
        }
        return this.storedSpec(tenantId, kind, id);
    }

    async plan(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        ownershipSource = `bundle:${bundle.manifest.tenant}`,
        options: ConfigPlanOptions = {},
    ): Promise<ConfigImportPlan> {
        try {
            this.assertBundle(bundle);
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : String(error),
            );
        }
        const revision = await this.configurationRevision(tenantId);
        const assets = await this.planAssets(tenantId, bundle, mode);
        const items: ConfigImportPlanItem[] = [];
        const issues: ConfigMigrationIssue[] = [];
        const upgradedDocuments: ConfigDocument[] = [];
        const systemOwnedKeyChains =
            await this.systemOwnedKeyChainIds(tenantId);
        const includesKmsConfig = bundle.documents.some(
            (file) =>
                this.migrationService.normalize(file).kind === "KmsConfig",
        );
        for (const file of bundle.documents) {
            const input = this.migrationService.normalize(file);
            const sourceVersion = input.$schema!;
            const result = this.migrationService.upgrade(input);
            upgradedDocuments.push(result.document);
            const exists = await this.exists(
                tenantId,
                result.document.kind,
                resourceId(result.document),
            );
            const metadata = await this.ownershipService.get(
                tenantId,
                result.document.kind,
                resourceId(result.document),
            );
            const reference = {
                kind: result.document.kind,
                id: resourceId(result.document),
            };
            // Key chains EUDIPLO manages itself, such as the tenant's
            // encryption key chain, are not configuration. Exports of earlier
            // versions contain the encryption key chain; skip it instead of
            // asking for its private key.
            const skipReserved =
                exists &&
                reference.kind === "KeyChain" &&
                systemOwnedKeyChains.has(reference.id);
            const itemIssues = [...result.issues];
            itemIssues.push(
                ...this.documentValidationService.validate(result.document),
            );
            if (skipReserved) {
                itemIssues.push({
                    severity: "warning",
                    code: "KEY_CHAIN_ID_RESERVED",
                    path: "/spec/id",
                    message:
                        "This ID belongs to a key chain that EUDIPLO manages itself, such as the tenant's encryption key chain. It is skipped.",
                    resource: reference,
                });
            } else {
                this.collectUnresolvedRequirements(result.document, itemIssues);
            }
            // A startup folder import must not fail the whole tenant because
            // one resource diverged; it skips that resource and says how to recover.
            const startupFolder = ownershipSource.startsWith("folder:");
            let skipDiverged = false;
            if (
                exists &&
                !skipReserved &&
                !options.reattach &&
                metadata.ownership === "detached" &&
                sourceInScope(metadata.source, ownershipSource)
            ) {
                skipDiverged = true;
                itemIssues.push({
                    severity: "warning",
                    code: "RESOURCE_DETACHED",
                    path: "/metadata",
                    message:
                        "Resource was detached from this source and is skipped. Reattach it to apply the file version.",
                    resource: reference,
                });
            } else if (
                exists &&
                !skipReserved &&
                !options.reattach &&
                (result.document.metadata.generation ?? 1) < metadata.generation
            ) {
                skipDiverged = startupFolder;
                itemIssues.push({
                    severity: startupFolder ? "warning" : "error",
                    code: "STALE_GENERATION",
                    path: "/metadata/generation",
                    message: `Generation ${result.document.metadata.generation ?? 1} is older than stored generation ${metadata.generation}.${
                        startupFolder
                            ? " The resource was changed through the API or UI and is skipped. Reattach it to apply the file version, or raise metadata.generation in the file."
                            : ""
                    }`,
                    resource: reference,
                });
            }
            if (
                exists &&
                mode !== "create" &&
                result.document.kind === "StatusList"
            ) {
                const current = await this.statusLists.findOneByOrFail({
                    tenantId,
                    id: resourceId(result.document),
                });
                const spec = result.document.spec;
                for (const [field, value] of [
                    ["capacity", current.elements.length],
                    ["bits", current.bits],
                ] as const) {
                    if (spec[field] !== undefined && spec[field] !== value)
                        itemIssues.push({
                            severity: "error",
                            code: "STATUS_LIST_LAYOUT_IMMUTABLE",
                            path: `/spec/${field}`,
                            message:
                                "Create a new status list ID to change capacity or bits; existing status data must be preserved.",
                            resource: {
                                kind: "StatusList",
                                id: resourceId(result.document),
                            },
                        });
                }
            }
            if (
                !exists &&
                result.document.kind === "Client" &&
                (await this.clients.countBy({
                    clientId: resourceId(result.document),
                })) > 0
            ) {
                itemIssues.push({
                    severity: "error",
                    code: "CLIENT_ID_TAKEN",
                    path: "/spec/clientId",
                    message:
                        "Client IDs are unique across tenants, and another tenant or the root client already uses this one.",
                    resource: {
                        kind: "Client",
                        id: resourceId(result.document),
                    },
                });
            }
            const skipExisting =
                exists && mode === "create" && !skipDiverged && !skipReserved;
            if (skipExisting) {
                itemIssues.push({
                    severity: "warning",
                    code: "RESOURCE_EXISTS",
                    path: "/metadata/id",
                    message:
                        "Resource already exists and will be skipped in create mode.",
                    resource: {
                        kind: result.document.kind,
                        id: resourceId(result.document),
                    },
                });
            }
            const blocked = itemIssues.some(
                (issue) =>
                    issue.severity === "error" ||
                    issue.severity === "required-input",
            );
            let comparison:
                | { unchanged: boolean; changes: ConfigChange[] }
                | undefined;
            if (
                exists &&
                mode !== "create" &&
                !blocked &&
                !skipDiverged &&
                !skipReserved
            ) {
                // Reattach restores the folder version, so it always compares.
                comparison =
                    !options.reattach &&
                    this.skipsComparison(
                        result.document,
                        metadata,
                        ownershipSource,
                    )
                        ? { unchanged: true, changes: [] }
                        : await this.compareDocument(tenantId, result.document);
            }
            const metadataChanged =
                metadata.ownership !== "file-managed" ||
                metadata.source !== ownershipSource ||
                metadata.generation !==
                    (result.document.metadata.generation ?? 1);
            let action = planAction({
                blocked,
                skip: skipExisting || skipDiverged || skipReserved,
                unchanged: comparison?.unchanged ?? false,
                exists,
            });
            // Only a document apply writes is checked, as saving checks it.
            if (action === "create" || action === "update") {
                const certificateIssues =
                    this.documentValidationService.validateRegistrationCertificate(
                        result.document,
                        tenantId,
                    );
                if (certificateIssues.length > 0) {
                    itemIssues.push(...certificateIssues);
                    action = "blocked";
                }
                const algorithmIssue = this.keyChainAlgorithmIssue(
                    tenantId,
                    result.document,
                    includesKmsConfig,
                );
                if (algorithmIssue) {
                    itemIssues.push(algorithmIssue);
                    if (algorithmIssue.severity !== "warning")
                        action = "blocked";
                }
            }
            items.push({
                changes: comparison?.changes,
                metadataChanged,
                kind: result.document.kind,
                id: resourceId(result.document),
                action,
                sourceVersion,
                targetVersion: result.document.$schema!,
                migrations: result.migrations,
                issues: itemIssues,
            });
            issues.push(...itemIssues);
        }
        const referenceIssues = await this.validateReferences(
            tenantId,
            upgradedDocuments,
            mode,
            ownershipSource,
        );
        for (const issue of referenceIssues) {
            const item = issue.resource
                ? items.find(
                      (candidate) =>
                          candidate.kind === issue.resource?.kind &&
                          candidate.id === issue.resource.id,
                  )
                : undefined;
            item?.issues.push(issue);
            if (item && issue.severity !== "warning") item.action = "blocked";
            issues.push(issue);
        }
        if (mode === "replace") {
            const included = new Set(
                upgradedDocuments.map(
                    (document) => `${document.kind}/${resourceId(document)}`,
                ),
            );
            const managed =
                await this.ownershipService.listManagedBySourceScope(
                    tenantId,
                    ownershipSource,
                );
            for (const metadata of managed) {
                if (
                    metadata.kind === "Tenant" ||
                    included.has(`${metadata.kind}/${metadata.resourceId}`) ||
                    (metadata.kind === "KeyChain" &&
                        systemOwnedKeyChains.has(metadata.resourceId))
                ) {
                    continue;
                }
                items.push({
                    kind: metadata.kind,
                    id: metadata.resourceId,
                    action: "delete",
                    sourceVersion: "stored",
                    targetVersion: "deleted",
                    migrations: [],
                    issues: [],
                });
            }
            issues.push(
                ...(await this.blockDeletingTrustListsInUse(
                    tenantId,
                    upgradedDocuments,
                    items,
                )),
                // After the trust lists: a trust list whose delete is blocked
                // stays, so it keeps blocking the delete of its key chains.
                ...(await this.blockDeletingKeyChainsInUse(
                    tenantId,
                    upgradedDocuments,
                    items,
                )),
            );
        }
        const trustAnchors = await this.trustAnchorEntityIdsAfter(
            tenantId,
            upgradedDocuments,
            items,
        );
        issues.push(
            ...(await this.blockUnregisteredTrustAnchors(
                tenantId,
                upgradedDocuments,
                items,
                trustAnchors.registered,
            )),
            ...(await this.blockChangingTrustAnchorsInUse(
                tenantId,
                upgradedDocuments,
                items,
                trustAnchors,
            )),
        );
        if (revision !== (await this.configurationRevision(tenantId)))
            throw new ConflictException(
                "Configuration changed while planning; request a new plan",
            );
        return {
            tenantId,
            mode,
            assets,
            planFingerprint: sha256(
                stableConfigJson({
                    tenantId,
                    mode,
                    ownershipSource,
                    ...(options.reattach ? { reattach: true } : {}),
                    bundle,
                    revision,
                    assets,
                    items,
                }),
            ),
            applicable: !issues.some(
                (issue) =>
                    issue.severity === "error" ||
                    issue.severity === "required-input",
            ),
            items,
            issues,
        };
    }

    /**
     * The configurations of the kinds `isKind` accepts that the plan writes,
     * with their new content, or deletes. A skipped document leaves the
     * stored configuration in place, so it is neither.
     */
    private plannedChange<Kind extends string>(
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
        isKind: (kind: string) => kind is Kind,
        referenceId: (kind: Kind, id: string) => string | undefined,
    ): {
        written: Array<{ kind: Kind; id?: string; content: unknown }>;
        removed: Array<{ kind: Kind; id?: string }>;
    } {
        const actions = new Map(
            items.map((item) => [`${item.kind}/${item.id}`, item.action]),
        );
        const change: ReturnType<typeof this.plannedChange<Kind>> = {
            written: [],
            removed: [],
        };
        for (const document of documents) {
            const { kind, spec } = document;
            const id = resourceId(document);
            if (!isKind(kind) || actions.get(`${kind}/${id}`) === "skip")
                continue;
            change.written.push({
                kind,
                id: referenceId(kind, id),
                content: spec,
            });
        }
        for (const item of items) {
            if (item.action === "delete" && isKind(item.kind))
                change.removed.push({
                    kind: item.kind,
                    id: referenceId(item.kind, item.id),
                });
        }
        return change;
    }

    /** Marks a planned delete as blocked by `issue`. */
    private block(
        item: ConfigImportPlanItem,
        issue: ConfigMigrationIssue,
    ): ConfigMigrationIssue {
        item.issues.push(issue);
        item.action = "blocked";
        return issue;
    }

    /**
     * Blocks deleting a trust list that a configuration surviving the import
     * still references: a stored configuration the plan neither deletes nor
     * rewrites, or a document of the bundle with its new content.
     */
    private async blockDeletingTrustListsInUse(
        tenantId: string,
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
    ): Promise<ConfigMigrationIssue[]> {
        const deletedLists = items.filter(
            (item) => item.action === "delete" && item.kind === "TrustList",
        );
        if (deletedLists.length === 0) return [];
        const change: ConfigurationChange = this.plannedChange(
            documents,
            items,
            isTrustListReferenceKind,
            trustListReferenceId,
        );
        const issues: ConfigMigrationIssue[] = [];
        for (const item of deletedLists) {
            const references = await this.trustListReferences.findAfter(
                { tenantId, id: item.id },
                change,
            );
            if (references.length === 0) continue;
            issues.push(
                this.block(item, {
                    severity: "error",
                    code: "TRUST_LIST_IN_USE",
                    path: "/metadata/id",
                    message: `Trust list ${JSON.stringify(item.id)} is left out of this import, so replace mode deletes it, but it is still referenced by ${describeTrustListReferences(references)}. Keep the trust list in the bundle or folder, or remove these references.`,
                    resource: { kind: "TrustList", id: item.id },
                }),
            );
        }
        return issues;
    }

    /**
     * Blocks deleting a key chain that a configuration surviving the import
     * still names: a stored configuration the plan neither deletes nor
     * rewrites, or a document of the bundle with its new content. A
     * configuration that names no key chain uses the tenant's default one
     * and does not count.
     */
    private async blockDeletingKeyChainsInUse(
        tenantId: string,
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
    ): Promise<ConfigMigrationIssue[]> {
        const deletedKeyChains = items.filter(
            (item) => item.action === "delete" && item.kind === "KeyChain",
        );
        if (deletedKeyChains.length === 0) return [];
        const change: KeyChainConfigurationChange = this.plannedChange(
            documents,
            items,
            isKeyChainReferenceKind,
            keyChainReferenceId,
        );
        // A stored trust list rewritten without keyChainId keeps its signing
        // key chain (and is deleted with it), so its document counts with it.
        for (const written of change.written) {
            const spec = written.content as { keyChainId?: unknown } | null;
            if (written.kind !== "TrustList" || !written.id || spec?.keyChainId)
                continue;
            const stored = await this.repos.trustLists.findOne({
                where: { tenantId, id: written.id },
                select: { id: true, keyChainId: true },
            });
            if (stored?.keyChainId)
                written.content = { ...spec, keyChainId: stored.keyChainId };
        }
        const issues: ConfigMigrationIssue[] = [];
        for (const item of deletedKeyChains) {
            const references = await this.keyChainReferences.findAfter(
                { tenantId, id: item.id },
                change,
            );
            if (references.length === 0) continue;
            issues.push(
                this.block(item, {
                    severity: "error",
                    code: "KEY_CHAIN_IN_USE",
                    path: "/spec/id",
                    message: `Key chain ${JSON.stringify(item.id)} is left out of this import, so replace mode deletes it, but it is still used by ${describeKeyChainReferences(references)}. Keep the key chain in the bundle or folder, or remove these references.`,
                    resource: { kind: "KeyChain", id: item.id },
                }),
            );
        }
        return issues;
    }

    /**
     * The federation trust anchor entity IDs of the tenant before the plan
     * (by anchor ID) and once it is applied; a skipped document leaves the
     * stored anchor in place.
     */
    private async trustAnchorEntityIdsAfter(
        tenantId: string,
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
    ): Promise<{ stored: Map<string, string>; registered: Set<string> }> {
        const actions = planActions(items);
        const stored = new Map(
            (
                await this.federationTrustAnchors.find({
                    where: { tenantId },
                    select: { id: true, entityId: true },
                })
            ).map((anchor) => [anchor.id, anchor.entityId]),
        );
        const after = new Map(stored);
        for (const document of documents) {
            const entityId = (document.spec as { entityId?: unknown } | null)
                ?.entityId;
            if (
                document.kind === "FederationTrustAnchor" &&
                typeof entityId === "string" &&
                actions.get(`${document.kind}/${resourceId(document)}`)
                    ?.action !== "skip"
            )
                after.set(resourceId(document), entityId);
        }
        for (const item of items) {
            if (
                item.action === "delete" &&
                item.kind === "FederationTrustAnchor"
            )
                after.delete(item.id);
        }
        return { stored, registered: new Set(after.values()) };
    }

    /**
     * Blocks a document that apply would refuse because it names a federation
     * trust anchor entity ID that neither the tenant nor the bundle registers
     * (MISSING_RESOURCE_REFERENCE), so apply does not stop partway.
     */
    private async blockUnregisteredTrustAnchors(
        tenantId: string,
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
        registered: Set<string>,
    ): Promise<ConfigMigrationIssue[]> {
        const actions = planActions(items);
        const issues: ConfigMigrationIssue[] = [];
        // As apply stores them: the issuance configuration is refused only
        // for entity IDs it adds to the stored one, a presentation config
        // (stored whole) for every entity ID it names.
        const storedIssuance = await this.issuanceConfigs.findOne({
            where: { tenantId },
            select: { tenantId: true, federation: true },
        });
        const storedIssuanceIds = new Set(
            this.federationTrustAnchorReferences.trustAnchorIds(
                "IssuanceConfig",
                storedIssuance,
            ),
        );
        for (const document of documents) {
            const { kind } = document;
            const item = actions.get(`${kind}/${resourceId(document)}`);
            const action = item?.action;
            if (
                !isFederationTrustAnchorReferenceKind(kind) ||
                (action !== "create" && action !== "update")
            )
                continue;
            const missing = new Set(
                this.federationTrustAnchorReferences
                    .trustAnchorIds(kind, document.spec)
                    .filter(
                        (entityId) =>
                            !registered.has(entityId) &&
                            !(
                                kind === "IssuanceConfig" &&
                                storedIssuanceIds.has(entityId)
                            ),
                    ),
            );
            for (const entityId of missing) {
                block(item, issues, {
                    severity: "error",
                    code: "MISSING_RESOURCE_REFERENCE",
                    path:
                        kind === "IssuanceConfig"
                            ? "/spec/federation/trustAnchors"
                            : "/spec/dcql_query/credentials",
                    message: `No FederationTrustAnchor with entity ID '${entityId}' exists in the target instance or bundle; a trust anchor without pinned keys is never trusted. Add it to federation-trust-anchors/ with its federation keys.`,
                    resource: { kind, id: resourceId(document) },
                });
            }
        }
        return issues;
    }

    /**
     * Blocks deleting a federation trust anchor, or giving it another entity
     * ID, while a configuration surviving the import still names the old
     * entity ID (FEDERATION_TRUST_ANCHOR_IN_USE): a stored configuration the
     * plan neither deletes nor rewrites, or a document of the bundle with its
     * new content.
     */
    private async blockChangingTrustAnchorsInUse(
        tenantId: string,
        documents: ConfigDocument[],
        items: ConfigImportPlanItem[],
        {
            stored,
            registered,
        }: { stored: Map<string, string>; registered: Set<string> },
    ): Promise<ConfigMigrationIssue[]> {
        const lost = [...stored].filter(
            ([, entityId]) => !registered.has(entityId),
        );
        if (lost.length === 0) return [];
        const actions = planActions(items);
        const issues: ConfigMigrationIssue[] = [];
        const change: FederationTrustAnchorConfigurationChange = {
            written: [],
            removed: [],
        };
        for (const document of documents) {
            const { kind, spec } = document;
            if (
                !isFederationTrustAnchorReferenceKind(kind) ||
                actions.get(`${kind}/${resourceId(document)}`)?.action ===
                    "skip"
            )
                continue;
            change.written.push({
                kind,
                id: federationTrustAnchorReferenceId(
                    kind,
                    resourceId(document),
                ),
                content: spec,
            });
        }
        for (const item of items) {
            if (
                item.action === "delete" &&
                isFederationTrustAnchorReferenceKind(item.kind)
            )
                change.removed.push({
                    kind: item.kind,
                    id: federationTrustAnchorReferenceId(item.kind, item.id),
                });
        }
        for (const [id, entityId] of lost) {
            const references =
                await this.federationTrustAnchorReferences.findAfter(
                    tenantId,
                    entityId,
                    change,
                );
            if (references.length === 0) continue;
            const item = actions.get(`FederationTrustAnchor/${id}`);
            const deleted = item?.action === "delete";
            block(item, issues, {
                severity: "error",
                code: "FEDERATION_TRUST_ANCHOR_IN_USE",
                path: deleted ? "/metadata/id" : "/spec/entityId",
                message: `${
                    deleted
                        ? `Federation trust anchor ${JSON.stringify(id)} is left out of this import, so replace mode deletes it`
                        : `This import changes the entity ID of federation trust anchor ${JSON.stringify(id)}`
                }, but ${entityId} is still named by ${describeFederationTrustAnchorReferences(references)}. Keep the trust anchor in the bundle or folder, or remove these references.`,
                resource: { kind: "FederationTrustAnchor", id },
            });
        }
        return issues;
    }

    /**
     * IDs of the key chains EUDIPLO manages itself, such as the tenant's
     * encryption key chain. Imports neither change nor delete them.
     */
    private async systemOwnedKeyChainIds(
        tenantId: string,
    ): Promise<Set<string>> {
        const keyChains = await this.keyChains.find({
            where: { tenantId, usage: Not(KeyUsage.Sign) },
            select: { id: true },
        });
        return new Set(keyChains.map((keyChain) => keyChain.id));
    }

    /** Hash configuration only; live status values and allocation stacks are not configuration. */
    private async configurationRevision(tenantId: string): Promise<string> {
        const repositories: Repository<any>[] = [
            this.clients,
            this.keyChains,
            this.registrarConfigs,
            this.issuanceConfigs,
            this.credentialConfigs,
            this.presentationConfigs,
            this.attributeProviders,
            this.webhookEndpoints,
            this.trustLists,
            this.federationTrustAnchors,
        ];
        const rows = await Promise.all(
            repositories.map((repository) =>
                repository.find({ where: { tenantId } }),
            ),
        );
        const lists = await this.statusLists.find({ where: { tenantId } });
        const state = {
            tenant: await this.tenants.findOneBy({ id: tenantId }),
            resources: rows.map((entries) =>
                entries
                    .map((entry) =>
                        canonicalize(entry, REVISION_OMITTED_FIELDS),
                    )
                    .sort((a, b) =>
                        stableConfigJson(a).localeCompare(stableConfigJson(b)),
                    ),
            ),
            statusLists: lists
                .map((entry) => ({
                    id: entry.id,
                    keyChainId: entry.keyChainId,
                    credentialConfigurationId: entry.credentialConfigurationId,
                    bits: entry.bits,
                    capacity: entry.elements.length,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            ownership: await this.ownershipService.list(tenantId),
            kms: this.kmsTenantConfigService.getTenantConfig(tenantId),
        };
        return sha256(
            stableConfigJson(canonicalize(state, REVISION_OMITTED_FIELDS)),
        );
    }

    private async planAssets(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
    ): Promise<NonNullable<ConfigImportPlan["assets"]>> {
        const result: NonNullable<ConfigImportPlan["assets"]> = [];
        for (const asset of bundle.assets) {
            const file = await this.files.findOneBy({
                tenantId,
                filename: asset.path.replace(/^images\//, ""),
            });
            let currentHash: string | undefined;
            let currentContentType: string | undefined;
            if (file) {
                const stored = await this.filesService.getStream(file.id);
                currentContentType = stored.contentType;
                const hash = createHash("sha256");
                for await (const chunk of stored.stream) hash.update(chunk);
                currentHash = hash.digest("hex");
            }
            result.push({
                path: asset.path,
                sha256: asset.sha256,
                currentHash,
                currentContentType,
                action: !file
                    ? "create"
                    : currentHash === asset.sha256 &&
                        (!asset.contentType ||
                            asset.contentType === currentContentType)
                      ? "unchanged"
                      : mode === "create"
                        ? "skip"
                        : "update",
            });
        }
        return result;
    }

    /**
     * Each entry of the key chain defaults must name a key chain of the
     * tenant or the bundle with the entry's usage type, else every request
     * that falls back to it fails after the import.
     */
    private async checkDefaultKeyChains(
        tenantId: string,
        documents: ConfigDocument[],
        availableKeyChains: Set<string> | undefined,
    ): Promise<ConfigMigrationIssue[]> {
        const defaults = documents.find(
            (document) => document.kind === "KeyChainDefaults",
        );
        if (!defaults) return [];
        const defaultKeyChains = defaults.spec as unknown;
        if (!defaultKeyChains || typeof defaultKeyChains !== "object")
            return [];
        const issues: ConfigMigrationIssue[] = [];
        // Only the known entries: schema validation reports other keys, and
        // each entry costs a lookup.
        for (const entry of DEFAULT_KEY_CHAIN_ENTRIES) {
            const keyChainId = (defaultKeyChains as Record<string, unknown>)[
                entry
            ];
            if (typeof keyChainId !== "string") continue;
            const path = `/spec/${entry}`;
            const resource = {
                kind: "KeyChainDefaults" as const,
                id: resourceId(defaults),
            };
            if (!availableKeyChains?.has(keyChainId)) {
                issues.push({
                    severity: "error",
                    code: "MISSING_RESOURCE_REFERENCE",
                    path,
                    message: `KeyChain '${keyChainId}' does not exist in the target instance or bundle.`,
                    resource,
                });
                continue;
            }
            const refusal = defaultKeyChainUsageRefusal(
                entry,
                keyChainId,
                await this.keyChainUsageType(tenantId, documents, keyChainId),
            );
            if (refusal) {
                issues.push({
                    severity: "error",
                    code: "KEY_CHAIN_USAGE_MISMATCH",
                    path,
                    message: refusal,
                    resource,
                });
            }
        }
        return issues;
    }

    /**
     * The `token.signingKeyId` of each authorization server must name a key
     * chain with usage type `accessToken`, else its token requests fail
     * after the import. A missing key chain is reported as a missing
     * reference. Like the API, the plan does not refuse a value the stored
     * configuration already has, so an unchanged folder from before the
     * check does not block the tenant's import; it warns instead, as that
     * authorization server's token requests fail.
     */
    private async checkAccessTokenSigningKeys(
        tenantId: string,
        documents: ConfigDocument[],
        availableKeyChains: Set<string> | undefined,
    ): Promise<ConfigMigrationIssue[]> {
        const issues: ConfigMigrationIssue[] = [];
        for (const document of documents) {
            if (document.kind !== "IssuanceConfig") continue;
            const servers = (document.spec as Record<string, unknown>)
                ?.authorizationServers;
            if (!Array.isArray(servers)) continue;
            const stored = new Map(
                (
                    ((await this.issuanceConfigs.findOne({
                        where: { tenantId },
                        select: { tenantId: true, authorizationServers: true },
                    })) ?? { authorizationServers: [] }) as {
                        authorizationServers?: Array<{
                            id?: string;
                            token?: { signingKeyId?: string };
                        }>;
                    }
                ).authorizationServers?.map((server) => [
                    server?.id,
                    server?.token?.signingKeyId,
                ]) ?? [],
            );
            for (const [index, server] of servers.entries()) {
                const keyChainId = server?.token?.signingKeyId;
                if (
                    typeof keyChainId !== "string" ||
                    !availableKeyChains?.has(keyChainId)
                )
                    continue;
                const refusal = accessTokenKeyChainUsageRefusal(
                    keyChainId,
                    await this.keyChainUsageType(
                        tenantId,
                        documents,
                        keyChainId,
                    ),
                );
                if (refusal) {
                    // A stored value does not block the import, but its
                    // token requests fail until it is changed.
                    const unchanged = stored.get(server?.id) === keyChainId;
                    issues.push({
                        severity: unchanged ? "warning" : "error",
                        code: "KEY_CHAIN_USAGE_MISMATCH",
                        path: `/spec/authorizationServers/${index}/token/signingKeyId`,
                        message: refusal,
                        resource: {
                            kind: document.kind,
                            id: resourceId(document),
                        },
                    });
                }
            }
        }
        return issues;
    }

    /** Usage type of a key chain of the bundle, else of the tenant. */
    private async keyChainUsageType(
        tenantId: string,
        documents: ConfigDocument[],
        keyChainId: string,
    ): Promise<unknown> {
        const bundled = documents.find(
            (document) =>
                document.kind === "KeyChain" &&
                resourceId(document) === keyChainId,
        );
        if (bundled) return (bundled.spec as { usageType?: unknown }).usageType;
        return (
            await this.keyChains.findOne({
                where: { tenantId, id: keyChainId },
                select: { id: true, usageType: true },
            })
        )?.usageType;
    }

    private async validateReferences(
        tenantId: string,
        documents: ConfigDocument[],
        mode: ConfigImportMode,
        ownershipSource: string,
    ): Promise<ConfigMigrationIssue[]> {
        const available = new Map<ConfigResourceKind, Set<string>>();
        const load = (kind: ConfigResourceKind, ids: string[]) =>
            available.set(kind, new Set(ids));
        load(
            "KeyChain",
            (
                await this.keyChains.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        load(
            "CredentialConfig",
            (
                await this.credentialConfigs.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        load(
            "PresentationConfig",
            (
                await this.presentationConfigs.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        load(
            "WebhookEndpoint",
            (
                await this.webhookEndpoints.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        load(
            "AttributeProvider",
            (
                await this.attributeProviders.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        load(
            "TrustList",
            (
                await this.trustLists.find({
                    where: { tenantId },
                    select: { id: true },
                })
            ).map((item) => item.id),
        );
        for (const document of documents) {
            available.get(document.kind)?.add(resourceId(document));
        }
        if (mode === "replace") {
            const included = new Set(
                documents.map(
                    (document) => `${document.kind}/${resourceId(document)}`,
                ),
            );
            const managed =
                await this.ownershipService.listManagedBySourceScope(
                    tenantId,
                    ownershipSource,
                );
            for (const metadata of managed) {
                if (!included.has(`${metadata.kind}/${metadata.resourceId}`)) {
                    available.get(metadata.kind)?.delete(metadata.resourceId);
                }
            }
        }

        const referenceFields: Record<string, ConfigResourceKind> = {
            keychainid: "KeyChain",
            signingkeyid: "KeyChain",
            credentialconfigid: "CredentialConfig",
            credentialconfigurationid: "CredentialConfig",
            presentationconfigid: "PresentationConfig",
            webhookendpointid: "WebhookEndpoint",
            attributeproviderid: "AttributeProvider",
            trustlistid: "TrustList",
        };
        const arrayReferenceFields: Record<string, ConfigResourceKind> = {
            allowedpresentationconfigs: "PresentationConfig",
            allowedissuanceconfigs: "CredentialConfig",
        };
        const issues: ConfigMigrationIssue[] = [];
        const visit = (
            document: ConfigDocument,
            value: unknown,
            path: string,
        ): void => {
            if (Array.isArray(value)) {
                value.forEach((item, index) =>
                    visit(document, item, `${path}/${index}`),
                );
                return;
            }
            if (!value || typeof value !== "object") return;
            for (const [key, item] of Object.entries(
                value as Record<string, unknown>,
            )) {
                const normalizedKey = key.toLowerCase();
                const target = normalizedKey.endsWith("keychainid")
                    ? "KeyChain"
                    : referenceFields[normalizedKey];
                if (
                    target &&
                    typeof item === "string" &&
                    item.length > 0 &&
                    !available.get(target)?.has(item)
                ) {
                    issues.push({
                        severity: "error",
                        code: "MISSING_RESOURCE_REFERENCE",
                        path: `${path}/${key}`,
                        message: `${target} '${item}' does not exist in the target instance or bundle.`,
                        resource: {
                            kind: document.kind,
                            id: resourceId(document),
                        },
                    });
                }
                const arrayTarget = arrayReferenceFields[normalizedKey];
                if (arrayTarget && Array.isArray(item)) {
                    for (const [index, reference] of item.entries()) {
                        if (
                            typeof reference === "string" &&
                            reference.length > 0 &&
                            !available.get(arrayTarget)?.has(reference)
                        ) {
                            issues.push({
                                severity: "error",
                                code: "MISSING_RESOURCE_REFERENCE",
                                path: `${path}/${key}/${index}`,
                                message: `${arrayTarget} '${reference}' does not exist in the target instance or bundle.`,
                                resource: {
                                    kind: document.kind,
                                    id: resourceId(document),
                                },
                            });
                        }
                    }
                }
                visit(document, item, `${path}/${key}`);
            }
        };
        for (const document of documents)
            visit(document, document.spec, "/spec");
        issues.push(
            ...(await this.checkDefaultKeyChains(
                tenantId,
                documents,
                available.get("KeyChain"),
            )),
            ...(await this.checkAccessTokenSigningKeys(
                tenantId,
                documents,
                available.get("KeyChain"),
            )),
        );

        const includesKmsConfig = documents.some(
            (document) => document.kind === "KmsConfig",
        );
        for (const document of documents.filter(
            (candidate) => candidate.kind === "KeyChain",
        )) {
            const source = (document.spec as any).keySource;
            if (source?.type !== "external-reference") continue;
            try {
                await this.kmsReferenceService.verify(tenantId, source);
            } catch (error) {
                issues.push({
                    severity: includesKmsConfig ? "warning" : "error",
                    code: includesKmsConfig
                        ? "KMS_PREFLIGHT_DEFERRED"
                        : "KMS_REFERENCE_UNAVAILABLE",
                    path: "/spec/keySource",
                    message: includesKmsConfig
                        ? "The bundle changes KMS configuration, so this external key can only be verified after that configuration is applied."
                        : `The external KMS key could not sign a preflight challenge: ${error instanceof Error ? error.message : String(error)}`,
                    resource: {
                        kind: document.kind,
                        id: resourceId(document),
                    },
                });
            }
        }
        return issues;
    }

    /**
     * An issue when the KMS provider of a key chain document does not offer
     * the algorithm of one of its keys, checked against the configuration in
     * place; only a warning when the bundle also changes KMS configuration.
     */
    private keyChainAlgorithmIssue(
        tenantId: string,
        document: ConfigDocument,
        includesKmsConfig: boolean,
    ): ConfigMigrationIssue | undefined {
        if (document.kind !== "KeyChain") return undefined;
        const unsupported = this.kmsReferenceService.unsupportedAlgorithm(
            tenantId,
            document.spec,
        );
        if (!unsupported) return undefined;
        return {
            severity: includesKmsConfig ? "warning" : "error",
            code: includesKmsConfig
                ? "KMS_PREFLIGHT_DEFERRED"
                : "UNSUPPORTED_KEY_ALGORITHM",
            path: unsupported.path,
            message: includesKmsConfig
                ? `The bundle changes KMS configuration, so whether its KMS provider offers this key's algorithm can only be checked after that configuration is applied: ${unsupported.message}`
                : unsupported.message,
            resource: { kind: document.kind, id: resourceId(document) },
        };
    }

    private async addEntities(
        documents: ConfigDocument[],
        requirements: ConfigBundleRequirement[],
        tenantId: string,
        kind: ConfigResourceKind,
        entities: Array<Record<string, any>>,
    ): Promise<void> {
        for (const entity of entities) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                kind,
                String(entity.id),
                this.canonicalEntitySpec(kind, entity),
            );
        }
    }

    /**
     * Map persistence entities to the public desired-state schema explicitly.
     * This prevents later runtime/cache columns from silently entering exports.
     */
    private canonicalEntitySpec(
        kind: ConfigResourceKind,
        entity: Record<string, any>,
    ): Record<string, unknown> {
        switch (kind) {
            case "RegistrarConfig":
                return {
                    registrarUrl: entity.registrarUrl,
                    oidcUrl: entity.oidcUrl,
                    clientId: entity.clientId,
                    // Unset columns are null; the schema has them optional.
                    clientSecret: entity.clientSecret ?? undefined,
                    username: entity.username,
                    password: entity.password,
                    registrationCertificateDefaults:
                        entity.registrationCertificateDefaults ?? undefined,
                    relyingPartyContact:
                        entity.relyingPartyContact ?? undefined,
                };
            case "IssuanceConfig":
                return {
                    batchSize: entity.batchSize,
                    dPopRequired: entity.dPopRequired,
                    walletAttestationRequired: entity.walletAttestationRequired,
                    walletProviderTrustLists:
                        entity.walletProviderTrustLists ?? undefined,
                    // The schema accepts null, and applying null clears it.
                    walletAttestationStatusCheckMode:
                        entity.walletAttestationStatusCheckMode,
                    // Removed authorization server options are not exported.
                    authorizationServers: Array.isArray(
                        entity.authorizationServers,
                    )
                        ? withoutRemovedChainedVp(entity.authorizationServers)
                              .servers
                        : entity.authorizationServers,
                    // The schema accepts null for these, and applying null clears them.
                    federation: entity.federation,
                    registrationCertificate: entity.registrationCertificate,
                    // An unset display column is null; the schema has it optional.
                    display: entity.display ?? undefined,
                    notificationEndpointEnabled:
                        entity.notificationEndpointEnabled,
                    credentialResponseEncryption:
                        entity.credentialResponseEncryption,
                    credentialRequestEncryption:
                        entity.credentialRequestEncryption,
                    txCodeMaxAttempts: entity.txCodeMaxAttempts,
                    offerLifetimeSeconds:
                        entity.offerLifetimeSeconds ?? undefined,
                };
            case "CredentialConfig":
                return {
                    id: entity.id,
                    description: entity.description,
                    config: entity.config,
                    // Stored before CredentialConfig v3, constraints may carry
                    // keys that v3 refuses; the export leaves them out
                    fields: sanitizeClaimFields(entity.fields ?? []).fields,
                    attributeProviderId: entity.attributeProviderId,
                    webhookEndpointId: entity.webhookEndpointId,
                    vct: entity.vct,
                    keyBinding: entity.keyBinding,
                    keyChainId: entity.keyChainId ?? undefined,
                    statusManagement: entity.statusManagement,
                    iaeActions: entity.iaeActions,
                    sdJwtTrustFormat: entity.sdJwtTrustFormat,
                    lifeTime: entity.lifeTime ?? undefined,
                    schemaMeta: entity.schemaMeta,
                    embeddedDisclosurePolicy: entity.embeddedDisclosurePolicy,
                };
            case "PresentationConfig":
                return {
                    id: entity.id,
                    description: entity.description,
                    lifeTime: entity.lifeTime ?? undefined,
                    skewSeconds: entity.skewSeconds,
                    statusCheckMode: entity.statusCheckMode,
                    dcql_query: entity.dcql_query,
                    transaction_data: entity.transaction_data,
                    registration_cert: entity.registration_cert,
                    webhookEndpointId: entity.webhookEndpointId,
                    attached: entity.attached,
                    redirectUri: entity.redirectUri,
                    accessKeyChainId: entity.accessKeyChainId,
                    readerAuth: entity.readerAuth,
                };
            case "AttributeProvider":
            case "WebhookEndpoint":
                return {
                    id: entity.id,
                    name: entity.name,
                    description: entity.description,
                    url: entity.url,
                    auth: entity.auth,
                };
            case "FederationTrustAnchor":
                return {
                    id: entity.id,
                    entityId: entity.entityId,
                    description: entity.description ?? undefined,
                    jwks: entity.jwks,
                };
            default:
                throw new Error(
                    `No entity export mapper registered for ${kind}`,
                );
        }
    }

    private tenantSpec(tenant: Record<string, any>): Record<string, unknown> {
        return {
            name: tenant.name,
            description: tenant.description ?? undefined,
            sessionConfig: tenant.sessionConfig ?? undefined,
            statusListConfig: tenant.statusListConfig ?? undefined,
        };
    }

    /** Client secrets are one-way hashed, so the spec names a placeholder. */
    private clientSpec(
        client: Record<string, any>,
        requirements: ConfigBundleRequirement[],
    ): Record<string, unknown> {
        const spec: Record<string, unknown> = {
            clientId: client.clientId,
            description: client.description ?? undefined,
            roles: client.roles,
            allowedPresentationConfigs: client.allowedPresentationConfigs,
            allowedIssuanceConfigs: client.allowedIssuanceConfigs,
        };
        if (client.secret || this.configService.get<string>("OIDC")) {
            const env = placeholder("Client", client.clientId, "secret");
            spec.secret = `\${${env}}`;
            requirements.push({
                code: "CLIENT_SECRET_REQUIRED",
                resource: { kind: "Client", id: client.clientId },
                path: "/spec/secret",
                placeholder: env,
                message:
                    "Client secrets are one-way hashed. Supply a replacement or set secret to !generate during import.",
            });
        }
        return spec;
    }

    /**
     * A key chain held in the database names its private keys only with
     * `privateKeys`; otherwise its key source is `required`. Keys held in an
     * external KMS are always an `external-reference`.
     */
    private keyChainSpec(
        keyChain: KeyChainEntity,
        privateKeys = false,
    ): Record<string, unknown> {
        const internal = keyChain.hasInternalCa();
        const keySource = this.keyChainKeySource(keyChain, privateKeys);
        return {
            id: keyChain.id,
            ...keyChainSettingsSpec(keyChain),
            usageType: keyChain.usageType,
            kmsProvider: keyChain.kmsProvider,
            keySource,
            crt: [
                internal
                    ? keyChain.rootCertificate
                    : keyChain.activeCertificate,
            ],
            activeCertificate: internal
                ? keyChain.activeCertificate
                : undefined,
        };
    }

    private keyChainKeySource(
        keyChain: KeyChainEntity,
        privateKeys: boolean,
    ): Record<string, unknown> {
        const internal = keyChain.hasInternalCa();
        if (keyChain.externalKeyId) {
            return {
                type: "external-reference",
                provider: keyChain.kmsProvider,
                externalKeyId: internal
                    ? keyChain.rootExternalKeyId
                    : keyChain.externalKeyId,
                publicJwk: this.toPublicJwk(
                    internal ? keyChain.rootJwk : keyChain.activeJwk,
                ),
                ...(internal
                    ? {
                          activeExternalKeyId: keyChain.externalKeyId,
                          activePublicJwk: this.toPublicJwk(keyChain.activeJwk),
                      }
                    : {}),
            };
        }
        if (privateKeys) {
            return {
                type: "private-jwk",
                jwk: internal ? keyChain.rootJwk : keyChain.activeJwk,
                ...(internal ? { activeJwk: keyChain.activeJwk } : {}),
            };
        }
        return {
            type: "required",
            publicJwk: this.toPublicJwk(
                internal ? keyChain.rootJwk : keyChain.activeJwk,
            ),
        };
    }

    private statusListSpec(
        statusList: Record<string, any>,
    ): Record<string, unknown> {
        return {
            id: statusList.id,
            credentialConfigurationId: statusList.credentialConfigurationId,
            // A list without its own key chain has null; the schema has it optional.
            keyChainId: statusList.keyChainId ?? undefined,
            capacity: statusList.elements.length,
            bits: statusList.bits,
        };
    }

    private async addDocument(
        documents: ConfigDocument[],
        requirements: ConfigBundleRequirement[],
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
        rawSpec: object,
        redact = true,
    ): Promise<void> {
        const metadata = await this.ownershipService.get(tenantId, kind, id);
        const spec = redact
            ? this.redact(kind, id, canonicalize(rawSpec), requirements)
            : canonicalize(rawSpec);
        if (!CONFIG_SINGLETON_IDS[kind]) {
            (spec as Record<string, unknown>)[
                kind === "Client" ? "clientId" : "id"
            ] = id;
        }
        documents.push({
            $schema: schemaUrl(kind),
            kind,
            metadata: {
                generation: metadata.generation,
                // Detachment is local instance state, not part of the bundle format.
                ownership:
                    metadata.ownership === "detached"
                        ? "unmanaged"
                        : metadata.ownership,
            },
            spec: spec as Record<string, unknown>,
        });
    }

    private redact(
        kind: ConfigResourceKind,
        id: string,
        value: unknown,
        requirements: ConfigBundleRequirement[],
        path = "",
    ): unknown {
        if (Array.isArray(value)) {
            return value.map((item, index) =>
                this.redact(
                    kind,
                    id,
                    item,
                    requirements,
                    path ? `${path}.${index}` : `${index}`,
                ),
            );
        }
        if (!value || typeof value !== "object") return value;
        const patterns = this.registry.get(kind).sensitivePaths;
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(
            value as Record<string, unknown>,
        )) {
            const itemPath = path ? `${path}.${key}` : key;
            if (patterns.some((pattern) => pathMatches(pattern, itemPath))) {
                const env = placeholder(kind, id, itemPath);
                output[key] = `\${${env}}`;
                requirements.push({
                    code: "SECRET_REQUIRED",
                    resource: { kind, id },
                    path: `/spec/${itemPath.replaceAll(".", "/")}`,
                    placeholder: env,
                    message: `Supply ${env} in the target environment.`,
                });
            } else {
                output[key] = this.redact(
                    kind,
                    id,
                    item,
                    requirements,
                    itemPath,
                );
            }
        }
        return output;
    }

    private toPublicJwk(value: unknown): Record<string, unknown> | undefined {
        if (!value || typeof value !== "object") return undefined;
        const { d, p, q, dp, dq, qi, k, ...publicJwk } = value as Record<
            string,
            unknown
        >;
        return publicJwk;
    }

    private async exportAssets(tenantId: string) {
        const assets = [];
        for (const file of await this.files.find({ where: { tenantId } })) {
            const stored = await this.filesService.getStream(file.id);
            const chunks: Buffer[] = [];
            for await (const chunk of stored.stream) {
                chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
            }
            const data = Buffer.concat(chunks);
            assets.push({
                path: `images/${file.filename}`,
                contentType: stored.contentType,
                sha256: sha256(data),
                data: data.toString("base64"),
            });
        }
        return assets.sort((left, right) =>
            left.path.localeCompare(right.path),
        );
    }

    private async rewriteAssetReferences(
        tenantId: string,
        documents: ConfigDocument[],
    ): Promise<void> {
        const rewrite = await this.assetReferenceRewriter(tenantId);
        for (const document of documents) {
            document.spec = rewrite(document.spec) as Record<string, unknown>;
        }
    }

    /** Maps public storage URLs of tenant files back to their bundle filenames. */
    private async assetReferenceRewriter(
        tenantId: string,
    ): Promise<(value: unknown) => unknown> {
        const byId = new Map(
            (await this.files.find({ where: { tenantId } })).map((file) => [
                file.id,
                file.filename,
            ]),
        );
        const rewrite = (value: unknown): unknown => {
            if (typeof value === "string") {
                const match = /\/storage\/([^/?#]+)(?:[?#].*)?$/.exec(value);
                return match && byId.has(match[1]) ? byId.get(match[1]) : value;
            }
            if (Array.isArray(value)) return value.map(rewrite);
            // Leave non-plain values (dates, buffers) of stored entities intact.
            if (
                !value ||
                typeof value !== "object" ||
                Object.getPrototypeOf(value) !== Object.prototype
            )
                return value;
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(
                    ([key, item]) => [key, rewrite(item)],
                ),
            );
        };
        return rewrite;
    }

    private assertBundle(bundle: ConfigBundle): void {
        assertConfigBundle(bundle);
    }

    private collectUnresolvedRequirements(
        document: ConfigDocument,
        issues: ConfigMigrationIssue[],
    ): void {
        const visit = (value: unknown, path: string): void => {
            if (
                typeof value === "string" &&
                value !== "!generate" &&
                UNRESOLVED_PLACEHOLDER.test(value)
            ) {
                issues.push({
                    severity: "required-input",
                    code: "SECRET_REQUIRED",
                    path,
                    message: `Resolve ${value} before applying this resource.`,
                    resource: {
                        kind: document.kind,
                        id: resourceId(document),
                    },
                });
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((item, index) => visit(item, `${path}/${index}`));
                return;
            }
            if (value && typeof value === "object") {
                Object.entries(value as Record<string, unknown>).forEach(
                    ([key, item]) => visit(item, `${path}/${key}`),
                );
            }
        };
        visit(document.spec, "/spec");
        if (
            document.kind === "KeyChain" &&
            (document.spec as any).keySource?.type === "required"
        ) {
            issues.push({
                severity: "required-input",
                code: "PRIVATE_KEY_REQUIRED",
                path: "/spec/keySource",
                message:
                    "Supply private key material, an accessible external KMS reference, or explicitly regenerate the key.",
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            });
        }
    }

    /**
     * Whether a document this source applied as it is plans `unchanged`
     * without comparing it. With Keycloak, clients are applied again to undo
     * changes made there; apply keeps the secret of a client applied as it is.
     */
    private skipsComparison(
        document: ConfigDocument,
        metadata: Parameters<typeof documentAppliedAsIs>[1],
        source: string,
    ): boolean {
        if (document.kind === "Client" && this.configService.get("OIDC"))
            return false;
        return documentAppliedAsIs(document, metadata, source);
    }

    /** Compare the fields this import would write with current persisted configuration. */
    async compareDocument(
        tenantId: string,
        document: ConfigDocument,
    ): Promise<{ unchanged: boolean; changes: ConfigChange[] }> {
        const stored = await this.currentSpec(tenantId, document);
        if (!stored) return { unchanged: false, changes: [] };
        // Stored image references are storage URLs; bundles name the file.
        const current = (await this.assetReferenceRewriter(tenantId))(
            stored,
        ) as Record<string, any>;
        let desired = structuredClone(document.spec) as Record<string, any>;
        // Importers derive the identifier from metadata when it is omitted.
        if (document.kind === "Client")
            desired.clientId ??= resourceId(document);
        else if (!this.registry.get(document.kind).singletonId)
            desired.id ??= resourceId(document);
        // No defaults are stored as null, and 9.x exports wrote that null.
        // A null contact is stored the same way.
        if (document.kind === "RegistrarConfig") {
            for (const field of [
                "registrationCertificateDefaults",
                "relyingPartyContact",
            ])
                if (desired[field] === null) delete desired[field];
        }
        // Compare with the settings the importers store for the document.
        if (document.kind === "KeyChain") {
            desired.rotationPolicy = appliedRotationPolicy(desired);
            desired.kmsProvider = appliedKmsProvider(desired);
            desired.type = appliedKeyChainType(desired);
        }
        if (
            document.kind === "Client" &&
            typeof desired.secret === "string" &&
            desired.secret !== "!generate" &&
            typeof current.secret === "string"
        ) {
            try {
                if (await compareSecret(desired.secret, current.secret))
                    current.secret = desired.secret;
            } catch {
                /* Treat an unknown secret encoding as a change. */
            }
        }
        const before = this.documentValidationService.normalizeForComparison({
            ...document,
            spec: current,
        });
        const replacesSpec =
            document.kind === "KmsConfig" ||
            document.kind === "KeyChain" ||
            document.kind === "KeyChainDefaults" ||
            document.kind === "RegistrarConfig";
        const after = this.documentValidationService.normalizeForComparison({
            ...document,
            spec: replacesSpec ? desired : { ...current, ...desired },
        });
        // Omitted top-level fields retain their existing values in the importers.
        const previous = replacesSpec
            ? before
            : Object.fromEntries(
                  Object.keys(desired).map((key) => [key, before[key]]),
              );
        const next = replacesSpec
            ? after
            : Object.fromEntries(
                  Object.keys(desired).map((key) => [key, after[key]]),
              );
        const changes = configChanges(
            previous,
            next,
            this.registry.get(document.kind).sensitivePaths,
            "/spec",
        );
        const alwaysApply =
            (document.kind === "KeyChain" &&
                desired.keySource?.type === "regenerate") ||
            (document.kind === "Client" &&
                (desired.secret === "!generate" ||
                    !!this.configService.get("OIDC")));
        return {
            unchanged:
                !alwaysApply &&
                stableConfigJson(previous) === stableConfigJson(next),
            changes,
        };
    }

    private currentSpec(
        tenantId: string,
        document: ConfigDocument,
    ): Promise<Record<string, any> | undefined> {
        return this.storedSpec(tenantId, document.kind, resourceId(document));
    }

    /**
     * The persisted configuration of one resource in the fields of its spec.
     * Client secrets are the stored hashes and key chains held in the
     * database carry their private keys.
     */
    private async storedSpec(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<Record<string, any> | undefined> {
        let entity: any;
        switch (kind) {
            case "Tenant": {
                entity = await this.tenants.findOneBy({ id: tenantId });
                return entity ? this.tenantSpec(entity) : undefined;
            }
            case "Client": {
                entity = await this.clients.findOneBy({
                    tenantId,
                    clientId: id,
                });
                return entity
                    ? {
                          clientId: entity.clientId,
                          description: entity.description ?? undefined,
                          roles: entity.roles,
                          secret: entity.secret,
                          allowedPresentationConfigs:
                              entity.allowedPresentationConfigs,
                          allowedIssuanceConfigs: entity.allowedIssuanceConfigs,
                      }
                    : undefined;
            }
            case "KmsConfig":
                return (
                    this.kmsTenantConfigService.getTenantConfig(tenantId) ??
                    undefined
                );
            case "KeyChain": {
                entity = await this.keyChains.findOneBy({ tenantId, id });
                return entity ? this.keyChainSpec(entity, true) : undefined;
            }
            case "KeyChainDefaults": {
                // Without entries, all key chains are picked by rule.
                const defaults = await this.tenantDefaultKeyChains(tenantId);
                return defaults === undefined ? undefined : { ...defaults };
            }
            case "RegistrarConfig":
                entity = await this.registrarConfigs.findOneBy({ tenantId });
                break;
            case "IssuanceConfig":
                entity = await this.issuanceConfigs.findOneBy({ tenantId });
                break;
            case "CredentialConfig":
                entity = await this.credentialConfigs.findOneBy({
                    tenantId,
                    id,
                });
                break;
            case "PresentationConfig":
                entity = await this.presentationConfigs.findOneBy({
                    tenantId,
                    id,
                });
                break;
            case "AttributeProvider":
                entity = await this.attributeProviders.findOneBy({
                    tenantId,
                    id,
                });
                break;
            case "WebhookEndpoint":
                entity = await this.webhookEndpoints.findOneBy({
                    tenantId,
                    id,
                });
                break;
            case "FederationTrustAnchor":
                entity = await this.federationTrustAnchors.findOneBy({
                    tenantId,
                    id,
                });
                break;
            case "TrustList": {
                entity = await this.trustLists.findOneBy({ tenantId, id });
                return entity ? { ...trustListConfig(entity), id } : undefined;
            }
            case "StatusList": {
                entity = await this.statusLists.findOneBy({ tenantId, id });
                return entity
                    ? { ...this.statusListSpec(entity), id }
                    : undefined;
            }
        }
        return entity ? this.canonicalEntitySpec(kind, entity) : undefined;
    }

    /**
     * The tenant's default key chains: null when they name none, undefined
     * when the tenant does not exist.
     */
    private async tenantDefaultKeyChains(
        tenantId: string,
    ): Promise<DefaultKeyChains | null | undefined> {
        const tenant = await this.tenants.findOne({
            where: { id: tenantId },
            select: { id: true, defaultKeyChains: true },
        });
        return tenant
            ? defaultKeyChainsOrNull(tenant.defaultKeyChains)
            : undefined;
    }

    private async exists(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<boolean> {
        switch (kind) {
            case "Tenant":
                return (await this.tenants.countBy({ id: tenantId })) > 0;
            case "Client":
                return (
                    (await this.clients.countBy({ tenantId, clientId: id })) > 0
                );
            case "KmsConfig":
                return (
                    this.kmsTenantConfigService.getTenantConfig(tenantId) !==
                    null
                );
            case "KeyChain":
                return (await this.keyChains.countBy({ tenantId, id })) > 0;
            case "KeyChainDefaults": {
                // Defaults without entries exist once they were applied or
                // changed through the API, so create mode and the detached
                // and stale checks see a removed default as a change.
                const defaults = await this.tenantDefaultKeyChains(tenantId);
                if (defaults === undefined) return false;
                return (
                    defaults !== null ||
                    !!(await this.ownershipService.findStored(
                        tenantId,
                        kind,
                        id,
                    ))
                );
            }
            case "RegistrarConfig":
                return (await this.registrarConfigs.countBy({ tenantId })) > 0;
            case "IssuanceConfig":
                return (await this.issuanceConfigs.countBy({ tenantId })) > 0;
            case "CredentialConfig":
                return (
                    (await this.credentialConfigs.countBy({ tenantId, id })) > 0
                );
            case "PresentationConfig":
                return (
                    (await this.presentationConfigs.countBy({ tenantId, id })) >
                    0
                );
            case "AttributeProvider":
                return (
                    (await this.attributeProviders.countBy({ tenantId, id })) >
                    0
                );
            case "WebhookEndpoint":
                return (
                    (await this.webhookEndpoints.countBy({ tenantId, id })) > 0
                );
            case "TrustList":
                return (await this.trustLists.countBy({ tenantId, id })) > 0;
            case "FederationTrustAnchor":
                return (
                    (await this.federationTrustAnchors.countBy({
                        tenantId,
                        id,
                    })) > 0
                );
            case "StatusList":
                return (await this.statusLists.countBy({ tenantId, id })) > 0;
        }
    }
}
