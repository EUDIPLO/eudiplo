import { serializeDocument } from "@eudiplo/config-format/config-format.js";
import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Param,
    Post,
    Query,
    Req,
    Res,
    UploadedFile,
    UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuditLogService } from "../../audit-log/audit-log.service.js";
import {
    extractRequestMeta,
    resolveAuditActor,
} from "../../audit-log/audit-log-context.util.js";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { requireTenantContext } from "../../auth/tenant-context.util.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import { ConfigBundleArchiveService } from "./config-bundle-archive.service.js";
import { ConfigFolderBundleService } from "./config-folder-bundle.service.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import type {
    ConfigBundle,
    ConfigFile,
    ConfigImportMode,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { CONFIG_RESOURCE_KINDS } from "./config-resource.types.js";

@ApiTags("Configuration portability")
@Secured([Role.Tenants, Role.TenantAdmin])
@Controller("config-bundles")
export class ConfigPortabilityController {
    constructor(
        private readonly bundleService: ConfigBundleService,
        private readonly archiveService: ConfigBundleArchiveService,
        private readonly applyService: ConfigBundleApplyService,
        private readonly migrationService: ConfigMigrationService,
        private readonly ownershipService: ConfigOwnershipService,
        private readonly auditLogService: AuditLogService,
        private readonly journal: ConfigImportJournalService,
        private readonly folderBundleService: ConfigFolderBundleService,
    ) {}

    @Get("export")
    @ApiOperation({ summary: "Export the current tenant configuration" })
    async export(
        @Token() token: TokenPayload,
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
        @Query("format") format: "json" | "zip" = "json",
    ) {
        const tenantId = requireTenantContext(token);
        const bundle = await this.bundleService.exportBundle(tenantId);
        await this.auditLogService.record({
            tenantId,
            actionType: "config_bundle_exported",
            actor: resolveAuditActor(token),
            after: {
                resourceCount: bundle.documents.length,
                requirementCount: bundle.manifest.requirements.length,
            },
            requestMeta: extractRequestMeta(request),
        });
        if (format === "zip") {
            response.type("application/zip");
            response.setHeader(
                "Content-Disposition",
                `attachment; filename="eudiplo-config-${tenantId}.zip"`,
            );
            response.send(this.archiveService.encode(bundle));
            return;
        }
        if (format !== "json") {
            throw new BadRequestException("Unsupported bundle format");
        }
        return bundle;
    }

    @Post("plan")
    @ApiOperation({
        summary: "Plan and validate a tenant configuration import",
    })
    plan(
        @Token() token: TokenPayload,
        @Body() bundle: ConfigBundle,
        @Query("mode") mode: ConfigImportMode = "upsert",
    ) {
        this.assertMode(mode);
        this.assertBundlePrivilegedRoleAuthorization(token, bundle);
        return this.bundleService.plan(
            requireTenantContext(token),
            bundle,
            mode,
        );
    }

    @Post("plan/archive")
    @UseInterceptors(
        FileInterceptor("bundle", { limits: { fileSize: 50 * 1024 * 1024 } }),
    )
    @ApiConsumes("multipart/form-data")
    @ApiOperation({ summary: "Plan an import from a configuration ZIP" })
    planArchive(
        @Token() token: TokenPayload,
        @UploadedFile() file: { buffer: Buffer } | undefined,
        @Query("mode") mode: ConfigImportMode = "upsert",
    ) {
        this.assertMode(mode);
        if (!file?.buffer)
            throw new BadRequestException("bundle file is required");
        const bundle = this.archiveService.decode(file.buffer);
        this.assertBundlePrivilegedRoleAuthorization(token, bundle);
        return this.bundleService.plan(
            requireTenantContext(token),
            bundle,
            mode,
        );
    }

