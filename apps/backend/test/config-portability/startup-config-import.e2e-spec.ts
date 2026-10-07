import { createHash } from "node:crypto";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    CONFIG_SINGLETON_IDS,
    normalizeDocument,
    resourceId,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { StatusListEntity } from "../../src/issuer/status-list/entities/status-list.entity.js";
import { ConfigBundleService } from "../../src/platform/config-portability/config-bundle.service.js";
import { ConfigBundleApplyService } from "../../src/platform/config-portability/config-bundle-apply.service.js";
import { ConfigBundleArchiveService } from "../../src/platform/config-portability/config-bundle-archive.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";

describe("startup configuration reconciliation", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    const originalEnvironment = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        FOLDER: process.env.FOLDER,
    };

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-startup-config-"));
        const configRoot = join(runtimeFolder, "config");
        mkdirSync(configRoot);
        cpSync(
            resolve(__dirname, "../../../../assets/config/demo"),
            join(configRoot, "demo"),
            { recursive: true },
        );
        cpSync(
            resolve(__dirname, "../fixtures/haip"),
            join(configRoot, "haip"),
            { recursive: true },
        );
        process.env.CONFIG_FOLDER = configRoot;
        process.env.CONFIG_IMPORT_MODE = "create";
        process.env.FOLDER = runtimeFolder;

        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
    }, 30_000);

    afterAll(async () => {
        await app?.close();
        rmSync(runtimeFolder, { recursive: true, force: true });
        restoreEnvironment("CONFIG_FOLDER", originalEnvironment.CONFIG_FOLDER);
        restoreEnvironment(
            "CONFIG_IMPORT_MODE",
            originalEnvironment.CONFIG_IMPORT_MODE,
        );
        restoreEnvironment("FOLDER", originalEnvironment.FOLDER);
    });

    it("rejects bundle imports that assign tenant-scoped administrators the global tenant-manager role", async () => {
        const appConfig = app.get(ConfigService);
        const rootClientId = appConfig.getOrThrow<string>("AUTH_CLIENT_ID");
        const rootClientSecret =
            appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET");

        const bootstrap = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: rootClientId,
                client_secret: rootClientSecret,
            })
            .expect(201);

        const attackerTenant = await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: "bundle-role-check-tenant",
                name: "Bundle role check tenant",
                roles: ["tenant:admin"],
            })
            .expect(201);

        const attackerToken = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: attackerTenant.body.client.clientId,
                client_secret: attackerTenant.body.client.clientSecret,
            })
            .expect(201);

        const bundle = {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion: "bundle-role-check",
                exportedAt: new Date(0).toISOString(),
                tenant: "bundle-role-check-tenant",
                resources: [
                    {
                        kind: "Client",
                        id: "bundle-escalated-client",
                        $schema:
                            "https://eudiplo.dev/schemas/v2/Client.schema.json",
                        path: "clients/bundle-escalated-client.json",
                        sha256: createHash("sha256")
                            .update(
                                JSON.stringify({
                                    $schema:
                                        "https://eudiplo.dev/schemas/v2/Client.schema.json",
                                    metadata: { generation: 1 },
                                    spec: {
                                        clientId: "bundle-escalated-client",
                                        secret: "bundle-escalated-secret",
                                        roles: ["tenants:manage"],
                                    },
                                }),
                            )
                            .digest("hex"),
                        ownership: "unmanaged",
                        generation: 1,
                    },
                ],
                assets: [],
                requirements: [],
                warnings: [],
            },
            documents: [
                {
                    $schema:
                        "https://eudiplo.dev/schemas/v2/Client.schema.json",
                    metadata: { generation: 1 },
                    spec: {
                        clientId: "bundle-escalated-client",
                        secret: "bundle-escalated-secret",
                        roles: ["tenants:manage"],
                    },
                },
            ],
            assets: [],
        };

        await request(app.getHttpServer())
            .post("/config-bundles/plan?mode=upsert")
            .set("Authorization", `Bearer ${attackerToken.body.access_token}`)
            .send(bundle)
            .expect(403)
            .expect((response) => {
                expect(response.body.message).toContain("tenant:manage");
            });
    });

    it("imports the demo folder through the versioned plan/apply pipeline", async () => {
        const configRoot = app
            .get(ConfigService)
            .getOrThrow<string>("CONFIG_FOLDER");
        const bundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("demo", join(configRoot, "demo"));
        const plan = await app
            .get(ConfigBundleService)
            .plan(
                "demo",
                bundle,
                "create",
                `folder:${join(configRoot, "demo")}`,
            );
        expect(plan.applicable, JSON.stringify(plan, null, 2)).toBe(true);
        const metadata = await app.get(ConfigOwnershipService).list("demo");

        expect(metadata).toHaveLength(16);
        expect(metadata).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "Tenant",
                    resourceId: "tenant",
                    ownership: "file-managed",
                }),
                expect.objectContaining({
                    kind: "PresentationConfig",
                    resourceId: "age-over-18",
                    ownership: "file-managed",
                }),
            ]),
        );
        expect(
            metadata.every((entry) => entry.source?.startsWith("folder:")),
        ).toBe(true);

        rmSync(
            join(
                configRoot,
                "demo/trust-lists/trustlist-580831bc-ef11-43f4-a3be-a2b6bf1b29a3-config.json",
            ),
        );
        const replaceBundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("demo", join(configRoot, "demo"));
        const replacePlan = await app
            .get(ConfigBundleService)
            .plan(
                "demo",
                replaceBundle,
                "replace",
                `folder:${join(configRoot, "demo")}`,
            );
        expect(replacePlan.applicable).toBe(false);
        expect(replacePlan.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "MISSING_RESOURCE_REFERENCE",
                    resource: {
                        kind: "PresentationConfig",
                        id: "pid",
                    },
                }),
            ]),
        );
    });

    it("exports schema documents in a version 2 bundle and packs matching checksums", async () => {
        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle("demo");
        expect(bundle.manifest.formatVersion).toBe(2);
        for (const document of bundle.documents) {
            expect(document.kind).toBeUndefined();
            expect(document.apiVersion).toBeUndefined();
            expect(document.metadata).not.toHaveProperty("id");
            const { kind } = normalizeDocument(document);
            // Each resource is exported in its current format version.
            expect(document.$schema).toBe(schemaUrl(kind));
            if (!CONFIG_SINGLETON_IDS[kind]) {
                expect(
                    document.spec[kind === "Client" ? "clientId" : "id"],
                ).toBe(resourceId(document));
            }
        }
        const archive = app.get(ConfigBundleArchiveService);
        expect(archive.decode(archive.encode(bundle))).toEqual(bundle);
        const plan = await service.plan("demo", bundle, "create");
        expect(
            plan.issues.filter(
                (issue) => issue.code === "CONFIG_SCHEMA_VALIDATION_FAILED",
            ),
        ).toEqual([]);
    });

    it("reapplying matching definitions preserves live status data and ownership timestamps", async () => {
        const root = join(
            app.get(ConfigService).getOrThrow<string>("CONFIG_FOLDER"),
            "haip",
        );
        const bundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("haip", root);
        const service = app.get(ConfigBundleService);
        const plan = await service.plan(
            "haip",
            bundle,
            "upsert",
            `folder:${root}`,
        );
        const unchanged = plan.items.filter((item) =>
            [
                "PresentationConfig",
                "StatusList",
                "AttributeProvider",
                "WebhookEndpoint",
            ].includes(item.kind),
        );
        expect(unchanged.length).toBeGreaterThan(0);
        expect(unchanged, JSON.stringify(plan.items, null, 2)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "StatusList",
                    action: "unchanged",
                }),
            ]),
        );
        const resource = plan.items.find((item) => item.kind === "StatusList")!;
        const repository = app.get(DataSource).getRepository(StatusListEntity);
        const stored = await repository.findOneByOrFail({
            tenantId: "haip",
            id: resource.id,
        });
        stored.elements[0] = 1;
        await repository.save(stored);
        const ownership = app.get(ConfigOwnershipService);
        const before = await ownership.get("haip", "StatusList", resource.id);
        // Apply only matching resources: explicit key regeneration remains a write.
        const identities = new Set(
            plan.items
                .filter((item) => item.action === "unchanged")
                .map((item) => `${item.kind}/${item.id}`),
        );
        const selected = bundle.manifest.resources.filter((item) =>
            identities.has(`${item.kind}/${item.id}`),
        );
        bundle.manifest.resources = selected;
        bundle.documents = bundle.documents.filter((document) =>
            selected.some(
                (item) =>
                    item.$schema === document.$schema &&
                    item.id === resourceId(document),
            ),
        );
        await app
            .get(ConfigBundleApplyService)
            .apply("haip", bundle, "upsert", `folder:${root}`);
        expect(
            (
                await repository.findOneByOrFail({
                    tenantId: "haip",
                    id: resource.id,
                })
            ).elements[0],
        ).toBe(1);
        expect(
            (await ownership.get("haip", "StatusList", resource.id))
                .lastAppliedAt,
        ).toEqual(before.lastAppliedAt);
    });

    it("binds a reviewed plan to current target configuration and records the rejected run", async () => {
        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle("demo");
        bundle.manifest.resources = bundle.manifest.resources.filter(
            (resource) => resource.kind === "Tenant",
        );
        bundle.documents = bundle.documents.filter((document) =>
            document.$schema?.endsWith("/TenantConfigFile.schema.json"),
        );
        bundle.assets = [];
        bundle.manifest.assets = [];
        const reviewed = await service.plan("demo", bundle, "upsert");
        expect(reviewed.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(
            (await service.plan("demo", bundle, "upsert")).planFingerprint,
        ).toBe(reviewed.planFingerprint);
        const repository = app.get(DataSource).getRepository(TenantEntity);
        const tenant = await repository.findOneByOrFail({ id: "demo" });
        await repository.update({ id: "demo" }, { name: "Concurrent edit" });
        try {
            await expect(
                app
                    .get(ConfigBundleApplyService)
                    .apply(
                        "demo",
                        bundle,
                        "upsert",
                        undefined,
                        reviewed.planFingerprint,
                    ),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_PLAN_STALE",
                }),
            });
            expect(
                (await repository.findOneByOrFail({ id: "demo" })).name,
            ).toBe("Concurrent edit");
        } finally {
            await repository.update({ id: "demo" }, { name: tenant.name });
        }
    });

    it("rolls back tenant settings if their ownership write fails", async () => {
        const bundle = await app.get(ConfigBundleService).exportBundle("demo");
        bundle.manifest.resources = bundle.manifest.resources.filter(
            (resource) => resource.kind === "Tenant",
        );
        bundle.documents = bundle.documents.filter((document) =>
            document.$schema?.endsWith("/TenantConfigFile.schema.json"),
        );
        bundle.assets = [];
        bundle.manifest.assets = [];
        const document = bundle.documents[0];
        const repository = app.get(DataSource).getRepository(TenantEntity);
        const before = await repository.findOneByOrFail({ id: "demo" });
        document.spec.name = "Should roll back";
        bundle.manifest.resources[0].sha256 = createHash("sha256")
            .update(JSON.stringify(document))
            .digest("hex");
        const spy = vi
            .spyOn(app.get(ConfigOwnershipService), "markApplied")
            .mockRejectedValueOnce(new Error("Injected ownership failure"));
        try {
            await expect(
                app
                    .get(ConfigBundleApplyService)
                    .apply("demo", bundle, "upsert"),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_APPLY_FAILED",
                }),
            });
            expect(
                (await repository.findOneByOrFail({ id: "demo" })).name,
            ).toBe(before.name);
        } finally {
            spy.mockRestore();
        }
    });

    it("accepts the HAIP OIDF configuration fixtures", async () => {
        const configRoot = app
            .get(ConfigService)
            .getOrThrow<string>("CONFIG_FOLDER");
        const tenantRoot = join(configRoot, "haip");
        const bundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("haip", tenantRoot);
        const plan = await app
            .get(ConfigBundleService)
            .plan("haip", bundle, "create", `folder:${tenantRoot}`);

        expect(bundle.manifest.resources).toHaveLength(23);
        const documents = jsonFiles(tenantRoot)
            .filter((path) => path !== join(tenantRoot, "info.json"))
            .map((path) => JSON.parse(readFileSync(path, "utf8")));
        expect(documents).toHaveLength(23);
        for (const document of documents) {
            expect(document).toMatchObject({
                $schema: expect.stringMatching(
                    /^https:\/\/eudiplo\.dev\/schemas\/v\d+\/.+ConfigFile\.schema\.json$/,
                ),
                metadata: { generation: 1 },
                spec: expect.any(Object),
            });
        }
        expect(plan.applicable, JSON.stringify(plan, null, 2)).toBe(true);
        expect(await app.get(ConfigOwnershipService).list("haip")).toHaveLength(
            24,
        );
    });
});

function restoreEnvironment(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

function jsonFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return jsonFiles(path);
        return entry.name.endsWith(".json") ? [path] : [];
    });
}
