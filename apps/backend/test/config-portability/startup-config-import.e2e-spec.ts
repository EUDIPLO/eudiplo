import { createHash, webcrypto } from "node:crypto";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
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
import * as x509 from "@peculiar/x509";
import { compare as compareSecret } from "bcrypt";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditLogEntity } from "../../src/audit-log/entities/audit-log.entity.js";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { KmsTenantConfigService } from "../../src/crypto/key/kms/kms-tenant-config.service.js";
import { CredentialConfig } from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";
import { StatusListEntity } from "../../src/issuer/status-list/entities/status-list.entity.js";
import { ConfigBundleService } from "../../src/platform/config-portability/config-bundle.service.js";
import { ConfigBundleApplyService } from "../../src/platform/config-portability/config-bundle-apply.service.js";
import { ConfigBundleArchiveService } from "../../src/platform/config-portability/config-bundle-archive.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
} from "../../src/platform/config-portability/config-resource.types.js";
import { ConfigResourceMetadataEntity } from "../../src/platform/config-portability/entities/config-resource-metadata.entity.js";
import { RegistrarConfigEntity } from "../../src/registrar/entities/registrar-config.entity.js";
import { documentBundle } from "../shared/config-bundle.js";

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
                expect(response.body.message).toContain(
                    "Cannot grant tenants:manage",
                );
            });
    });

    it("shows a manage role the ownership of the kinds it changes, in its own tenant only", async () => {
        const server = app.getHttpServer();
        const appConfig = app.get(ConfigService);
        const tokenFor = async (clientId: string, clientSecret: string) => {
            const response = await request(server)
                .post("/api/oauth2/token")
                .send({
                    grant_type: "client_credentials",
                    client_id: clientId,
                    client_secret: clientSecret,
                })
                .expect(201);
            return `Bearer ${response.body.access_token}`;
        };
        // The demo client with presentation:request and presentation:manage only.
        const verifier = await tokenFor(
            "presentation-test",
            "presentation-test-secret",
        );

        const response = await request(server)
            .get("/config-bundles/resources/PresentationConfig")
            .set("Authorization", verifier)
            .expect(200);
        const demoConfigs = (await app.get(ConfigOwnershipService).list("demo"))
            .filter((entry) => entry.kind === "PresentationConfig")
            .map((entry) => entry.resourceId);
        const ids = response.body.map((entry: any) => entry.resourceId);
        expect(ids).toEqual(demoConfigs);
        // The haip tenant's own configs stay invisible.
        expect(ids).not.toContain("kyc");
        expect(response.body).toContainEqual({
            kind: "PresentationConfig",
            resourceId: "pid",
            ownership: "file-managed",
            generation: 1,
            source: expect.any(String),
            lastAppliedAt: expect.any(String),
        });

        for (const kind of ["CredentialConfig", "Client", "KmsConfig"]) {
            await request(server)
                .get(`/config-bundles/resources/${kind}`)
                .set("Authorization", verifier)
                .expect(403);
        }
        await request(server)
            .get("/config-bundles/resources/Unknown")
            .set("Authorization", verifier)
            .expect(400);
        await request(server)
            .get("/config-bundles/resources")
            .set("Authorization", verifier)
            .expect(403);

        const root = await tokenFor(
            appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
            appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
        );
        await request(server)
            .get("/config-bundles/resources/PresentationConfig")
            .set("Authorization", root)
            .expect(403);
    });

    it("exports resources created without optional fields as a bundle that passes its own schema validation", async () => {
        const appConfig = app.get(ConfigService);
        const bootstrap = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        const tenantId = "export-without-description";
        const tenant = await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: tenantId,
                name: "Export without description",
                roles: ["tenant:admin", "issuance:manage"],
            })
            .expect(201);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.body.client.clientId,
                client_secret: tenant.body.client.clientSecret,
            })
            .expect(201);
        const authorization = `Bearer ${token.body.access_token}`;
        await request(app.getHttpServer())
            .post("/client")
            .set("Authorization", authorization)
            .send({ clientId: "no-description", roles: ["issuance:offer"] })
            .expect(201);
        const issuerKeyChain = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", authorization)
            .send({ usageType: "attestation", type: "standalone" })
            .expect(201);
        const signerKeyChain = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", authorization)
            .send({ usageType: "trustList", type: "standalone" })
            .expect(201);
        const trustList = await request(app.getHttpServer())
            .post("/trust-list")
            .set("Authorization", authorization)
            .send({
                keyChainId: signerKeyChain.body.id,
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId: issuerKeyChain.body.id,
                        revocationKeyChainId: issuerKeyChain.body.id,
                        info: { name: "Issuer" },
                    },
                ],
            })
            .expect(201);
        // Without display, and a status list without a key chain.
        await request(app.getHttpServer())
            .post("/issuer/config")
            .set("Authorization", authorization)
            .send({})
            .expect(201);
        const statusList = await request(app.getHttpServer())
            .post("/status-lists")
            .set("Authorization", authorization)
            .send({})
            .expect(201);
        const created = new Set([
            "Tenant/tenant",
            "Client/no-description",
            `KeyChain/${issuerKeyChain.body.id}`,
            `KeyChain/${signerKeyChain.body.id}`,
            `TrustList/${trustList.body.id}`,
            "IssuanceConfig/issuance",
            `StatusList/${statusList.body.id}`,
        ]);

        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle(tenantId);
        const exported = bundle.documents.filter((document) =>
            created.has(
                `${normalizeDocument(document).kind}/${resourceId(document)}`,
            ),
        );
        expect(exported).toHaveLength(created.size);
        for (const document of exported) {
            const kind = normalizeDocument(document).kind;
            expect(document.spec).not.toHaveProperty("description");
            if (kind === "KeyChain")
                expect(document.spec.rotationPolicy).toEqual({
                    enabled: false,
                });
            if (kind === "IssuanceConfig")
                expect(document.spec).not.toHaveProperty("display");
            if (kind === "StatusList")
                expect(document.spec).not.toHaveProperty("keyChainId");
        }
        const plan = await service.plan(tenantId, bundle, "upsert");
        expect(
            plan.issues.filter((issue) =>
                [
                    "CONFIG_SCHEMA_VALIDATION_FAILED",
                    "CURRENT_SCHEMA_VALIDATION_FAILED",
                ].includes(issue.code),
            ),
            JSON.stringify(plan.issues, null, 2),
        ).toEqual([]);
        // Client and key chains are blocked on their secret and private key
        // requirements, so only these reach the comparison.
        expect(
            plan.items
                .filter((item) =>
                    [
                        "Tenant",
                        "TrustList",
                        "IssuanceConfig",
                        "StatusList",
                    ].includes(item.kind),
                )
                .map(({ kind, action }) => ({ kind, action }))
                .sort((left, right) => left.kind.localeCompare(right.kind)),
        ).toEqual([
            { kind: "IssuanceConfig", action: "unchanged" },
            { kind: "StatusList", action: "unchanged" },
            { kind: "Tenant", action: "unchanged" },
            { kind: "TrustList", action: "unchanged" },
        ]);
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
        // The deleted list is blocked as well, naming every configuration
        // that still uses it, so its deletion never happens unchecked.
        const trustListItem = replacePlan.items.find(
            (item) => item.kind === "TrustList",
        );
        expect(trustListItem?.action).toBe("blocked");
        expect(trustListItem?.issues).toEqual([
            {
                severity: "error",
                code: "TRUST_LIST_IN_USE",
                path: "/metadata/id",
                message: `Trust list "580831bc-ef11-43f4-a3be-a2b6bf1b29a3" is left out of this import, so replace mode deletes it, but it is still referenced by 2 presentation configs ("age-over-18" and "pid"). Keep the trust list in the bundle or folder, or remove these references.`,
                resource: {
                    kind: "TrustList",
                    id: "580831bc-ef11-43f4-a3be-a2b6bf1b29a3",
                },
            },
        ]);
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

    it("round-trips a credential configuration with an x509 schema metadata authority", async () => {
        const appConfig = app.get(ConfigService);
        const tenantId = "x509-schema-meta";
        // Not getToken from ../utils.js: it imports AppModule statically, which
        // reads the configuration before beforeAll sets CONFIG_FOLDER and
        // CONFIG_IMPORT_MODE, so the startup import of this suite never runs.
        const bootstrap = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        const tenant = await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: tenantId,
                name: "x509 schema metadata tenant",
                roles: ["issuance:manage"],
            })
            .expect(201);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.body.client.clientId,
                client_secret: tenant.body.client.clientSecret,
            })
            .expect(201)
            .then((response) => response.body.access_token);
        // What publishing schema metadata with this credentialConfigId links.
        const schemaMeta = {
            id: "https://schemas.example/pid",
            name: "PID",
            version: "1.0.0",
            attestationLoS: "iso_18045_high",
            bindingType: "key",
            trustedAuthorities: [
                {
                    frameworkType: "x509",
                    value: Buffer.from("root certificate").toString("base64"),
                },
            ],
        };
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .set("Authorization", `Bearer ${token}`)
            .send({
                id: "pid",
                config: { format: "dc+sd-jwt", display: [] },
                fields: [],
                schemaMeta,
            })
            .expect(201);

        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle(tenantId);
        const exported = bundle.documents.find(
            (document) =>
                normalizeDocument(document).kind === "CredentialConfig",
        );
        expect(exported?.$schema).toBe(schemaUrl("CredentialConfig"));
        expect(exported?.spec.schemaMeta).toMatchObject(schemaMeta);
        const plan = await service.plan(tenantId, bundle, "upsert");
        expect(
            plan.issues.filter(
                (issue) => issue.resource?.kind === "CredentialConfig",
            ),
        ).toEqual([]);
    });

    it("refuses unsupported constraint keywords and leaves stored ones out of exports", async () => {
        const appConfig = app.get(ConfigService);
        const tenantId = "claim-constraints";
        const bootstrap = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        const tenant = await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: tenantId,
                name: "Claim constraints tenant",
                roles: ["issuance:manage"],
            })
            .expect(201);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.body.client.clientId,
                client_secret: tenant.body.client.clientSecret,
            })
            .expect(201)
            .then((response) => response.body.access_token);
        const widget = {
            formlyConfig: {
                template: "<img src=x onerror=alert(1)>",
                props: { safeHtml: true },
            },
        };
        const field = (constraints: Record<string, unknown>) => ({
            path: ["birth_date"],
            type: "string",
            constraints,
        });
        const config = (constraints: Record<string, unknown>) => ({
            id: "pid",
            config: { format: "dc+sd-jwt", display: [] },
            fields: [field(constraints)],
        });

        const refused = await request(app.getHttpServer())
            .post("/issuer/credentials")
            .set("Authorization", `Bearer ${token}`)
            .send(config({ pattern: "^\\d{4}$", widget }))
            .expect(400);
        expect(refused.body.errors).toEqual([
            expect.objectContaining({
                path: ["fields", 0, "constraints"],
                message:
                    "Unsupported JSON Schema keyword(s) in constraints: widget",
            }),
        ]);
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .set("Authorization", `Bearer ${token}`)
            .send(config({ pattern: "^\\d{4}$" }))
            .expect(201);
        await request(app.getHttpServer())
            .patch("/issuer/credentials/pid")
            .set("Authorization", `Bearer ${token}`)
            .send({ fields: [field({ items: { widget } })] })
            .expect(400);

        // A configuration stored before CredentialConfig v3 refused the key
        await app
            .get(DataSource)
            .getRepository(CredentialConfig)
            .update(
                { tenantId, id: "pid" },
                { fields: [field({ pattern: "^\\d{4}$", widget })] as never },
            );
        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle(tenantId);
        const exported = bundle.documents.find(
            (document) =>
                normalizeDocument(document).kind === "CredentialConfig",
        );
        expect(exported?.spec.fields).toEqual([field({ pattern: "^\\d{4}$" })]);
        const plan = await service.plan(tenantId, bundle, "upsert");
        expect(
            plan.issues.filter(
                (issue) => issue.resource?.kind === "CredentialConfig",
            ),
        ).toEqual([]);
        // The stored key is ignored like the export ignores it, so the export
        // re-imports as unchanged and the row keeps it
        expect(
            plan.items.find((item) => item.kind === "CredentialConfig"),
        ).toMatchObject({ action: "unchanged" });
    });

    it("plans resources with unchanged image references as unchanged", async () => {
        const root = join(
            app.get(ConfigService).getOrThrow<string>("CONFIG_FOLDER"),
            "haip",
        );
        const bundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("haip", root);
        const plan = await app
            .get(ConfigBundleService)
            .plan("haip", bundle, "upsert", `folder:${root}`);
        // The folder references company.png; storage holds its public URL.
        const issuance = plan.items.find(
            (item) => item.kind === "IssuanceConfig",
        );
        expect(issuance, JSON.stringify(plan.items, null, 2)).toMatchObject({
            action: "unchanged",
        });
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
        // The startup import applied these key chains from this folder.
        const keyChains = plan.items.filter((item) => item.kind === "KeyChain");
        expect(keyChains.length).toBeGreaterThan(0);
        expect(keyChains.map(({ id, action }) => ({ id, action }))).toEqual(
            keyChains.map(({ id }) => ({ id, action: "unchanged" })),
        );
        // Apply only matching resources.
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

        expect(bundle.manifest.resources).toHaveLength(24);
        const documents = jsonFiles(tenantRoot)
            .filter((path) => path !== join(tenantRoot, "info.json"))
            .map((path) => JSON.parse(readFileSync(path, "utf8")));
        expect(documents).toHaveLength(24);
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
            25,
        );
    });

    it("skips detached or diverged resources at startup and reattaches them to the folder version", async () => {
        const root = join(
            app.get(ConfigService).getOrThrow<string>("CONFIG_FOLDER"),
            "haip",
        );
        const source = `folder:${root}`;
        const ownership = app.get(ConfigOwnershipService);
        const service = app.get(ConfigBundleService);
        const folder = app.get(ConfigFolderBundleService);
        const repository = app.get(DataSource).getRepository(IssuanceConfig);
        const startupPlan = async () =>
            service.plan(
                "haip",
                folder.buildBundle("haip", root),
                "upsert",
                source,
            );
        const issuanceItem = (plan: ConfigImportPlan) =>
            plan.items.find((item) => item.kind === "IssuanceConfig")!;

        // Detach and edit twice, as the UI would.
        await ownership.detach("haip", "IssuanceConfig", "issuance");
        await repository.update({ tenantId: "haip" }, { batchSize: 3 });
        await ownership.recordApiMutation(
            "haip",
            "IssuanceConfig",
            "issuance",
            false,
        );
        await ownership.recordApiMutation(
            "haip",
            "IssuanceConfig",
            "issuance",
            false,
        );
        expect(
            await ownership.get("haip", "IssuanceConfig", "issuance"),
        ).toMatchObject({ ownership: "detached", source, generation: 3 });

        let plan = await startupPlan();
        expect(plan.applicable, JSON.stringify(plan.issues)).toBe(true);
        expect(issuanceItem(plan)).toMatchObject({
            action: "skip",
            issues: [expect.objectContaining({ code: "RESOURCE_DETACHED" })],
        });

        // Resources detached before the detached state existed are plain
        // unmanaged with a newer generation; startup skips those too.
        await app
            .get(DataSource)
            .getRepository(ConfigResourceMetadataEntity)
            .update(
                {
                    tenantId: "haip",
                    kind: "IssuanceConfig",
                    resourceId: "issuance",
                },
                { ownership: "unmanaged", source: null as any },
            );
        plan = await startupPlan();
        expect(plan.applicable, JSON.stringify(plan.issues)).toBe(true);
        expect(issuanceItem(plan)).toMatchObject({
            action: "skip",
            issues: [
                expect.objectContaining({
                    code: "STALE_GENERATION",
                    severity: "warning",
                }),
            ],
        });
        // An uploaded bundle still has to resolve the conflict explicitly.
        plan = await service.plan(
            "haip",
            folder.buildBundle("haip", root),
            "upsert",
        );
        expect(plan.applicable).toBe(false);
        expect(issuanceItem(plan).action).toBe("blocked");

        const reattachPlan = await folder.planReattach(
            "haip",
            "IssuanceConfig",
            "issuance",
        );
        expect(reattachPlan.applicable).toBe(true);
        expect(reattachPlan.items).toEqual([
            expect.objectContaining({
                kind: "IssuanceConfig",
                action: "update",
            }),
        ]);
        expect(reattachPlan.assets?.map((asset) => asset.path)).toEqual([
            "images/company.png",
        ]);
        await folder.reattach(
            "haip",
            "IssuanceConfig",
            "issuance",
            reattachPlan.planFingerprint!,
        );
        expect(
            (await repository.findOneByOrFail({ tenantId: "haip" })).batchSize,
        ).toBe(10);
        expect(
            await ownership.get("haip", "IssuanceConfig", "issuance"),
        ).toMatchObject({ ownership: "file-managed", source, generation: 1 });
        const afterReattach = issuanceItem(await startupPlan());
        expect(afterReattach.issues).toEqual([]);
        expect(
            afterReattach.changes?.map((change) => change.path),
        ).not.toContain("/spec/batchSize");

        await expect(
            folder.planReattach("haip", "WebhookEndpoint", "missing"),
        ).rejects.toThrow("is not defined in the config folder");
    });

    it("applies a registrar configuration without contacting the registrar and removes omitted optional fields", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const registrars = dataSource.getRepository(RegistrarConfigEntity);
        // Unresolvable hosts: a credential check would fail the apply with 503.
        const spec = {
            registrarUrl: "https://registrar.example.invalid/api",
            oidcUrl: "https://auth.example.invalid/realms/registrar",
            clientId: "client",
            username: "user",
            password: "password",
        };
        const defaults = { privacy_policy: "https://rp.example/privacy" };
        const contact = { email: "support@rp.example" };
        const registrarItem = (plan: ConfigImportPlan) =>
            plan.items.find((item) => item.kind === "RegistrarConfig");

        try {
            const full = registrarBundle({
                ...spec,
                clientSecret: "client-secret",
                registrationCertificateDefaults: defaults,
                relyingPartyContact: contact,
            });
            expect(
                registrarItem(await service.plan("demo", full, "upsert"))
                    ?.action,
            ).toBe("create");
            await apply.apply("demo", full, "upsert");
            expect(
                await registrars.findOneByOrFail({ tenantId: "demo" }),
            ).toMatchObject({
                registrarUrl: spec.registrarUrl,
                clientSecret: "client-secret",
                registrationCertificateDefaults: defaults,
                relyingPartyContact: contact,
            });
            expect(
                registrarItem(await service.plan("demo", full, "upsert"))
                    ?.action,
            ).toBe("unchanged");

            const minimal = registrarBundle(spec);
            const replacement = registrarItem(
                await service.plan("demo", minimal, "upsert"),
            );
            expect(replacement?.action).toBe("update");
            expect(replacement?.changes?.map((change) => change.path)).toEqual([
                "/spec/clientSecret",
                "/spec/registrationCertificateDefaults/privacy_policy",
                "/spec/relyingPartyContact/email",
            ]);
            await apply.apply("demo", minimal, "upsert");
            expect(
                await registrars.findOneByOrFail({ tenantId: "demo" }),
            ).toMatchObject({
                clientSecret: null,
                registrationCertificateDefaults: null,
                relyingPartyContact: null,
            });
            expect(
                registrarItem(await service.plan("demo", minimal, "upsert"))
                    ?.action,
            ).toBe("unchanged");

            const exported = await service.exportBundle("demo");
            expect(
                exported.manifest.requirements
                    .filter(
                        (requirement) =>
                            requirement.resource?.kind === "RegistrarConfig",
                    )
                    .map((requirement) => requirement.path),
            ).toEqual(["/spec/password"]);
        } finally {
            await registrars.delete({ tenantId: "demo" });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "RegistrarConfig",
                });
        }
    });

    it("applies the description and rotation settings of a key chain document as the plan lists them", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const ca = await keyWithCertificate("Key chain CA", true);
        // A private key without active key goes through the key chain importer.
        const imported = {
            id: "replaced-imported-key",
            usageType: "attestation",
            kmsProvider: "db",
            keySource: { type: "private-jwk", jwk: ca.jwk },
            crt: [ca.certificate],
        };
        const stored = () =>
            keyChains.findOneByOrFail({ tenantId: "demo", id: imported.id });
        // Each import of a private key creates a new active key, which the
        // plan reports as well; only the replaced settings are checked here.
        const plannedSettings = async (bundle: ConfigBundle) =>
            (await service.plan("demo", bundle, "upsert")).items
                .find((item) => item.kind === "KeyChain")
                ?.changes?.filter(
                    ({ path }) =>
                        path === "/spec/description" ||
                        path.startsWith("/spec/rotationPolicy/"),
                )
                .map(({ path, after }) => ({ path, after }));

        try {
            await apply.apply(
                "demo",
                keyChainBundle({
                    ...imported,
                    description: "Imported CA",
                    rotationPolicy: {
                        enabled: true,
                        intervalDays: 30,
                        certValidityDays: 60,
                    },
                }),
                "upsert",
            );
            expect(await stored()).toMatchObject({
                description: "Imported CA",
                rotationEnabled: true,
                rotationIntervalDays: 30,
                certValidityDays: 60,
            });

            // With rotation, the importer fills in its default intervals.
            const defaults = keyChainBundle({
                ...imported,
                rotationPolicy: { enabled: true },
            });
            expect(await plannedSettings(defaults)).toEqual([
                { path: "/spec/description", after: undefined },
                { path: "/spec/rotationPolicy/certValidityDays", after: 365 },
                { path: "/spec/rotationPolicy/intervalDays", after: 90 },
            ]);
            await apply.apply("demo", defaults, "upsert");
            expect(await stored()).toMatchObject({
                description: null,
                rotationEnabled: true,
                rotationIntervalDays: 90,
                certValidityDays: 365,
            });

            // Without a rotation policy, rotation is off and has no intervals.
            const minimal = keyChainBundle(imported);
            expect(await plannedSettings(minimal)).toEqual([
                {
                    path: "/spec/rotationPolicy/certValidityDays",
                    after: undefined,
                },
                { path: "/spec/rotationPolicy/enabled", after: false },
                { path: "/spec/rotationPolicy/intervalDays", after: undefined },
            ]);
            await apply.apply("demo", minimal, "upsert");
            expect(await stored()).toMatchObject({
                description: null,
                rotationEnabled: false,
                rotationIntervalDays: null,
                certValidityDays: null,
            });
        } finally {
            await keyChains.delete({ tenantId: "demo", id: imported.id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "KeyChain",
                    resourceId: imported.id,
                });
        }
    });

    it("imports a private CA key with type internalChain as an internal chain without rotation", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const ca = await keyWithCertificate("Key chain CA", true);
        const document = {
            id: "imported-internal-chain",
            usageType: "attestation",
            kmsProvider: "db",
            type: "internalChain",
            keySource: { type: "private-jwk", jwk: ca.jwk },
            crt: [ca.certificate],
        };

        try {
            await apply.apply("demo", keyChainBundle(document), "upsert");
            const stored = await keyChains.findOneByOrFail({
                tenantId: "demo",
                id: document.id,
            });
            expect(stored.hasInternalCa()).toBe(true);
            expect(stored).toMatchObject({
                rootJwk: expect.objectContaining({ d: ca.jwk.d }),
                rootCertificate: ca.certificate,
                rotationEnabled: false,
            });
            expect(stored.activeJwk.d).not.toBe(ca.jwk.d);

            // The plan compares the type the import creates with the stored one.
            const changes = (
                await service.plan("demo", keyChainBundle(document), "upsert")
            ).items.find((item) => item.kind === "KeyChain")?.changes;
            expect(changes?.map(({ path }) => path)).not.toContain(
                "/spec/type",
            );
            // Without type and rotation, the import makes the CA key the
            // signing key, as in exports before key chain format v2.
            const { type: _, ...untyped } = document;
            const withoutType = (
                await service.plan("demo", keyChainBundle(untyped), "upsert")
            ).items.find((item) => item.kind === "KeyChain")?.changes;
            expect(withoutType).toContainEqual(
                expect.objectContaining({
                    path: "/spec/type",
                    before: "internalChain",
                    after: "standalone",
                }),
            );
        } finally {
            await keyChains.delete({ tenantId: "demo", id: document.id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "KeyChain",
                    resourceId: document.id,
                });
        }
    });

    it("imports a bare key chain export with type from a config folder, upgraded from KeyChain v2", async () => {
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const ca = await keyWithCertificate("Key chain CA", true);
        const id = "bare-internal-chain";
        const folder = join(runtimeFolder, "bare-key-chain-export");
        mkdirSync(join(folder, "key-chains"), { recursive: true });
        // The form of GET /api/key-chain/{id}/export.
        writeFileSync(
            join(folder, "key-chains", `${id}.json`),
            JSON.stringify({
                id,
                usageType: "attestation",
                type: "internalChain",
                key: ca.jwk,
                crt: [ca.certificate],
            }),
        );

        try {
            const bundle = app
                .get(ConfigFolderBundleService)
                .buildBundle("demo", folder);
            // Read as v2 (it has `type`), then upgraded to the current format.
            expect(bundle.documents[0].$schema).toBe(schemaUrl("KeyChain"));
            await apply.apply("demo", bundle, "upsert");

            const stored = await keyChains.findOneByOrFail({
                tenantId: "demo",
                id,
            });
            expect(stored.hasInternalCa()).toBe(true);
            expect(stored.rootCertificate).toBe(ca.certificate);
        } finally {
            rmSync(folder, { recursive: true, force: true });
            await keyChains.delete({ tenantId: "demo", id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({ tenantId: "demo", kind: "KeyChain", resourceId: id });
        }
    });

    it("keeps the keys of a key chain whose document did not change since it was applied", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const keyChainService = app.get(KeyChainService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const ca = await keyWithCertificate("Unchanged CA", true);
        // EUDIPLO creates the signing key of a CA key on every import.
        const externalCa = {
            id: "unchanged-external-ca",
            usageType: "attestation",
            kmsProvider: "db",
            keySource: { type: "private-jwk", jwk: ca.jwk },
            crt: [ca.certificate],
            rotationPolicy: { enabled: true, intervalDays: 30 },
        };
        const regenerated = {
            id: "unchanged-regenerated",
            usageType: "attestation",
            keySource: { type: "regenerate", keyChainType: "standalone" },
        };
        const signingKey = async (id: string) =>
            (await keyChains.findOneByOrFail({ tenantId: "demo", id }))
                .activeJwk.x;
        const planned = async (bundle: ConfigBundle, source?: string) => {
            const item = (
                await service.plan("demo", bundle, "upsert", source)
            ).items.find((candidate) => candidate.kind === "KeyChain");
            return { action: item?.action, changes: item?.changes };
        };

        try {
            const bundle = keyChainBundle(externalCa);
            await apply.apply("demo", bundle, "upsert");
            const imported = await signingKey(externalCa.id);
            expect(await planned(bundle)).toEqual({
                action: "unchanged",
                changes: [],
            });
            await apply.apply("demo", bundle, "upsert");
            expect(await signingKey(externalCa.id)).toBe(imported);

            // A rotation since the import is kept.
            await keyChainService.rotate("demo", externalCa.id);
            const rotated = await signingKey(externalCa.id);
            expect(rotated).not.toBe(imported);
            expect((await planned(bundle)).action).toBe("unchanged");
            await apply.apply("demo", bundle, "upsert");
            expect(await signingKey(externalCa.id)).toBe(rotated);

            // Another source, or a raised generation, compares the stored keys.
            expect((await planned(bundle, "bundle:other")).action).toBe(
                "update",
            );
            const raised = keyChainBundle(externalCa, 2);
            expect((await planned(raised)).action).toBe("update");
            await apply.apply("demo", raised, "upsert");
            expect(await signingKey(externalCa.id)).not.toBe(rotated);

            // regenerate creates new key material once per document.
            const regenerate = keyChainBundle(regenerated);
            await apply.apply("demo", regenerate, "upsert");
            const generated = await signingKey(regenerated.id);
            expect((await planned(regenerate)).action).toBe("unchanged");
            await apply.apply("demo", regenerate, "upsert");
            expect(await signingKey(regenerated.id)).toBe(generated);
        } finally {
            for (const id of [externalCa.id, regenerated.id]) {
                await keyChains.delete({ tenantId: "demo", id });
                await dataSource
                    .getRepository(ConfigResourceMetadataEntity)
                    .delete({
                        tenantId: "demo",
                        kind: "KeyChain",
                        resourceId: id,
                    });
            }
        }
    });

    it("keeps the secret of a !generate client whose document did not change since it was applied", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const clients = dataSource.getRepository(ClientEntity);
        const clientId = "generated-secret-client";
        const spec = {
            clientId,
            secret: "!generate",
            roles: ["issuance:offer"],
        };
        const clientBundle = (
            clientSpec: Record<string, unknown>,
            generation = 1,
        ) =>
            documentBundle(
                "demo",
                "Client",
                clientId,
                `clients/${clientId}.json`,
                clientSpec,
                generation,
            );
        const storedSecret = async () =>
            (await clients.findOneByOrFail({ tenantId: "demo", clientId }))
                .secret!;
        const planned = async (bundle: ConfigBundle, source?: string) =>
            (await service.plan("demo", bundle, "upsert", source)).items.find(
                (item) => item.kind === "Client",
            )?.action;

        try {
            const bundle = clientBundle(spec);
            const created = await apply.apply("demo", bundle, "upsert");
            const [secret] = created.generatedSecrets!;
            expect(await planned(bundle)).toBe("unchanged");
            const reapplied = await apply.apply("demo", bundle, "upsert");
            expect(reapplied.generatedSecrets).toBeUndefined();
            expect(
                await compareSecret(secret.value, await storedSecret()),
            ).toBe(true);

            // Another source, a raised generation or another document
            // generates a new secret.
            expect(await planned(bundle, "bundle:other")).toBe("update");
            const other = await apply.apply(
                "demo",
                bundle,
                "upsert",
                "bundle:other",
            );
            expect(other.generatedSecrets).toHaveLength(1);
            expect(
                await compareSecret(
                    other.generatedSecrets![0].value,
                    await storedSecret(),
                ),
            ).toBe(true);
            const raised = await apply.apply(
                "demo",
                clientBundle(spec, 2),
                "upsert",
            );
            expect(raised.generatedSecrets).toHaveLength(1);
            expect(raised.generatedSecrets![0].value).not.toBe(secret.value);
            const edited = await apply.apply(
                "demo",
                clientBundle({ ...spec, description: "Edited" }, 2),
                "upsert",
            );
            expect(edited.generatedSecrets).toHaveLength(1);
            expect(
                await compareSecret(
                    edited.generatedSecrets![0].value,
                    await storedSecret(),
                ),
            ).toBe(true);
        } finally {
            await clients.delete({ tenantId: "demo", clientId });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "Client",
                    resourceId: clientId,
                });
        }
    });

    it("keeps the secret of an unchanged !generate client file across startup imports", async () => {
        const folder = app.get(ConfigFolderBundleService);
        const dataSource = app.get(DataSource);
        const clients = dataSource.getRepository(ClientEntity);
        const clientId = "folder-generated-secret-client";
        const file = join(
            runtimeFolder,
            "config",
            "demo",
            "clients",
            `${clientId}.json`,
        );
        writeFileSync(
            file,
            JSON.stringify({
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: {
                    clientId,
                    secret: "!generate",
                    roles: ["issuance:offer"],
                },
            }),
        );
        const storedSecret = async () =>
            (await clients.findOneByOrFail({ tenantId: "demo", clientId }))
                .secret!;

        try {
            await folder.applyTenantFolder("demo", "upsert");
            const imported = await storedSecret();
            await folder.applyTenantFolder("demo", "upsert");
            expect(await storedSecret()).toBe(imported);

            // Reattach applies the file again and returns a new secret once.
            const reattach = await folder.planReattach(
                "demo",
                "Client",
                clientId,
            );
            const reattached = await folder.reattach(
                "demo",
                "Client",
                clientId,
                reattach.planFingerprint!,
            );
            expect(reattached.generatedSecrets).toHaveLength(1);
            expect(
                await compareSecret(
                    reattached.generatedSecrets![0].value,
                    await storedSecret(),
                ),
            ).toBe(true);

            // The secret returned by reattach survives the next startup.
            await folder.applyTenantFolder("demo", "upsert");
            expect(
                await compareSecret(
                    reattached.generatedSecrets![0].value,
                    await storedSecret(),
                ),
            ).toBe(true);
        } finally {
            rmSync(file, { force: true });
            await clients.delete({ tenantId: "demo", clientId });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "Client",
                    resourceId: clientId,
                });
        }
    });

    it("returns a new secret for a file-managed !generate client through the reattach endpoints and audits only its ID", async () => {
        const appConfig = app.get(ConfigService);
        const http = app.getHttpServer();
        const tenantId = "reattach-generated-secret";
        const clientId = "reattach-generated-secret-client";
        const bootstrap = await request(http)
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        const tenant = await request(http)
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: tenantId,
                name: "Reattach generated secret",
                roles: ["tenant:admin"],
            })
            .expect(201);
        const token = await request(http)
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.body.client.clientId,
                client_secret: tenant.body.client.clientSecret,
            })
            .expect(201);
        const authorization = `Bearer ${token.body.access_token}`;
        const tenantFolder = join(runtimeFolder, "config", tenantId);
        mkdirSync(join(tenantFolder, "clients"), { recursive: true });
        writeFileSync(
            join(tenantFolder, "clients", `${clientId}.json`),
            JSON.stringify({
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: {
                    clientId,
                    secret: "!generate",
                    roles: ["issuance:offer"],
                },
            }),
        );

        try {
            await app
                .get(ConfigFolderBundleService)
                .applyTenantFolder(tenantId, "upsert");

            const plan = await request(http)
                .post(
                    `/config-bundles/resources/Client/${clientId}/reattach/plan`,
                )
                .set("Authorization", authorization)
                .expect(201);
            expect(plan.body.items).toEqual([
                expect.objectContaining({
                    kind: "Client",
                    id: clientId,
                    action: "update",
                    // The web client warns that the secret changes when the plan lists this path.
                    changes: expect.arrayContaining([
                        expect.objectContaining({ path: "/spec/secret" }),
                    ]),
                }),
            ]);
            const reattached = await request(http)
                .post(`/config-bundles/resources/Client/${clientId}/reattach`)
                .query({ planFingerprint: plan.body.planFingerprint })
                .set("Authorization", authorization)
                .expect(201);
            expect(reattached.body.generatedSecrets).toEqual([
                expect.objectContaining({ kind: "Client", id: clientId }),
            ]);
            const secret: string = reattached.body.generatedSecrets[0].value;
            await request(http)
                .post("/api/oauth2/token")
                .send({
                    grant_type: "client_credentials",
                    client_id: clientId,
                    client_secret: secret,
                })
                .expect(201);

            const audits = await app
                .get(DataSource)
                .getRepository(AuditLogEntity)
                .findBy({
                    tenantId,
                    actionType: "config_client_secret_generated",
                });
            expect(audits.map((audit) => audit.after)).toEqual([
                { clients: [clientId], count: 1 },
            ]);
            expect(JSON.stringify(audits)).not.toContain(secret);
        } finally {
            rmSync(tenantFolder, { recursive: true, force: true });
        }
    });

    it("keeps the keys of an unchanged key chain file across startup imports and resets them on reattach", async () => {
        const folder = app.get(ConfigFolderBundleService);
        const keyChainService = app.get(KeyChainService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const ca = await keyWithCertificate("Folder CA", true);
        const id = "folder-external-ca";
        const file = join(
            runtimeFolder,
            "config",
            "demo",
            "key-chains",
            `${id}.json`,
        );
        writeFileSync(
            file,
            JSON.stringify({
                $schema: schemaUrl("KeyChain"),
                metadata: { generation: 1 },
                spec: {
                    id,
                    usageType: "attestation",
                    kmsProvider: "db",
                    keySource: { type: "private-jwk", jwk: ca.jwk },
                    crt: [ca.certificate],
                    rotationPolicy: { enabled: true, intervalDays: 30 },
                },
            }),
        );
        const signingKey = async () =>
            (await keyChains.findOneByOrFail({ tenantId: "demo", id }))
                .activeJwk.x;

        try {
            await folder.applyTenantFolder("demo", "upsert");
            const imported = await signingKey();
            await folder.applyTenantFolder("demo", "upsert");
            expect(await signingKey()).toBe(imported);

            // Reattach resets a rotated key chain to the file version.
            await keyChainService.rotate("demo", id);
            const rotated = await signingKey();
            const reattach = await folder.planReattach("demo", "KeyChain", id);
            expect(
                reattach.items.find((item) => item.kind === "KeyChain")?.action,
            ).toBe("update");
            await folder.reattach(
                "demo",
                "KeyChain",
                id,
                reattach.planFingerprint!,
            );
            const restored = await keyChains.findOneByOrFail({
                tenantId: "demo",
                id,
            });
            expect(restored.rootJwk?.x).toBe(ca.jwk.x);
            expect(restored.rootCertificate).toBe(ca.certificate);
            expect(restored.activeJwk.x).not.toBe(rotated);
        } finally {
            rmSync(file, { force: true });
            await keyChains.delete({ tenantId: "demo", id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({ tenantId: "demo", kind: "KeyChain", resourceId: id });
        }
    });

    it("imports a registrar configuration whose hosts do not resolve yet", async () => {
        const apply = app.get(ConfigBundleApplyService);
        const registrars = app
            .get(DataSource)
            .getRepository(RegistrarConfigEntity);
        const appConfig = app.get(ConfigService);
        // The default policy, under which the check would resolve the hosts.
        appConfig.set("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK", false);
        try {
            await apply.apply(
                "demo",
                registrarBundle({
                    registrarUrl: "https://registrar.example.invalid/api",
                    oidcUrl: "https://auth.example.invalid/realms/registrar",
                    clientId: "client",
                    username: "user",
                    password: "password",
                }),
                "upsert",
            );
            expect(
                await registrars.findOneBy({ tenantId: "demo" }),
            ).toMatchObject({
                registrarUrl: "https://registrar.example.invalid/api",
            });
        } finally {
            appConfig.set("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK", true);
            await registrars.delete({ tenantId: "demo" });
            await app
                .get(DataSource)
                .getRepository(ConfigResourceMetadataEntity)
                .delete({ tenantId: "demo", kind: "RegistrarConfig" });
        }
    });

    it("stops a registrar import at a URL the outbound URL policy blocks", async () => {
        const apply = app.get(ConfigBundleApplyService);
        const registrars = app
            .get(DataSource)
            .getRepository(RegistrarConfigEntity);
        const appConfig = app.get(ConfigService);
        // The e2e environment allows private networks, so the allowlist is
        // what blocks the OIDC host here. No request is sent either way.
        appConfig.set(
            "OUTBOUND_URL_ALLOWED_HOSTS",
            "registrar.example.invalid",
        );
        try {
            await expect(
                apply.apply(
                    "demo",
                    registrarBundle({
                        registrarUrl: "https://registrar.example.invalid/api",
                        oidcUrl:
                            "https://auth.blocked.invalid/realms/registrar",
                        clientId: "client",
                        username: "user",
                        password: "password",
                    }),
                    "upsert",
                ),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_APPLY_FAILED",
                    failedOperation: expect.objectContaining({
                        kind: "RegistrarConfig",
                    }),
                }),
            });
            expect(await registrars.findOneBy({ tenantId: "demo" })).toBeNull();
        } finally {
            appConfig.set("OUTBOUND_URL_ALLOWED_HOSTS", "");
            await registrars.delete({ tenantId: "demo" });
            await app
                .get(DataSource)
                .getRepository(ConfigResourceMetadataEntity)
                .delete({ tenantId: "demo", kind: "RegistrarConfig" });
        }
    });

    it("imports an internal chain with private keys and plans it again as unchanged", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const root = await keyWithCertificate("Restored Root CA", true);
        const signer = await keyWithCertificate("Restored signer", false);
        // Without kmsProvider: such a chain is always stored in the database.
        const spec = {
            id: "restored-internal-chain",
            description: "Restored internal chain",
            usageType: "attestation",
            keySource: {
                type: "private-jwk",
                jwk: root.jwk,
                activeJwk: signer.jwk,
            },
            crt: [root.certificate],
            activeCertificate: signer.certificate,
            rotationPolicy: {
                enabled: true,
                intervalDays: 30,
                certValidityDays: 60,
            },
        };
        const keyChainItem = (plan: ConfigImportPlan) =>
            plan.items.find((item) => item.kind === "KeyChain");

        try {
            const bundle = keyChainBundle(spec);
            const created = keyChainItem(
                await service.plan("demo", bundle, "upsert"),
            );
            expect(created?.issues).toEqual([]);
            expect(created?.action).toBe("create");
            await apply.apply("demo", bundle, "upsert");
            const stored = await keyChains.findOneByOrFail({
                tenantId: "demo",
                id: spec.id,
            });
            expect(stored.hasInternalCa()).toBe(true);
            expect(stored).toMatchObject({
                kmsProvider: "db",
                rootJwk: root.jwk,
                rootCertificate: root.certificate,
                activeJwk: signer.jwk,
                activeCertificate: signer.certificate,
            });
            expect(
                keyChainItem(await service.plan("demo", bundle, "upsert"))
                    ?.action,
            ).toBe("unchanged");
            // Another source compares the stored key chain with the document.
            expect(
                keyChainItem(
                    await service.plan(
                        "demo",
                        bundle,
                        "upsert",
                        "bundle:other",
                    ),
                )?.action,
            ).toBe("unchanged");

            // The plan, not the apply, reports a certificate of the other key.
            const swapped = keyChainItem(
                await service.plan(
                    "demo",
                    keyChainBundle({
                        ...spec,
                        activeCertificate: root.certificate,
                    }),
                    "upsert",
                ),
            );
            expect(swapped?.action).toBe("blocked");
            expect(
                swapped?.issues.map(({ code, path }) => ({ code, path })),
            ).toEqual([
                {
                    code: "CERTIFICATE_KEY_MISMATCH",
                    path: "/spec/activeCertificate",
                },
            ]);
        } finally {
            await keyChains.delete({ tenantId: "demo", id: spec.id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "KeyChain",
                    resourceId: spec.id,
                });
        }
    });

    it("blocks and refuses key chains whose algorithm the KMS provider does not offer", async () => {
        const service = app.get(ConfigBundleService);
        const apply = app.get(ConfigBundleApplyService);
        const kmsConfig = app.get(KmsTenantConfigService);
        const dataSource = app.get(DataSource);
        const keyChains = dataSource.getRepository(KeyChainEntity);
        const root = await keyWithCertificate("Unsupported Root CA", true);
        const signer = await keyWithCertificate("Unsupported signer", false);
        const internalChain = {
            id: "unsupported-alg-chain",
            usageType: "attestation",
            keySource: {
                type: "private-jwk",
                jwk: root.jwk,
                activeJwk: signer.jwk,
            },
            crt: [root.certificate],
            activeCertificate: signer.certificate,
        };
        const importedKey = {
            id: "unsupported-alg-import",
            usageType: "attestation",
            keySource: { type: "private-jwk", jwk: root.jwk },
        };
        // Both keys are P-256 (ES256); the database provider only offers ES384.
        const es384Only = {
            providers: [{ id: "db", type: "db", algorithms: ["ES384"] }],
        };
        const issues = (plan: ConfigImportPlan) =>
            plan.items
                .filter((item) => item.kind === "KeyChain")
                .map((item) => ({
                    action: item.action,
                    issues: item.issues.map(({ code, path, severity }) => ({
                        code,
                        path,
                        severity,
                    })),
                }));

        try {
            kmsConfig.saveTenantConfig("demo", es384Only as any);
            for (const spec of [internalChain, importedKey]) {
                expect(
                    issues(
                        await service.plan(
                            "demo",
                            keyChainBundle(spec),
                            "upsert",
                        ),
                    ),
                ).toEqual([
                    {
                        action: "blocked",
                        issues: [
                            {
                                code: "UNSUPPORTED_KEY_ALGORITHM",
                                path: "/spec/keySource/jwk",
                                severity: "error",
                            },
                        ],
                    },
                ]);
            }
            await expect(
                apply.apply("demo", keyChainBundle(internalChain), "upsert"),
            ).rejects.toMatchObject({
                status: 400,
                response: expect.objectContaining({
                    code: "CONFIG_APPLY_BLOCKED",
                }),
            });

            // With a KmsConfig in the bundle the plan only warns; apply checks the new configuration.
            const withKms = withDocument(
                keyChainBundle(internalChain),
                documentBundle("demo", "KmsConfig", "kms", "kms.json", {
                    providers: [{ id: "db", type: "db" }],
                }),
            );
            const deferred = await service.plan("demo", withKms, "upsert");
            expect(issues(deferred)).toEqual([
                {
                    action: "create",
                    issues: [
                        {
                            code: "KMS_PREFLIGHT_DEFERRED",
                            path: "/spec/keySource/jwk",
                            severity: "warning",
                        },
                    ],
                },
            ]);
            expect(deferred.applicable).toBe(true);
            kmsConfig.deleteTenantConfig("demo");

            // A key chain applied before the provider was narrowed is left alone.
            await apply.apply("demo", keyChainBundle(internalChain), "upsert");
            kmsConfig.saveTenantConfig("demo", es384Only as any);
            const unchanged = await service.plan(
                "demo",
                keyChainBundle(internalChain),
                "upsert",
            );
            expect(issues(unchanged)).toEqual([
                { action: "unchanged", issues: [] },
            ]);
            expect(unchanged.applicable).toBe(true);
            // A changed document imports the key again, which the narrowed provider refuses.
            expect(
                issues(
                    await service.plan(
                        "demo",
                        keyChainBundle({
                            ...internalChain,
                            description: "Changed",
                        }),
                        "upsert",
                    ),
                ),
            ).toEqual([
                {
                    action: "blocked",
                    issues: [
                        {
                            code: "UNSUPPORTED_KEY_ALGORITHM",
                            path: "/spec/keySource/jwk",
                            severity: "error",
                        },
                    ],
                },
            ]);
            kmsConfig.deleteTenantConfig("demo");
            await keyChains.delete({ tenantId: "demo", id: internalChain.id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "KeyChain",
                    resourceId: internalChain.id,
                });

            // The plan checks against the current KMS configuration, so a bundle
            // that narrows the provider itself passes it; apply checks again.
            const bundle = withDocument(
                keyChainBundle(internalChain),
                documentBundle(
                    "demo",
                    "KmsConfig",
                    "kms",
                    "kms.json",
                    es384Only,
                ),
            );
            expect(
                issues(await service.plan("demo", bundle, "upsert")),
            ).toEqual([{ action: "create", issues: [] }]);
            await expect(
                apply.apply("demo", bundle, "upsert"),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_APPLY_FAILED",
                    failedOperation: {
                        stage: "resource",
                        kind: "KeyChain",
                        id: internalChain.id,
                    },
                }),
            });
            expect(
                await keyChains.countBy({
                    tenantId: "demo",
                    id: internalChain.id,
                }),
            ).toBe(0);
        } finally {
            kmsConfig.deleteTenantConfig("demo");
            await keyChains.delete({ tenantId: "demo", id: internalChain.id });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({ tenantId: "demo", kind: "KmsConfig" });
            await dataSource
                .getRepository(ConfigResourceMetadataEntity)
                .delete({
                    tenantId: "demo",
                    kind: "KeyChain",
                    resourceId: internalChain.id,
                });
        }
    });
});