    @ApiQuery({
        name: "planFingerprint",
        required: true,
        type: String,
        description: "Fingerprint from the reviewed plan",
    })
    @Post("import")
    @ApiOperation({ summary: "Apply a validated tenant configuration bundle" })
    async import(
        @Token() token: TokenPayload,
        @Req() request: Request,
        @Body() bundle: ConfigBundle,
        @Query("mode") mode: ConfigImportMode = "upsert",
        @Query("confirmReplace") confirmReplace?: string,
        @Query("planFingerprint") planFingerprint?: string,
    ) {
        return this.applyAndAudit(
            token,
            request,
            bundle,
            mode,
            confirmReplace,
            planFingerprint,
        );
    }

    @ApiQuery({
        name: "planFingerprint",
        required: true,
        type: String,
        description: "Fingerprint from the reviewed plan",
    })
    @Post("import/archive")
    @UseInterceptors(
        FileInterceptor("bundle", { limits: { fileSize: 50 * 1024 * 1024 } }),
    )
    @ApiConsumes("multipart/form-data")
    @ApiOperation({ summary: "Apply a configuration ZIP" })
    importArchive(
        @Token() token: TokenPayload,
        @Req() request: Request,
        @UploadedFile() file: { buffer: Buffer } | undefined,
        @Query("mode") mode: ConfigImportMode = "upsert",
        @Query("confirmReplace") confirmReplace?: string,
        @Query("planFingerprint") planFingerprint?: string,
    ) {
        if (!file?.buffer)
            throw new BadRequestException("bundle file is required");
        const bundle = this.archiveService.decode(file.buffer);
        this.assertBundlePrivilegedRoleAuthorization(token, bundle);
        return this.applyAndAudit(
            token,
            request,
            bundle,
            mode,
            confirmReplace,
            planFingerprint,
        );
    }

    private assertBundlePrivilegedRoleAuthorization(
        token: TokenPayload,
        bundle: ConfigBundle,
    ) {
        if (token.roles.includes(Role.Tenants)) return;

        const privilegedRoles = new Set([Role.Tenants, Role.TenantAdmin]);
        for (const document of bundle.documents ?? []) {
            const roles = Array.isArray(document?.spec?.roles)
                ? document.spec.roles
                : [];
            if (
                roles.some(
                    (role) =>
                        typeof role === "string" &&
                        privilegedRoles.has(role as Role),
                )
            ) {
                throw new ForbiddenException(
                    "Cannot assign tenant:manage role without having tenant:manage privileges",
                );
            }
        }
    }

    private async applyAndAudit(
        token: TokenPayload,
        request: Request,
        bundle: ConfigBundle,
        mode: ConfigImportMode,
        confirmReplace?: string,
        planFingerprint?: string,
    ) {
        this.assertMode(mode);
        this.assertBundlePrivilegedRoleAuthorization(token, bundle);
        if (mode === "replace" && confirmReplace !== "true") {
            throw new BadRequestException(
                "replace mode requires confirmReplace=true",
            );
        }
        const tenantId = requireTenantContext(token);
        if (!planFingerprint || !/^[a-f0-9]{64}$/.test(planFingerprint))
            throw new BadRequestException(
                "A planFingerprint from a reviewed plan is required",
            );
        const plan = await this.applyService.apply(
            tenantId,
            bundle,
            mode,
            undefined,
            planFingerprint,
        );
        await this.auditLogService.record({
            tenantId,
            actionType: "config_bundle_imported",
            actor: resolveAuditActor(token),
            after: {
                mode,
                resources: plan.items.map((item) => ({
                    kind: item.kind,
                    id: item.id,
                    action: item.action,
                })),
            },
            requestMeta: extractRequestMeta(request),
        });
        if (plan.generatedSecrets?.length) {
            await this.auditLogService.record({
                tenantId,
                actionType: "config_client_secret_generated",
                actor: resolveAuditActor(token),
                after: {
                    clients: plan.generatedSecrets.map(({ id }) => id),
                    count: plan.generatedSecrets.length,
                },
                requestMeta: extractRequestMeta(request),
            });
        }
        return plan;
    }

    @Get("operations")
    @ApiOperation({ summary: "List recent configuration operations" })
    operations(@Token() token: TokenPayload) {
        return this.journal.list(requireTenantContext(token));
    }

    @Get("operations/:id")
    @ApiOperation({ summary: "Read a durable configuration operation report" })
    operation(@Token() token: TokenPayload, @Param("id") id: string) {
        return this.journal.get(requireTenantContext(token), id);
    }

