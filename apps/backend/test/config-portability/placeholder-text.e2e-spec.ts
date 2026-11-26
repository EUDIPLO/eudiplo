import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { documentsBundle } from "../shared/config-bundle.js";

/**
 * A tenant folder file resolves `${VAR}` from the backend's environment.
 * Text a tenant stores through the API is data, so the export writes its
 * `${` in the escaped form `$${`: placed in the tenant's folder, the export
 * gives the text back and hands the tenant no variable of the instance.
 */
describe("placeholder text in configuration stored through the API", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    let authorization: string;
    const tenantId = "placeholder-text";
    const SECRET = "secret-of-another-tenant-do-not-leak";
    const TEXT = {
        name: "Hook ${OTHER_TENANT_API_KEY}",
        description: "${OTHER_TENANT_API_KEY}",
        url: "https://attacker.example.com/?k=${OTHER_TENANT_API_KEY:x}",
    };
    /** A variable no environment of this suite sets. */
    const UNSET = "EUDIPLO_E2E_PLACEHOLDER_UNSET";
    const before = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        CONFIG_VARIABLE_STRICT: process.env.CONFIG_VARIABLE_STRICT,
        [UNSET]: process.env[UNSET],
        FOLDER: process.env.FOLDER,
        OTHER_TENANT_API_KEY: process.env.OTHER_TENANT_API_KEY,
    };
    const http = () => app.getHttpServer();
    const webhook = (overrides: Record<string, unknown> = {}) => ({
        id: "hook",
        name: "Hook",
        url: "https://hooks.example.com/events",
        auth: { type: "none" },
        ...overrides,
    });
    const stored = async (id: string) =>
        (
            await request(http())
                .get(`/issuer/webhook-endpoints/${id}`)
                .set("Authorization", authorization)
                .expect(200)
        ).body;
    const exportedDocument = async (id: string) => {
        const exported = await request(http())
            .get("/config-bundles/export")
            .set("Authorization", authorization)
            .expect(200);
        const document = exported.body.documents.find(
            (item: any) =>
                String(item.$schema).includes("WebhookEndpoint") &&
                item.spec?.id === id,
        );
        expect(document, `exported document of ${id}`).toBeDefined();
        return document;
    };
    const writeFolderFile = (id: string, document: unknown) => {
        const folder = join(
            app.get(ConfigService).getOrThrow<string>("CONFIG_FOLDER"),
            tenantId,
            "webhook-endpoints",
        );
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, `${id}.json`), JSON.stringify(document));
    };

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-placeholder-"));
        mkdirSync(join(runtimeFolder, "config"));
        process.env.CONFIG_FOLDER = join(runtimeFolder, "config");
        process.env.CONFIG_IMPORT_MODE = "upsert";
        process.env.FOLDER = runtimeFolder;
        // A variable of the operator's own, meant for another tenant's files.
        process.env.OTHER_TENANT_API_KEY = SECRET;
        // A folder file may leave a placeholder unresolved, which the plan
        // then reports. The mode is read when the module is compiled.
        process.env.CONFIG_VARIABLE_STRICT = "ignore";
        delete process.env[UNSET];

        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();

        const config = app.get(ConfigService);
        const bootstrap = await request(http())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: config.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret: config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        const tenant = await request(http())
            .post("/tenant")
            .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
            .send({
                id: tenantId,
                name: "Placeholder text",
                roles: ["tenant:admin", "issuance:manage"],
            })
            .expect(201);
        const token = await request(http())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.body.client.clientId,
                client_secret: tenant.body.client.clientSecret,
            })
            .expect(201);
        authorization = `Bearer ${token.body.access_token}`;

        // The tenant stores text that looks like placeholders.
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook(TEXT))
            .expect(201);
    }, 30_000);

    afterAll(async () => {
        await app?.close();
        rmSync(runtimeFolder, { recursive: true, force: true });
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it("exports the text in its escaped form", async () => {
        const document = await exportedDocument("hook");
        expect(document.spec).toMatchObject({
            name: "Hook $${OTHER_TENANT_API_KEY}",
            description: "$${OTHER_TENANT_API_KEY}",
            url: "https://attacker.example.com/?k=$${OTHER_TENANT_API_KEY:x}",
        });
    });

    it("gives the text back, and no variable, when the export is reattached from the tenant's folder", async () => {
        writeFolderFile("hook", await exportedDocument("hook"));

        const plan = await request(http())
            .post(
                "/config-bundles/resources/WebhookEndpoint/hook/reattach/plan",
            )
            .set("Authorization", authorization)
            .expect(201);
        expect(JSON.stringify(plan.body)).not.toContain(SECRET);
        expect(plan.body.applicable).toBe(true);
        expect(plan.body.items).toEqual([
            expect.objectContaining({ kind: "WebhookEndpoint", id: "hook" }),
        ]);
        // The file holds what is stored.
        expect(plan.body.items[0].changes ?? []).toEqual([]);

        const applied = await request(http())
            .post("/config-bundles/resources/WebhookEndpoint/hook/reattach")
            .query({ planFingerprint: plan.body.planFingerprint })
            .set("Authorization", authorization)
            .expect(201);
        expect(JSON.stringify(applied.body)).not.toContain(SECRET);
        expect(await stored("hook")).toMatchObject(TEXT);
    });

    it("gives the text back when the folder is imported as at startup", async () => {
        // The export of another resource with the same text, changed in the
        // file, so that the import has to write it.
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook({ ...TEXT, id: "startup" }))
            .expect(201);
        const document = await exportedDocument("startup");
        document.spec.name = `${document.spec.name} v2`;
        writeFolderFile("startup", document);

        await app
            .get(ConfigFolderBundleService)
            .applyTenantFolder(tenantId, "upsert");
        expect(await stored("startup")).toMatchObject({
            ...TEXT,
            name: `${TEXT.name} v2`,
        });
        const resource = await stored("hook");
        expect(resource).toMatchObject(TEXT);
        expect(JSON.stringify(resource)).not.toContain(SECRET);
    });

    it("reads the escaped form of a bundle sent to the API and plans the export as unchanged", async () => {
        const document = await exportedDocument("hook");
        const plan = await request(http())
            .post("/config-bundles/plan")
            .set("Authorization", authorization)
            .send(
                documentsBundle(tenantId, [
                    {
                        kind: "WebhookEndpoint",
                        id: "hook",
                        path: "webhook-endpoints/hook.json",
                        spec: document.spec,
                        generation: document.metadata.generation,
                    },
                ]),
            )
            .expect(201);
        expect(plan.body.items[0].issues).toEqual([]);
        expect(plan.body.items[0].changes ?? []).toEqual([]);
        expect(JSON.stringify(plan.body)).not.toContain(SECRET);
    });

    it("stores the text of an escaped form a bundle brings in", async () => {
        const bundle = documentsBundle(tenantId, [
            {
                kind: "WebhookEndpoint",
                id: "bundled",
                path: "webhook-endpoints/bundled.json",
                spec: webhook({
                    id: "bundled",
                    name: "Bundled $${OTHER_TENANT_API_KEY}",
                }),
            },
        ]);
        const plan = await request(http())
            .post("/config-bundles/plan")
            .set("Authorization", authorization)
            .send(bundle)
            .expect(201);
        expect(plan.body.applicable, JSON.stringify(plan.body.issues)).toBe(
            true,
        );
        await request(http())
            .post("/config-bundles/import")
            .query({ planFingerprint: plan.body.planFingerprint })
            .set("Authorization", authorization)
            .send(bundle)
            .expect(201);
        expect((await stored("bundled")).name).toBe(
            "Bundled ${OTHER_TENANT_API_KEY}",
        );
    });

    it("stores a placeholder inside a longer value of a bundle as text, with a warning, and resolves nothing", async () => {
        const url =
            "https://attacker.example.com/?k=${OTHER_TENANT_API_KEY}&d=${OTHER_TENANT_API_KEY:x}";
        const bundle = documentsBundle(tenantId, [
            {
                kind: "WebhookEndpoint",
                id: "embedded",
                path: "webhook-endpoints/embedded.json",
                spec: webhook({ id: "embedded", url }),
            },
        ]);
        const plan = await request(http())
            .post("/config-bundles/plan")
            .set("Authorization", authorization)
            .send(bundle)
            .expect(201);
        expect(plan.body.applicable).toBe(true);
        // One issue for the value, though it holds two placeholders.
        expect(plan.body.items[0].issues).toEqual([
            expect.objectContaining({
                severity: "warning",
                code: "PLACEHOLDER_STORED_AS_TEXT",
                path: "/spec/url",
                message: expect.stringContaining("write $${"),
            }),
        ]);
        expect(JSON.stringify(plan.body)).not.toContain(SECRET);
        await request(http())
            .post("/config-bundles/import")
            .query({ planFingerprint: plan.body.planFingerprint })
            .set("Authorization", authorization)
            .send(bundle)
            .expect(201);
        expect((await stored("embedded")).url).toBe(url);
    });

    it("escapes the ID of a resource like its other values", async () => {
        const id = "${OTHER_TENANT_API_KEY}";
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook({ id }))
            .expect(201);
        const exported = await request(http())
            .get("/config-bundles/export")
            .set("Authorization", authorization)
            .expect(200);
        const document = exported.body.documents.find(
            (item: any) => item.spec?.id === "$${OTHER_TENANT_API_KEY}",
        );
        expect(document, "document with the escaped ID").toBeDefined();
        expect(
            exported.body.documents.some((item: any) => item.spec?.id === id),
        ).toBe(false);

        // Placed in the folder with a changed name, the file names the stored
        // ID and no variable: the import writes that resource and no other.
        document.spec.name = "Renamed by the file";
        writeFolderFile("escaped-id", document);
        const before = await request(http())
            .get("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .expect(200);
        await app
            .get(ConfigFolderBundleService)
            .applyTenantFolder(tenantId, "upsert");
        const all = await request(http())
            .get("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .expect(200);
        expect(JSON.stringify(all.body)).not.toContain(SECRET);
        expect(all.body.map((item: any) => item.id).sort()).toEqual(
            before.body.map((item: any) => item.id).sort(),
        );
        expect(all.body.find((item: any) => item.id === id).name).toBe(
            "Renamed by the file",
        );

        // The reattach endpoints find the file by the stored ID.
        const plan = await request(http())
            .post(
                `/config-bundles/resources/WebhookEndpoint/${encodeURIComponent(id)}/reattach/plan`,
            )
            .set("Authorization", authorization)
            .expect(201);
        expect(plan.body.items).toEqual([
            expect.objectContaining({ kind: "WebhookEndpoint", id }),
        ]);
        expect(JSON.stringify(plan.body)).not.toContain(SECRET);
    });

    it("escapes the name of an uploaded file that an export writes into a document", async () => {
        const upload = await request(http())
            .post("/storage")
            .set("Authorization", authorization)
            .attach(
                "file",
                join(__dirname, "../fixtures/haip/images/company.png"),
                { filename: "${OTHER_TENANT_API_KEY}.png" },
            )
            .expect(201);
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(
                webhook({
                    id: "asset",
                    name: `https://files.example.com/storage/${upload.body.key}`,
                }),
            )
            .expect(201);

        // The export names the file in place of its storage URL.
        expect((await exportedDocument("asset")).spec.name).toBe(
            "$${OTHER_TENANT_API_KEY}.png",
        );
    });

    it("keeps the placeholder an export writes for a client secret, and escapes the client's text", async () => {
        await request(http())
            .post("/client")
            .set("Authorization", authorization)
            .send({
                clientId: "texty",
                description: "${OTHER_TENANT_API_KEY}",
                roles: ["issuance:offer"],
            })
            .expect(201);
        const exported = await request(http())
            .get("/config-bundles/export")
            .set("Authorization", authorization)
            .expect(200);
        const client = exported.body.documents.find(
            (item: any) => item.spec?.clientId === "texty",
        );
        expect(client.spec.description).toBe("$${OTHER_TENANT_API_KEY}");
        expect(client.spec.secret).toMatch(/^\$\{CLIENT_[A-Z0-9_]+\}$/);

        // The export of the one resource writes the same document.
        const single = await request(http())
            .get("/config-bundles/resources/Client/texty/document")
            .set("Authorization", authorization)
            .expect(200);
        expect(single.body.spec.description).toBe("$${OTHER_TENANT_API_KEY}");
        expect(single.body.spec.secret).toBe(client.spec.secret);
    });

    it.each([
        ["as a whole value", { description: "${OTHER_TENANT_API_KEY}" }],
        ["with a default", { name: "${OTHER_TENANT_API_KEY:fallback}" }],
    ])(
        "blocks a bundle sent to the API with a placeholder %s and resolves nothing",
        async (_case, overrides) => {
            const [field] = Object.keys(overrides);
            const bundle = documentsBundle(tenantId, [
                {
                    kind: "WebhookEndpoint",
                    id: "blocked",
                    path: "webhook-endpoints/blocked.json",
                    spec: webhook({ id: "blocked", ...overrides }),
                },
            ]);
            const plan = await request(http())
                .post("/config-bundles/plan")
                .set("Authorization", authorization)
                .send(bundle)
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toEqual([
                expect.objectContaining({
                    code: "SECRET_REQUIRED",
                    path: `/spec/${field}`,
                }),
            ]);
            expect(JSON.stringify(plan.body)).not.toContain(SECRET);
            expect(JSON.stringify(plan.body)).not.toContain('fallback"');
            await request(http())
                .post("/config-bundles/import")
                .query({ planFingerprint: plan.body.planFingerprint })
                .set("Authorization", authorization)
                .send(bundle)
                .expect(400);
            await request(http())
                .get("/issuer/webhook-endpoints/blocked")
                .set("Authorization", authorization)
                .expect(404);
        },
    );

    it("plans a folder file with an unresolved placeholder under CONFIG_VARIABLE_STRICT=ignore", async () => {
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook({ id: "unset-name" }))
            .expect(201);
        const named = await exportedDocument("unset-name");
        named.spec.name = `\${${UNSET}}`;
        writeFolderFile("unset-name", named);

        const namePlan = await request(http())
            .post(
                "/config-bundles/resources/WebhookEndpoint/unset-name/reattach/plan",
            )
            .set("Authorization", authorization)
            .expect(201);
        expect(namePlan.body.applicable).toBe(false);
        expect(namePlan.body.items[0].issues).toEqual([
            expect.objectContaining({
                code: "SECRET_REQUIRED",
                path: "/spec/name",
            }),
        ]);

        // Inside a longer value, the placeholder of a folder file is stored
        // as text: the loader has reported it, so the plan does not.
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook({ id: "unset-url" }))
            .expect(201);
        const linked = await exportedDocument("unset-url");
        const url = `https://hooks.example.com/?k=\${${UNSET}}`;
        linked.spec.url = url;
        writeFolderFile("unset-url", linked);

        const urlPlan = await request(http())
            .post(
                "/config-bundles/resources/WebhookEndpoint/unset-url/reattach/plan",
            )
            .set("Authorization", authorization)
            .expect(201);
        expect(urlPlan.body.applicable).toBe(true);
        expect(urlPlan.body.items[0].issues).toEqual([]);
        await request(http())
            .post(
                "/config-bundles/resources/WebhookEndpoint/unset-url/reattach",
            )
            .query({ planFingerprint: urlPlan.body.planFingerprint })
            .set("Authorization", authorization)
            .expect(201);
        expect((await stored("unset-url")).url).toBe(url);
    });

    it("validates the values of a file, not their escaped form, so a value at maxLength holding ${ re-imports from its export", async () => {
        const { publicKey } = generateKeyPairSync("ec", {
            namedCurve: "P-256",
        });
        // 1000 characters, the maxLength of a trust anchor's description;
        // the export writes 1001.
        const description = `\${${"a".repeat(998)}`;
        await request(http())
            .post("/federation-trust-anchor")
            .set("Authorization", authorization)
            .send({
                id: "long",
                entityId: "https://anchor.example.com",
                description,
                jwks: {
                    keys: [
                        { ...publicKey.export({ format: "jwk" }), kid: "k1" },
                    ],
                },
            })
            .expect(201);
        const exported = await request(http())
            .get("/config-bundles/export")
            .set("Authorization", authorization)
            .expect(200);
        const document = exported.body.documents.find(
            (item: any) =>
                String(item.$schema).includes("FederationTrustAnchor") &&
                item.spec?.id === "long",
        );
        expect(document.spec.description).toBe(`$${description}`);

        const plan = await request(http())
            .post("/config-bundles/plan")
            .set("Authorization", authorization)
            .send(
                documentsBundle(tenantId, [
                    {
                        kind: "FederationTrustAnchor",
                        id: "long",
                        path: "federation-trust-anchors/long.json",
                        spec: document.spec,
                        generation: document.metadata.generation,
                    },
                ]),
            )
            .expect(201);
        expect(plan.body.items[0].issues).toEqual([]);
        expect(plan.body.items[0].changes ?? []).toEqual([]);

        // The upgrade of one document checks it the same way and gives back
        // the file.
        const upgraded = await request(http())
            .post("/config-bundles/documents/upgrade")
            .set("Authorization", authorization)
            .send(document)
            .expect(201);
        expect(upgraded.body.issues).toEqual([]);
        expect(upgraded.body.document.spec.description).toBe(`$${description}`);

        // One character more than the schema allows is still refused.
        const tooLong = await request(http())
            .post("/config-bundles/plan")
            .set("Authorization", authorization)
            .send(
                documentsBundle(tenantId, [
                    {
                        kind: "FederationTrustAnchor",
                        id: "long",
                        path: "federation-trust-anchors/long.json",
                        spec: {
                            ...document.spec,
                            description: `$${description}a`,
                        },
                        generation: document.metadata.generation,
                    },
                ]),
            )
            .expect(201);
        expect(tooLong.body.applicable).toBe(false);
        expect(tooLong.body.items[0].issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "CONFIG_SCHEMA_VALIDATION_FAILED",
                    path: "/spec/description",
                }),
            ]),
        );

        // The apply checks the same values: a changed value at maxLength is
        // written as the text the file holds.
        const changed = `\${${"b".repeat(998)}`;
        const updateBundle = documentsBundle(tenantId, [
            {
                kind: "FederationTrustAnchor",
                id: "long",
                path: "federation-trust-anchors/long.json",
                spec: { ...document.spec, description: `$${changed}` },
                generation: document.metadata.generation,
            },
        ]);
        const update = await request(http())
            .post("/config-bundles/plan")
            .query({ mode: "upsert" })
            .set("Authorization", authorization)
            .send(updateBundle)
            .expect(201);
        expect(update.body.applicable).toBe(true);
        expect(update.body.items[0].action).toBe("update");
        await request(http())
            .post("/config-bundles/import")
            .query({
                mode: "upsert",
                planFingerprint: update.body.planFingerprint,
            })
            .set("Authorization", authorization)
            .send(updateBundle)
            .expect(201);
        const anchors = await request(http())
            .get("/federation-trust-anchor")
            .set("Authorization", authorization)
            .expect(200);
        expect(
            anchors.body.find((anchor: { id: string }) => anchor.id === "long")
                .description,
        ).toBe(changed);
    });

    it("still resolves a placeholder the operator writes to the tenant's folder", async () => {
        await request(http())
            .post("/issuer/webhook-endpoints")
            .set("Authorization", authorization)
            .send(webhook({ id: "operator" }))
            .expect(201);
        const document = await exportedDocument("operator");
        document.spec.name = "Operator ${OTHER_TENANT_API_KEY}";
        writeFolderFile("operator", document);

        const plan = await request(http())
            .post(
                "/config-bundles/resources/WebhookEndpoint/operator/reattach/plan",
            )
            .set("Authorization", authorization)
            .expect(201);
        expect(plan.body.applicable).toBe(true);
        // The operator put the value into a field that is no secret: once
        // applied, the resource shows it to the tenant anyway, so the plan
        // shows it too. Secret fields are redacted by their path.
        expect(plan.body.items[0].changes).toEqual([
            expect.objectContaining({
                path: "/spec/name",
                after: `Operator ${SECRET}`,
            }),
        ]);
        await request(http())
            .post("/config-bundles/resources/WebhookEndpoint/operator/reattach")
            .query({ planFingerprint: plan.body.planFingerprint })
            .set("Authorization", authorization)
            .expect(201);
        expect((await stored("operator")).name).toBe(`Operator ${SECRET}`);
    });
});
