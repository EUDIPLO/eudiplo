import { randomBytes } from "node:crypto";
import {
    normalizeDocument,
    resourceId,
} from "@eudiplo/config-format/config-format.js";
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
} from "@nestjs/common";
import {
    CLIENTS_PROVIDER,
    ClientsProvider,
} from "../../auth/client/client.provider.js";
import { ClientAccessService } from "../../auth/client/client-access.service.js";
import { isRole } from "../../auth/roles/role.enum.js";
import { assertMayGrantRoles } from "../../auth/roles/role-grants.js";
import { tenantDocumentUpdate } from "../../auth/tenant/domain/tenant-data.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { KeyChainType } from "../../crypto/key/dto/key-chain-create.dto.js";
import { KeyUsage } from "../../crypto/key/entities/key-chain.entity.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KmsTenantConfigService } from "../../crypto/key/kms/kms-tenant-config.service.js";
import { AttributeProviderService } from "../../issuer/configuration/attribute-provider/attribute-provider.service.js";
import { CredentialConfigService } from "../../issuer/configuration/credentials/credential-config/credential-config.service.js";
import { IssuanceService } from "../../issuer/configuration/issuance/issuance.service.js";
import { WebhookEndpointService } from "../../issuer/configuration/webhook-endpoint/webhook-endpoint.service.js";
import { StatusListService } from "../../issuer/status-list/status-list.service.js";
import { TrustListService } from "../../issuer/trust-list/trustlist.service.js";
import { RegistrarConfigService } from "../../registrar/registrar-config.service.js";
import { FilesService } from "../../storage/files.service.js";
import { FederationTrustAnchorService } from "../../trust/federation-trust-anchor/federation-trust-anchor.service.js";
import { PresentationConfigService } from "../../verifier/presentations/configuration/presentation-config.service.js";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigBundleRepositories } from "./config-bundle-repositories.service.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigKmsReferenceService } from "./config-kms-reference.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigApplyOperation,
    ConfigBundle,
    ConfigDocument,
    ConfigImportMode,
    ConfigImportPlan,
    ConfigPlanOptions,
    ConfigResourceKind,
} from "./config-resource.types.js";
import {
    documentAppliedAsIs,
    documentSourceHash,
} from "./config-source-hash.js";
import type { ConfigImportRunEntity } from "./entities/config-import-run.entity.js";
import {
    appliedKeyChainType,
    appliedKmsProvider,
    internalChainProblems,
    isInternalChainWithPrivateKeys,
    keyChainSettingsColumns,
} from "./key-chain-document.js";

function redactDiagnosticMessage(message: string): string {
    return message
        .replace(
            /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
            "[REDACTED_CERTIFICATE]",
        )
        .replace(
            /\b(password|secret|token|private(?:[-_ ]key| credential))\b\s*[:=]\s*[^\s,;]+/gi,
            "$1=[REDACTED]",
        )
        .replace(
            /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
            "[REDACTED_JWT]",
        );
}

@Injectable()
export class ConfigBundleApplyService {
    private readonly logger = new Logger(ConfigBundleApplyService.name);

    constructor(
        private readonly bundleService: ConfigBundleService,
        private readonly journal: ConfigImportJournalService,
        private readonly migrationService: ConfigMigrationService,
        private readonly ownershipService: ConfigOwnershipService,
        private readonly filesService: FilesService,
        private readonly keyChainService: KeyChainService,
        private readonly kmsReferenceService: ConfigKmsReferenceService,
        private readonly resourceRegistry: ConfigResourceRegistry,
        private readonly kmsTenantConfigService: KmsTenantConfigService,
        private readonly registrarConfigService: RegistrarConfigService,
        private readonly issuanceService: IssuanceService,
        private readonly credentialConfigService: CredentialConfigService,
        private readonly presentationConfigService: PresentationConfigService,
        private readonly attributeProviderService: AttributeProviderService,
        private readonly webhookEndpointService: WebhookEndpointService,
        private readonly trustListService: TrustListService,
        private readonly federationTrustAnchorService: FederationTrustAnchorService,
        private readonly statusListService: StatusListService,
        @Inject(CLIENTS_PROVIDER)
        private readonly clientsProvider: ClientsProvider,
        private readonly repos: ConfigBundleRepositories,
        private readonly clientAccess: ClientAccessService,
    ) {}