function registrarBundle(spec: Record<string, unknown>): ConfigBundle {
    return documentBundle(
        "demo",
        "RegistrarConfig",
        "registrar",
        "registrar.json",
        spec,
    );
}

function keyChainBundle(
    spec: Record<string, unknown>,
    generation = 1,
): ConfigBundle {
    return documentBundle(
        "demo",
        "KeyChain",
        String(spec.id),
        `key-chains/${spec.id}.json`,
        spec,
        generation,
    );
}

/** `bundle` with the document of the one-document bundle `other` added. */
function withDocument(bundle: ConfigBundle, other: ConfigBundle): ConfigBundle {
    return {
        ...bundle,
        manifest: {
            ...bundle.manifest,
            resources: [
                ...bundle.manifest.resources,
                ...other.manifest.resources,
            ],
        },
        documents: [...bundle.documents, ...other.documents],
    };
}

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

/** An EC key as the portable key chain schema accepts it, with a self-signed certificate. */
async function keyWithCertificate(name: string, ca: boolean) {
    const crypto = webcrypto as Crypto;
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const certificate = await x509.X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name: `CN=${name}`,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
            extensions: ca
                ? [
                      new x509.BasicConstraintsExtension(true, undefined, true),
                      new x509.KeyUsagesExtension(
                          x509.KeyUsageFlags.keyCertSign |
                              x509.KeyUsageFlags.cRLSign,
                          true,
                      ),
                  ]
                : [],
        },
        crypto,
    );
    // WebCrypto adds key_ops and ext, which the key chain schema rejects.
    const { kty, crv, x, y, d } = await crypto.subtle.exportKey(
        "jwk",
        keys.privateKey,
    );
    return {
        jwk: { kty, crv, x, y, d },
        certificate: certificate.toString("pem"),
    };
}
