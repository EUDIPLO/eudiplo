import {
    createHash,
    createPrivateKey,
    randomBytes,
    X509Certificate,
} from "node:crypto";
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
    ConfigResourceKind,
} from "./config-resource.types.js";
import type { ConfigImportRunEntity } from "./entities/config-import-run.entity.js";

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
        private readonly statusListService: StatusListService,
        @Inject(CLIENTS_PROVIDER)
        private readonly clientsProvider: ClientsProvider,
        private readonly repos: ConfigBundleRepositories,
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

    async apply(
        tenantId: string,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        ownershipSource = `bundle:${bundle.manifest.tenant}`,
        expectedFingerprint?: string,
    ): Promise<ConfigImportPlan> {
        return this.journal.run(tenantId, mode, (run) =>
            this.applyLocked(
                tenantId,
                bundle,
                mode,
                ownershipSource,
                run,
                expectedFingerprint,
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
    ): Promise<ConfigImportPlan> {
        const plan = await this.bundleService.plan(
            tenantId,
            bundle,
            mode,
            ownershipSource,
        );
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
                sourceHash: createHash("sha256")
                    .update(JSON.stringify(document))
                    .digest("hex"),
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
                                    document.spec,
                                );
                                await this.ownershipService.markApplied(
                                    ownership,
                                    manager,
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
                        const secret = await this.applyDocument(
                            tenantId,
                            document,
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
                    await this.ownershipService.markApplied(ownership);
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
                await this.trustListService.remove(tenantId, id);
                return;
            case "StatusList":
                await this.statusListService.deleteList(tenantId, id);
        }
    }

    private async applyDocument(
        tenantId: string,
        document: ConfigDocument,
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
                await this.tenants.update({ id: tenantId }, spec);
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
                    if (generated) {
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
                return generated
                    ? {
                          kind: "Client",
                          id: resourceId(document),
                          path: "/spec/secret",
                          value: secret!,
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
                await this.registrarConfigService.saveConfig(
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
                    type:
                        spec.keySource.keyChainType ??
                        (spec.activeCertificate
                            ? KeyChainType.InternalChain
                            : KeyChainType.Standalone),
                    description: spec.description,
                    kmsProvider:
                        spec.keySource.provider ?? spec.kmsProvider ?? "db",
                    rotationPolicy: spec.rotationPolicy,
                },
            );
            return;
        }
        if (spec.keySource?.type === "private-jwk") {
            if (spec.keySource.activeJwk) {
                // Validate both key/certificate pairs before touching the live row.
                for (const [jwk, certificate] of [
                    [spec.keySource.jwk, spec.crt?.at(-1)],
                    [spec.keySource.activeJwk, spec.activeCertificate],
                ]) {
                    const key = createPrivateKey({ key: jwk, format: "jwk" });
                    if (
                        !certificate ||
                        !new X509Certificate(certificate).checkPrivateKey(key)
                    ) {
                        throw new BadRequestException(
                            "Imported certificate does not match its private key",
                        );
                    }
                }
                await this.keyChains.save({
                    id: resourceId(document),
                    tenantId,
                    description: spec.description,
                    usageType: spec.usageType,
                    usage: KeyUsage.Sign,
                    kmsProvider: "db",
                    externalKeyId: null as any,
                    rootExternalKeyId: null as any,
                    rootJwk: spec.keySource.jwk,
                    rootCertificate: spec.crt?.at(-1),
                    activeJwk: spec.keySource.activeJwk,
                    activeCertificate: spec.activeCertificate,
                    rotationEnabled: spec.rotationPolicy?.enabled ?? true,
                    rotationIntervalDays: spec.rotationPolicy?.intervalDays,
                    certValidityDays: spec.rotationPolicy?.certValidityDays,
                });
                return;
            }
            await this.keyChainService.importKeyChain(
                tenantId,
                this.migrationService.unwrapForLegacyImporter(document) as any,
            );
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
            description: spec.description,
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
            rotationEnabled: spec.rotationPolicy?.enabled ?? false,
            rotationIntervalDays:
                spec.rotationPolicy?.intervalDays ?? (null as any),
            certValidityDays:
                spec.rotationPolicy?.certValidityDays ?? (null as any),
        });
    }

    private order(kind: ConfigResourceKind): number {
        return this.resourceRegistry.get(kind).importPhase;
    }
}