    /**
     * Applies the client API's grant rule to the client documents of an API
     * caller's import: a client may keep its roles, but not gain one the
     * caller may not grant. Runs before planning.
     */
    async assertCallerMayAssignRoles(
        tenantId: string,
        bundle: ConfigBundle,
        callerRoles: readonly string[],
    ): Promise<void> {
        for (const document of bundle.documents ?? []) {
            const spec = document?.spec;
            if (!Array.isArray(spec?.roles)) continue;
            // Unknown role names are left to the document validation.
            const roles = spec.roles.filter(isRole);
            if (typeof spec.clientId === "string") {
                await this.clientAccess.assertMayAssignRoles(
                    callerRoles,
                    tenantId,
                    spec.clientId,
                    roles,
                );
            } else {
                assertMayGrantRoles(callerRoles, roles);
            }
        }
    }

    /**
     * Refuses an API caller's import whose plan changes or deletes a client
     * with a role the caller neither holds nor may grant.
     */
    async assertCallerMayChangeClients(
        tenantId: string,
        plan: ConfigImportPlan,
        callerRoles: readonly string[],
    ): Promise<void> {
        for (const item of plan.items) {
            if (
                item.kind === "Client" &&
                (item.action === "update" || item.action === "delete")
            ) {
                await this.clientAccess.assertMayManage(
                    callerRoles,
                    tenantId,
                    item.id,
                );
            }
        }
    }

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

    async apply(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        ownershipSource = `bundle:${bundle.manifest.tenant}`,
        expectedFingerprint?: string,
        options: ConfigPlanOptions = {},
    ): Promise<ConfigImportPlan> {
        return this.journal.run(
            tenantId,
            options.reattach ? "reattach" : mode,
            (run) =>
                this.applyLocked(
                    tenantId,
                    bundle,
                    mode,
                    ownershipSource,
                    run,
                    expectedFingerprint,
                    options,
                ),
        );
    }

