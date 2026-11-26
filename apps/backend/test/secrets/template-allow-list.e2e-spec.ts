import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * With `templates.tenant` in the operator's secret policy, the `${VAR}`
 * placeholders of tenant folder files may name only the listed variables,
 * instead of every variable but EUDIPLO's settings and the cloud
 * credentials of the instance.
 */
describe("Secret policy: allow-list for placeholders of tenant folders", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    const listedTenant = "templates-listed";
    const refusedTenant = "templates-refused";
    const variables = {
        E2E_TMPL_HOOK_URL: "https://hooks.example.com/listed",
        E2E_UNLISTED_KEY: "unlisted-key-do-not-store",
    };
    const keys = [
        "CONFIG_FOLDER",
        "CONFIG_IMPORT_MODE",
        "FOLDER",
        "SECRET_POLICY_FILE",
        ...Object.keys(variables),
    ];
    const before = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
    );

    const write = (path: string, document: unknown) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(document));
    };
    const webhook = (id: string, spec: Record<string, unknown>) => ({
        $schema: schemaUrl("WebhookEndpoint"),
        metadata: { generation: 1 },
        spec: { id, name: id, auth: { type: "none" }, ...spec },
    });

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-templates-"));
        const tenantFolder = (id: string, hook: Record<string, unknown>) => {
            const tenant = join(runtimeFolder, "config", id);
            write(join(tenant, "info.json"), {
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: id, description: "Template allow-list" },
            });
            write(join(tenant, "clients", "admin.json"), {
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: {
                    clientId: `${id}-admin`,
                    secret: "templates-admin-secret",
                    roles: ["issuance:manage"],
                },
            });
            write(
                join(tenant, "webhook-endpoints", "hook.json"),
                webhook("hook", hook),
            );
        };
        tenantFolder(listedTenant, { url: "${E2E_TMPL_HOOK_URL}" });
        tenantFolder(refusedTenant, {
            url: "https://hooks.example.com/unlisted",
            auth: {
                type: "apiKey",
                config: {
                    headerName: "x-api-key",
                    value: "${E2E_UNLISTED_KEY}",
                },
            },
        });
        const policyFile = join(runtimeFolder, "secret-policy.json");
        write(policyFile, { templates: { tenant: ["E2E_TMPL_*"] } });

        Object.assign(process.env, variables, {
            CONFIG_FOLDER: join(runtimeFolder, "config"),
            CONFIG_IMPORT_MODE: "create",
            FOLDER: runtimeFolder,
            SECRET_POLICY_FILE: policyFile,
        });
        // Imported after the environment is set, so the startup import runs.
        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        rmSync(runtimeFolder, { recursive: true, force: true });
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });

    const token = (tenant: string) =>
        request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: `${tenant}-admin`,
                client_secret: "templates-admin-secret",
            });

    it("imports a tenant folder whose files name only listed variables", async () => {
        const issued = await token(listedTenant).expect(201);
        const response = await request(app.getHttpServer())
            .get("/issuer/webhook-endpoints/hook")
            .set("Authorization", `Bearer ${issued.body.access_token}`)
            .expect(200);
        expect(response.body.url).toBe(variables.E2E_TMPL_HOOK_URL);
    });

    it("does not import a tenant folder whose file names a variable the policy does not list", async () => {
        // As for any refused placeholder, the tenant's import fails, so
        // neither its client nor the value exists.
        await token(refusedTenant).expect(401);
    });
});
