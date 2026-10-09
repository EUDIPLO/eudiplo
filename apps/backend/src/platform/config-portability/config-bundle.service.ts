import { createHash } from "node:crypto";
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
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { compare as compareSecret } from "bcrypt";
import { Repository } from "typeorm";
import { KmsTenantConfigService } from "../../crypto/key/kms/kms-tenant-config.service.js";
import { withoutRemovedChainedVp } from "../../issuer/configuration/issuance/domain/removed-authorization-servers.js";
import { FileEntity } from "../../storage/entities/files.entity.js";
import { FilesService } from "../../storage/files.service.js";
import { ConfigBundleRepositories } from "./config-bundle-repositories.service.js";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigKmsReferenceService } from "./config-kms-reference.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundle,
    ConfigBundleRequirement,
    ConfigDocument,
    ConfigImportMode,
    ConfigImportPlan,
    ConfigImportPlanItem,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "./config-resource.types.js";

const OMITTED_FIELDS = new Set([
    "tenant",
    "tenantId",
    "createdAt",
    "updatedAt",
    "registrationCertificateCache",
    "readerAuthCache",
    "jwt",
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

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(
                ([key, item]) => !OMITTED_FIELDS.has(key) && item !== undefined,
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)]),
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

function placeholder(
    kind: ConfigResourceKind,
    id: string,
    path: string,
): string {
    return `${kind}_${id}_${path}`
        .replaceAll(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+/, "")
        .replace(/_+$/, "")
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
            {
                name: tenant.name,
                description: tenant.description,
                sessionConfig: tenant.sessionConfig ?? undefined,
                statusListConfig: tenant.statusListConfig ?? undefined,
            },
        );

        for (const client of await this.clients.find({ where: { tenantId } })) {
            const spec: Record<string, unknown> = {
                clientId: client.clientId,
                description: client.description,
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
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "Client",
                client.clientId,
                spec,
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

        for (const keyChain of await this.keyChains.find({
            where: { tenantId },
        })) {
            const publicJwk = this.toPublicJwk(
                keyChain.hasInternalCa()
                    ? keyChain.rootJwk
                    : keyChain.activeJwk,
            );
            const keySource = keyChain.externalKeyId
                ? {
                      type: "external-reference",
                      provider: keyChain.kmsProvider,
                      externalKeyId: keyChain.hasInternalCa()
                          ? keyChain.rootExternalKeyId
                          : keyChain.externalKeyId,
                      publicJwk,
                      activeExternalKeyId: keyChain.hasInternalCa()
                          ? keyChain.externalKeyId
                          : undefined,
                      activePublicJwk: keyChain.hasInternalCa()
                          ? this.toPublicJwk(keyChain.activeJwk)
                          : undefined,
                  }
                : { type: "required", publicJwk };
            const spec: Record<string, unknown> = {
                id: keyChain.id,
                description: keyChain.description,
                usageType: keyChain.usageType,
                kmsProvider: keyChain.kmsProvider,
                keySource,
                crt: keyChain.hasInternalCa()
                    ? [keyChain.rootCertificate]
                    : [keyChain.activeCertificate],
                activeCertificate: keyChain.hasInternalCa()
                    ? keyChain.activeCertificate
                    : undefined,
                rotationPolicy: {
                    enabled: keyChain.rotationEnabled,
                    intervalDays: keyChain.rotationIntervalDays,
                    certValidityDays: keyChain.certValidityDays,
                },
            };
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
        for (const trustList of await this.trustLists.find({
            where: { tenantId },
        })) {
            await this.addDocument(
                documents,
                requirements,
                tenantId,
                "TrustList",
                trustList.id,
                {
                    id: trustList.id,
                    description: trustList.description,
                    keyChainId: trustList.keyChainId,
                    entities: trustList.entityConfig ?? [],
                    data: trustList.data,
                },
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
                {
                    id: status.id,
                    credentialConfigurationId: status.credentialConfigurationId,
                    keyChainId: status.keyChainId,
                    capacity: status.elements.length,
                    bits: status.bits,
                },
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

    async plan(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        ownershipSource = `bundle:${bundle.manifest.tenant}`,
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
            const itemIssues = [...result.issues];
            itemIssues.push(
                ...this.documentValidationService.validate(result.document),
            );
            this.collectUnresolvedRequirements(result.document, itemIssues);
            if (
                exists &&
                (result.document.metadata.generation ?? 1) < metadata.generation
            ) {
                itemIssues.push({
                    severity: "error",
                    code: "STALE_GENERATION",
                    path: "/metadata/generation",
                    message: `Generation ${result.document.metadata.generation ?? 1} is older than stored generation ${metadata.generation}.`,
                    resource: {
                        kind: result.document.kind,
                        id: resourceId(result.document),
                    },
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
            const skipExisting = exists && mode === "create";
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
            const comparison =
                exists && mode !== "create" && !blocked
                    ? await this.compareDocument(tenantId, result.document)
                    : undefined;
            const metadataChanged =
                metadata.ownership !== "file-managed" ||
                metadata.source !== ownershipSource ||
                metadata.generation !==
                    (result.document.metadata.generation ?? 1);
            items.push({
                changes: comparison?.changes,
                metadataChanged,
                kind: result.document.kind,
                id: resourceId(result.document),
                action: blocked
                    ? "blocked"
                    : skipExisting
                      ? "skip"
                      : comparison?.unchanged
                        ? "unchanged"
                        : exists
                          ? "update"
                          : "create",
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
                    included.has(`${metadata.kind}/${metadata.resourceId}`)
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
        }
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
                    .map(canonicalize)
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
        return sha256(stableConfigJson(canonicalize(state)));
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
                    clientSecret: entity.clientSecret,
                    username: entity.username,
                    password: entity.password,
                    registrationCertificateDefaults:
                        entity.registrationCertificateDefaults,
                };
            case "IssuanceConfig":
                return {
                    batchSize: entity.batchSize,
                    dPopRequired: entity.dPopRequired,
                    walletAttestationRequired: entity.walletAttestationRequired,
                    walletProviderTrustLists:
                        entity.walletProviderTrustLists ?? undefined,
                    signingKeyId: entity.signingKeyId ?? undefined,
                    // Removed authorization server options are not exported.
                    authorizationServers: Array.isArray(
                        entity.authorizationServers,
                    )
                        ? withoutRemovedChainedVp(entity.authorizationServers)
                              .servers
                        : entity.authorizationServers,
                    federation: entity.federation,
                    registrationCertificate: entity.registrationCertificate,
                    display: entity.display,
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
                    fields: entity.fields,
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
            default:
                throw new Error(
                    `No entity export mapper registered for ${kind}`,
                );
        }
    }

    private async addDocument(
        documents: ConfigDocument[],
        requirements: ConfigBundleRequirement[],
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
        rawSpec: Record<string, unknown>,
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
                ownership: metadata.ownership,
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
                /^\$\{[A-Z0-9_]+(?::[^}]*)?\}$/.test(value)
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
            document.kind === "KmsConfig" || document.kind === "KeyChain";
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

    private async currentSpec(
        tenantId: string,
        document: ConfigDocument,
    ): Promise<Record<string, any> | undefined> {
        const id = resourceId(document);
        let entity: any;
        switch (document.kind) {
            case "Tenant": {
                entity = await this.tenants.findOneBy({ id: tenantId });
                return entity
                    ? {
                          name: entity.name,
                          description: entity.description ?? undefined,
                          sessionConfig: entity.sessionConfig ?? undefined,
                          statusListConfig:
                              entity.statusListConfig ?? undefined,
                      }
                    : undefined;
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
                if (!entity) return undefined;
                const internal = entity.hasInternalCa();
                const keySource = entity.externalKeyId
                    ? {
                          type: "external-reference",
                          provider: entity.kmsProvider,
                          externalKeyId: internal
                              ? entity.rootExternalKeyId
                              : entity.externalKeyId,
                          publicJwk: this.toPublicJwk(
                              internal ? entity.rootJwk : entity.activeJwk,
                          ),
                          ...(internal
                              ? {
                                    activeExternalKeyId: entity.externalKeyId,
                                    activePublicJwk: this.toPublicJwk(
                                        entity.activeJwk,
                                    ),
                                }
                              : {}),
                      }
                    : {
                          type: "private-jwk",
                          jwk: internal ? entity.rootJwk : entity.activeJwk,
                          ...(internal ? { activeJwk: entity.activeJwk } : {}),
                      };
                return {
                    id,
                    description: entity.description,
                    usageType: entity.usageType,
                    keySource,
                    crt: [
                        internal
                            ? entity.rootCertificate
                            : entity.activeCertificate,
                    ],
                    activeCertificate: internal
                        ? entity.activeCertificate
                        : undefined,
                    kmsProvider: entity.kmsProvider,
                    rotationPolicy: {
                        enabled: entity.rotationEnabled,
                        intervalDays: entity.rotationIntervalDays ?? undefined,
                        certValidityDays: entity.certValidityDays ?? undefined,
                    },
                };
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
            case "TrustList": {
                entity = await this.trustLists.findOneBy({ tenantId, id });
                return entity
                    ? {
                          id,
                          description: entity.description,
                          keyChainId: entity.keyChainId,
                          entities: entity.entityConfig ?? [],
                          data: entity.data,
                      }
                    : undefined;
            }
            case "StatusList": {
                entity = await this.statusLists.findOneBy({ tenantId, id });
                return entity
                    ? {
                          id,
                          credentialConfigurationId:
                              entity.credentialConfigurationId,
                          keyChainId: entity.keyChainId,
                          capacity: entity.elements.length,
                          bits: entity.bits,
                      }
                    : undefined;
            }
        }
        return entity
            ? this.canonicalEntitySpec(document.kind, entity)
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
            case "StatusList":
                return (await this.statusLists.countBy({ tenantId, id })) > 0;
        }
    }
}