    private async applyLocked(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        ownershipSource: string,
        run: ConfigImportRunEntity,
        expectedFingerprint?: string,
        options: ConfigPlanOptions = {},
    ): Promise<ConfigImportPlan> {
        if (options.callerRoles) {
            await this.assertCallerMayAssignRoles(
                tenantId,
                bundle,
                options.callerRoles,
            );
        }
        const plan = await this.bundleService.plan(
            tenantId,
            bundle,
            mode,
            ownershipSource,
            options,
        );
        if (options.callerRoles) {
            await this.assertCallerMayChangeClients(
                tenantId,
                plan,
                options.callerRoles,
            );
        }
        if (
            expectedFingerprint &&
            plan.planFingerprint !== expectedFingerprint
        ) {
            throw new ConflictException({
                code: "CONFIG_PLAN_STALE",
                message:
                    "The bundle, mode or target configuration changed. Review a new plan before applying.",
                operationId: run.id,
            });
        }
        run.planFingerprint = plan.planFingerprint ?? null;
        if (!plan.applicable) {
            throw new BadRequestException({
                code: "CONFIG_APPLY_BLOCKED",
                operationId: run.id,
                message: "Configuration bundle has blocking issues",
                plan,
            });
        }
        const generatedSecrets: NonNullable<
            ConfigImportPlan["generatedSecrets"]
        > = [];
        const operations: ConfigApplyOperation[] = [];
        const tasks: Array<() => Promise<void>> = [];
        const add = (
            operation: Omit<ConfigApplyOperation, "status">,
            run: () => Promise<void>,
        ) => {
            operations.push({ ...operation, status: "pending" });
            tasks.push(run);
        };
        // Assets must exist before importers resolve image filenames to public URLs.
        for (const asset of bundle.assets ?? []) {
            if (
                !plan.assets?.some(
                    (item) =>
                        item.path === asset.path &&
                        (item.action === "create" || item.action === "update"),
                )
            )
                continue;
            add({ stage: "asset", path: asset.path }, async () => {
                await this.filesService.saveImportedAsset(
                    tenantId,
                    asset.path.replace(/^images\//, ""),
                    Buffer.from(asset.data, "base64"),
                    asset.contentType,
                    mode !== "create",
                );
            });
        }
        const items = new Map(
            plan.items.map((item) => [`${item.kind}/${item.id}`, item]),
        );
        const ordered = bundle.documents
            .map(normalizeDocument)
            .sort(
                (left, right) => this.order(left.kind) - this.order(right.kind),
            );
        for (const input of ordered) {
            const { document } = this.migrationService.upgrade(input);
            const item = items.get(`${document.kind}/${resourceId(document)}`);
            const write =
                item?.action === "create" || item?.action === "update";
            if (
                !write &&
                !(item?.action === "unchanged" && item.metadataChanged)
            )
                continue;
            const ownership = {
                tenantId,
                kind: document.kind,
                resourceId: resourceId(document),
                ownership: "file-managed" as const,
                generation: document.metadata.generation ?? 1,
                source: ownershipSource,
                sourceHash: documentSourceHash(document),
            };
            if (write && document.kind === "Tenant") {
                // These writes share a database, so commit the config and ownership together.
                add(
                    {
                        stage: "resource-and-ownership",
                        kind: document.kind,
                        id: resourceId(document),
                    },
                    async () => {
                        await this.tenants.manager.transaction(
                            async (manager) => {
                                await manager.update(
                                    TenantEntity,
                                    { id: tenantId },
                                    tenantDocumentUpdate(document.spec),
                                );
                                await this.ownershipService.markApplied(
                                    ownership,
                                    manager,
                                    options.reattach,
                                );
                            },
                        );
                    },
                );
                continue;
            }
            // A startup KMS document is already the backing file. Only record ownership.
            if (
                write &&
                !(
                    document.kind === "KmsConfig" &&
                    ownershipSource.startsWith("folder:")
                )
            ) {
                add(
                    {
                        stage: "resource",
                        kind: document.kind,
                        id: resourceId(document),
                    },
                    async () => {
                        // With Keycloak, the plan lists a client applied as it is
                        // as an update, which keeps its secret.
                        const appliedAsIs =
                            document.kind === "Client" &&
                            !options.reattach &&
                            documentAppliedAsIs(
                                document,
                                await this.ownershipService.get(
                                    tenantId,
                                    document.kind,
                                    resourceId(document),
                                ),
                                ownershipSource,
                            );
                        const secret = await this.applyDocument(
                            tenantId,
                            document,
                            appliedAsIs,
                        );
                        if (secret) generatedSecrets.push(secret);
                    },
                );
            }
            add(
                {
                    stage: "ownership",
                    kind: document.kind,
                    id: resourceId(document),
                },
                async () => {
                    await this.ownershipService.markApplied(
                        ownership,
                        undefined,
                        options.reattach,
                    );
                },
            );
        }
        const deletions = plan.items
            .filter((item) => item.action === "delete")
            .sort(
                (left, right) => this.order(right.kind) - this.order(left.kind),
            );
        for (const item of deletions) {
            add({ stage: "delete", kind: item.kind, id: item.id }, () =>
                this.deleteDocument(tenantId, item.kind, item.id),
            );
            add(
                { stage: "delete-ownership", kind: item.kind, id: item.id },
                () =>
                    this.ownershipService.remove(tenantId, item.kind, item.id),
            );
        }
        run.operations = operations;
        await this.journal.checkpoint(run);
        for (let index = 0; index < tasks.length; index++) {
            try {
                operations[index].status = "running";
                await this.journal.checkpoint(run);
                await tasks[index]();
                operations[index].status = "completed";
                await this.journal.checkpoint(run);
            } catch (error) {
                // A failing service may already have changed external state. Never claim rollback.
                operations[index].status = "failed";
                const reason =
                    error instanceof Error ? error.message : String(error);
                this.logger?.error(
                    `[${tenantId}] Config operation failed: ${operations[index].stage}/${operations[index].kind ?? ""}/${operations[index].id ?? ""}: ${redactDiagnosticMessage(reason)}`,
                    error instanceof Error ? error.stack : undefined,
                );
                throw new InternalServerErrorException({
                    code: "CONFIG_APPLY_FAILED",
                    operationId: run.id,
                    failedOperation: {
                        stage: operations[index].stage,
                        kind: operations[index].kind,
                        id: operations[index].id,
                    },
                    message:
                        "Configuration apply stopped. Completed operations remain applied; the failed operation may have partial effects. Inspect the report and run plan again before retrying.",
                    tenantId,
                    mode,
                    operations,
                    ...(generatedSecrets.length ? { generatedSecrets } : {}),
                });
            }
        }
        return {
            ...plan,
            operationId: run.id,
            ...(generatedSecrets.length ? { generatedSecrets } : {}),
        };
    }

    private async deleteDocument(
        tenantId: string,
        kind: ConfigResourceKind,
        id: string,
    ): Promise<void> {
        switch (kind) {
            case "Tenant":
                throw new BadRequestException(
                    "Replace mode cannot delete a tenant",
                );
            case "Client":
                await this.clientsProvider.removeClient(tenantId, id);
                return;
            case "KmsConfig":
                this.kmsTenantConfigService.deleteTenantConfig(tenantId);
                return;
            case "KeyChain":
                // Unlike DELETE /key-chain/{id}, without the reference check:
                // the plan blocks deleting a key chain that a surviving
                // configuration names, as for trust lists below.
                await this.keyChainService.delete(tenantId, id);
                return;
            case "RegistrarConfig":
                await this.registrarConfigService.deleteConfig(tenantId);
                return;
            case "IssuanceConfig":
                await this.issuanceConfigs.delete({ tenantId });
                return;
            case "CredentialConfig":
                await this.credentialConfigService.delete(tenantId, id);
                return;
            case "PresentationConfig":
                await this.presentationConfigService.deletePresentationConfig(
                    id,
                    tenantId,
                );
                return;
            case "AttributeProvider":
                await this.attributeProviderService.delete(tenantId, id);
                return;
            case "WebhookEndpoint":
                await this.webhookEndpointService.delete(tenantId, id);
                return;
            case "TrustList":
                // Unlike DELETE /trust-list/{id}, without the reference check:
                // the plan, which apply runs again under the import lock, blocks
                // deleting a list that a surviving configuration references.
                // Checking here would refuse a list whose referencing
                // configuration this plan deletes later (lower import phase).
                await this.trustListService.remove(tenantId, id);
                return;
            case "FederationTrustAnchor":
                // Without the reference check, as for trust lists: the plan
                // blocks deleting an anchor a surviving configuration names.
                await this.federationTrustAnchorService.delete(
                    tenantId,
                    id,
                    undefined,
                    undefined,
                    { checkReferences: false },
                );
                return;
            case "StatusList":
                await this.statusListService.deleteList(tenantId, id);
        }
    }

    private async applyDocument(
        tenantId: string,
        document: ConfigDocument,
        appliedAsIs: boolean,
    ): Promise<
        | {
              kind: "Client";
              id: string;
              path: "/spec/secret";
              value: string;
          }
        | undefined
    > {
        const spec = structuredClone(document.spec) as Record<string, any>;
        switch (document.kind) {
            case "Tenant":
                await this.tenants.update(
                    { id: tenantId },
                    tenantDocumentUpdate(spec),
                );
                return;
            case "Client": {
                const exists =
                    (await this.clients.countBy({
                        tenantId,
                        clientId: resourceId(document),
                    })) > 0;
                const generated = spec.secret === "!generate";
                const secret = generated
                    ? exists
                        ? undefined
                        : randomBytes(32).toString("base64url")
                    : typeof spec.secret === "string"
                      ? spec.secret
                      : undefined;
                delete spec.secret;
                const client = {
                    ...spec,
                    clientId: resourceId(document),
                } as any;
                if (exists) {
                    await this.clientsProvider.updateClient(
                        tenantId,
                        resourceId(document),
                        client,
                    );
                    // The secret was generated when this document was applied.
                    if (generated && !appliedAsIs) {
                        const value =
                            await this.clientsProvider.rotateClientSecret(
                                tenantId,
                                resourceId(document),
                            );
                        return {
                            kind: "Client",
                            id: resourceId(document),
                            path: "/spec/secret",
                            value,
                        };
                    }
                    if (secret) {
                        await this.clientsProvider.setClientSecret(
                            tenantId,
                            resourceId(document),
                            secret,
                        );
                    }
                } else {
                    await this.clientsProvider.addClient(tenantId, {
                        ...client,
                        secret,
                    });
                }
                return generated && secret
                    ? {
                          kind: "Client",
                          id: resourceId(document),
                          path: "/spec/secret",
                          value: secret,
                      }
                    : undefined;
            }
            case "KmsConfig":
                this.kmsTenantConfigService.saveTenantConfig(
                    tenantId,
                    spec as any,
                );
                return;
            case "KeyChain":
                await this.applyKeyChain(tenantId, document);
                return;
            case "RegistrarConfig":
                await this.registrarConfigService.replaceConfig(
                    tenantId,
                    spec as any,
                );
                return;
            case "IssuanceConfig":
                await this.issuanceService.storeIssuanceConfiguration(
                    tenantId,
                    spec as any,
                );
                return;
            case "CredentialConfig":
                await this.credentialConfigService.store(
                    tenantId,
                    { ...spec, id: resourceId(document) } as any,
                    true,
                );
                return;
            case "PresentationConfig":
                await this.presentationConfigService.storePresentationConfig(
                    tenantId,
                    { ...spec, id: resourceId(document) } as any,
                );
                return;
            case "AttributeProvider":
                if (
                    await this.attributeProviders.countBy({
                        tenantId,
                        id: resourceId(document),
                    })
                ) {
                    await this.attributeProviderService.update(
                        tenantId,
                        resourceId(document),
                        spec as any,
                    );
                } else {
                    await this.attributeProviderService.create(tenantId, {
                        ...spec,
                        id: resourceId(document),
                    } as any);
                }
                return;
            case "WebhookEndpoint":
                if (
                    await this.webhookEndpoints.countBy({
                        tenantId,
                        id: resourceId(document),
                    })
                ) {
                    await this.webhookEndpointService.update(
                        tenantId,
                        resourceId(document),
                        spec as any,
                    );
                } else {
                    await this.webhookEndpointService.create(tenantId, {
                        ...spec,
                        id: resourceId(document),
                    } as any);
                }
                return;
            case "TrustList": {
                const tenant = await this.tenants.findOneByOrFail({
                    id: tenantId,
                });
                if (
                    await this.trustLists.countBy({
                        tenantId,
                        id: resourceId(document),
                    })
                ) {
                    await this.trustListService.update(
                        tenantId,
                        resourceId(document),
                        { ...spec, id: resourceId(document) } as any,
                    );
                } else {
                    await this.trustListService.create(
                        { ...spec, id: resourceId(document) } as any,
                        tenant,
                    );
                }
                return;
            }
            case "FederationTrustAnchor": {
                const anchor = { ...spec, id: resourceId(document) } as any;
                if (
                    await this.repos.federationTrustAnchors.countBy({
                        tenantId,
                        id: anchor.id,
                    })
                ) {
                    // Omitted fields keep their stored values, as the plan
                    // shows.
                    // The plan checks an entity ID change against the
                    // configurations that survive the import; checking here
                    // would refuse one whose configuration a later step
                    // (higher import phase) rewrites.
                    const { id, ...update } = anchor;
                    await this.federationTrustAnchorService.update(
                        tenantId,
                        id,
                        update,
                        undefined,
                        undefined,
                        { checkReferences: false },
                    );
                } else {
                    await this.federationTrustAnchorService.create(
                        tenantId,
                        anchor,
                    );
                }
                return;
            }
            case "StatusList":
                await this.statusListService.processStatusListConfig(tenantId, {
                    ...spec,
                    id: resourceId(document),
                } as any);
        }
    }

    private async applyKeyChain(
        tenantId: string,
        document: ConfigDocument,
    ): Promise<void> {
        const spec = document.spec as any;
        if (spec.keySource?.type === "regenerate") {
            await this.keyChainService.regenerate(
                tenantId,
                resourceId(document),
                {
                    usageType: spec.usageType,
                    type: appliedKeyChainType(spec) as KeyChainType,
                    description: spec.description,
                    kmsProvider:
                        spec.keySource.provider ?? spec.kmsProvider ?? "db",
                    rotationPolicy: spec.rotationPolicy,
                },
            );
            return;
        }
        // The plan blocks on this too; the importer would only catch the private-jwk import path.
        const unsupported = this.kmsReferenceService.unsupportedAlgorithm(
            tenantId,
            spec,
        );
        if (unsupported) throw new BadRequestException(unsupported.message);
        if (spec.keySource?.type === "private-jwk") {
            if (isInternalChainWithPrivateKeys(spec)) {
                // The plan blocks on these problems; check again before touching the live row.
                const [problem] = internalChainProblems(spec);
                if (problem) throw new BadRequestException(problem.message);
                await this.keyChains.save({
                    id: resourceId(document),
                    tenantId,
                    usageType: spec.usageType,
                    usage: KeyUsage.Sign,
                    kmsProvider: appliedKmsProvider(spec),
                    externalKeyId: null as any,
                    rootExternalKeyId: null as any,
                    rootJwk: spec.keySource.jwk,
                    rootCertificate: spec.crt?.at(-1),
                    activeJwk: spec.keySource.activeJwk,
                    activeCertificate: spec.activeCertificate,
                    ...keyChainSettingsColumns(spec),
                });
                return;
            }
            // The importer sets rotation itself but keeps an omitted description.
            await this.keyChainService.importKeyChain(tenantId, {
                ...this.migrationService.unwrapForLegacyImporter(document),
                description: spec.description ?? null,
            } as any);
            return;
        }
        if (spec.keySource?.type !== "external-reference") {
            throw new BadRequestException(
                `KeyChain '${resourceId(document)}' has no importable key source`,
            );
        }
        await this.kmsReferenceService.verify(tenantId, spec.keySource);
        await this.keyChains.save({
            id: resourceId(document),
            tenantId,
            usageType: spec.usageType,
            usage: KeyUsage.Sign,
            kmsProvider: spec.keySource.provider,
            rootJwk: spec.keySource.activeExternalKeyId
                ? spec.keySource.publicJwk
                : (null as any),
            rootExternalKeyId: spec.keySource.activeExternalKeyId
                ? spec.keySource.externalKeyId
                : (null as any),
            rootCertificate: spec.keySource.activeExternalKeyId
                ? spec.crt?.at(-1)
                : (null as any),
            activeJwk:
                spec.keySource.activePublicJwk ?? spec.keySource.publicJwk,
            externalKeyId:
                spec.keySource.activeExternalKeyId ??
                spec.keySource.externalKeyId,
            activeCertificate:
                spec.activeCertificate ?? spec.crt?.join("\n") ?? "",
            ...keyChainSettingsColumns(spec),
        });
    }

    private order(kind: ConfigResourceKind): number {
        return this.resourceRegistry.get(kind).importPhase;
    }
}