    @Post("operations/:id/acknowledge-interruption")
    @ApiOperation({
        summary:
            "Release an interrupted operation after its worker has been stopped",
    })
    acknowledgeInterruption(
        @Token() token: TokenPayload,
        @Param("id") id: string,
        @Query("confirmWorkerStopped") confirmed?: string,
    ) {
        if (confirmed !== "true")
            throw new BadRequestException(
                "Stop the original worker before setting confirmWorkerStopped=true",
            );
        return this.journal.acknowledgeInterruption(
            requireTenantContext(token),
            id,
        );
    }

    @Post("documents/upgrade")
    @ApiOperation({ summary: "Upgrade one configuration document" })
    upgrade(@Body() input: ConfigFile) {
        const result = this.migrationService.upgrade(input);
        return { ...result, document: serializeDocument(result.document) };
    }

    @Get("resources")
    @ApiOperation({ summary: "List configuration resource ownership" })
    resources(@Token() token: TokenPayload) {
        return this.ownershipService.list(requireTenantContext(token));
    }

    @Post("resources/:kind/:id/detach")
    @ApiOperation({ summary: "Detach a resource from file provisioning" })
    async detach(
        @Token() token: TokenPayload,
        @Req() request: Request,
        @Param("kind") rawKind: string,
        @Param("id") id: string,
    ) {
        const kind = this.assertKind(rawKind);
        const tenantId = requireTenantContext(token);
        const metadata = await this.journal.run(tenantId, "detach", async () =>
            this.ownershipService.detach(tenantId, kind, id),
        );
        await this.auditLogService.record({
            tenantId,
            actionType: "config_resource_detached",
            actor: resolveAuditActor(token),
            after: { kind, id },
            requestMeta: extractRequestMeta(request),
        });
        return metadata;
    }

    @Post("resources/:kind/:id/reattach/plan")
    @ApiOperation({
        summary:
            "Plan resetting a resource to its version in the config folder",
    })
    planReattach(
        @Token() token: TokenPayload,
        @Param("kind") rawKind: string,
        @Param("id") id: string,
    ) {
        return this.folderBundleService.planReattach(
            requireTenantContext(token),
            this.assertKind(rawKind),
            id,
        );
    }

    @ApiQuery({
        name: "planFingerprint",
        required: true,
        type: String,
        description: "Fingerprint from the reviewed reattach plan",
    })
    @Post("resources/:kind/:id/reattach")
    @ApiOperation({
        summary:
            "Reset a resource to its version in the config folder and make it file-managed again",
    })
    async reattach(
        @Token() token: TokenPayload,
        @Req() request: Request,
        @Param("kind") rawKind: string,
        @Param("id") id: string,
        @Query("planFingerprint") planFingerprint?: string,
    ) {
        const kind = this.assertKind(rawKind);
        if (!planFingerprint || !/^[a-f0-9]{64}$/.test(planFingerprint))
            throw new BadRequestException(
                "A planFingerprint from a reviewed plan is required",
            );
        const tenantId = requireTenantContext(token);
        const plan = await this.folderBundleService.reattach(
            tenantId,
            kind,
            id,
            planFingerprint,
        );
        await this.auditLogService.record({
            tenantId,
            actionType: "config_resource_reattached",
            actor: resolveAuditActor(token),
            after: {
                kind,
                id,
                action: plan.items[0]?.action,
                operationId: plan.operationId,
            },
            requestMeta: extractRequestMeta(request),
        });
        return plan;
    }

    private assertKind(kind: string): ConfigResourceKind {
        if (!CONFIG_RESOURCE_KINDS.includes(kind as ConfigResourceKind)) {
            throw new BadRequestException(`Unsupported resource kind: ${kind}`);
        }
        return kind as ConfigResourceKind;
    }

    private assertMode(mode: string): asserts mode is ConfigImportMode {
        if (!["create", "upsert", "replace"].includes(mode)) {
            throw new BadRequestException("Unsupported import mode");
        }
    }
}
