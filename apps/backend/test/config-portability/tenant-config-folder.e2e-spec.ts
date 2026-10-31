import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { TenantService } from "../../src/auth/tenant/tenant.service.js";
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { WebhookEndpointEntity } from "../../src/issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { documentBundle } from "../shared/config-bundle.js";

// Kept apart from test/utils.ts: importing it before the environment is set
// turns the startup import off.

const victim = "victim";
const attacker = `x/../${victim}`;
// assets/config/demo/key-chains/attestation.json
const keyChainId = "dbb65456-c358-46c1-bb5b-c777ef72c1d3";
// test/fixtures/haip/webhook-endpoints/notification.json, with an API key
const webhookId = "notification";
const victimKms = `${JSON.stringify({ providers: [{ id: "db", type: "db" }] }, null, 4)}\n`;

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe("tenant IDs that are no config folder name", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    let victimKmsFile: string;
    const originalEnvironment = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        FOLDER: process.env.FOLDER,
    };

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-tenant-folder-"));
        const tenantFolder = join(runtimeFolder, "config", victim);
        mkdirSync(join(tenantFolder, "key-chains"), { recursive: true });
        mkdirSync(join(tenantFolder, "webhook-endpoints"));
        writeFileSync(
            join(tenantFolder, "info.json"),
            JSON.stringify({ name: victim }),
        );
        cpSync(
            resolve(
                __dirname,
                "../../../../assets/config/demo/key-chains/attestation.json",
            ),
            join(tenantFolder, "key-chains", "attestation.json"),
        );
        cpSync(
            resolve(
                __dirname,
                "../fixtures/haip/webhook-endpoints/notification.json",
            ),
            join(tenantFolder, "webhook-endpoints", "notification.json"),
        );
        victimKmsFile = join(tenantFolder, "kms.json");
        writeFileSync(victimKmsFile, victimKms);

        process.env.CONFIG_FOLDER = join(runtimeFolder, "config");
        process.env.CONFIG_IMPORT_MODE = "create";
        process.env.FOLDER = runtimeFolder;

        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
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

    const rootToken = async () => {
        const appConfig = app.get(ConfigService);
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        return `Bearer ${response.body.access_token}`;
    };

    it.each([attacker, "..", "-tenant", "tenant a", "Victim", "kms.json"])(
        "refuses to create the tenant %j",
        async (id) => {
            const authorization = await rootToken();
            await request(app.getHttpServer())
                .post("/tenant")
                .set("Authorization", authorization)
                .send({ id, name: "Invalid", roles: ["tenant:admin"] })
                .expect(400);
            await expect(
                app
                    .get(DataSource)
                    .getRepository(TenantEntity)
                    .existsBy({ id }),
            ).resolves.toBe(false);
        },
    );

    it("keeps a tenant created by 9.x with such an ID out of other tenants' folders", async () => {
        const http = app.getHttpServer();
        const data = app.get(DataSource);
        await expect(
            data
                .getRepository(WebhookEndpointEntity)
                .existsBy({ tenantId: victim, id: webhookId }),
        ).resolves.toBe(true);

        // 9.x accepted the ID; the service does not validate the request.
        const tenant = await app.get(TenantService).createTenant({
            id: attacker,
            name: "Attacker",
            roles: ["tenant:admin"],
        });
        const token = await request(http)
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: tenant.client!.clientId,
                client_secret: tenant.client!.clientSecret,
            })
            .expect(201);
        const authorization = `Bearer ${token.body.access_token}`;

        for (const [kind, id] of [
            ["WebhookEndpoint", webhookId],
            ["KeyChain", keyChainId],
        ]) {
            await request(http)
                .post(`/config-bundles/resources/${kind}/${id}/reattach/plan`)
                .set("Authorization", authorization)
                .expect(409)
                .expect((response) => {
                    expect(response.body.message).toContain(
                        "not a folder name",
                    );
                });
            await request(http)
                .post(`/config-bundles/resources/${kind}/${id}/reattach`)
                .query({ planFingerprint: "0".repeat(64) })
                .set("Authorization", authorization)
                .expect(409);
        }
        await expect(
            data
                .getRepository(WebhookEndpointEntity)
                .existsBy({ tenantId: attacker, id: webhookId }),
        ).resolves.toBe(false);
        await expect(
            data
                .getRepository(KeyChainEntity)
                .existsBy({ tenantId: attacker, id: keyChainId }),
        ).resolves.toBe(false);

        // The tenant has no kms.json of its own and leaves victim's alone,
        // but keeps its other features.
        await request(http)
            .get("/key-chain/providers/config")
            .set("Authorization", authorization)
            .expect(200)
            .expect((response) => {
                expect(response.body.tenantConfig).toBeNull();
            });
        const replacement = { providers: [{ id: "other", type: "db" }] };
        await request(http)
            .put("/key-chain/providers/config")
            .set("Authorization", authorization)
            .send(replacement)
            .expect(400)
            .expect((response) => {
                expect(response.body.message).toContain("not a folder name");
            });
        await request(http)
            .delete("/key-chain/providers/config")
            .set("Authorization", authorization)
            .expect(400)
            .expect((response) => {
                expect(response.body.message).toContain("not a folder name");
            });
        const bundle = documentBundle(
            attacker,
            "KmsConfig",
            "kms",
            "kms.json",
            replacement,
        );
        const plan = await request(http)
            .post("/config-bundles/plan?mode=upsert")
            .set("Authorization", authorization)
            .send(bundle)
            .expect(201);
        expect(plan.body.applicable).toBe(false);
        expect(plan.body.items[0].issues).toEqual([
            expect.objectContaining({ code: "KMS_CONFIG_FOLDER_MISSING" }),
        ]);
        await request(http)
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${plan.body.planFingerprint}`,
            )
            .set("Authorization", authorization)
            .send(bundle)
            .expect((response) => {
                expect(response.status).toBeGreaterThanOrEqual(400);
                expect(response.status).toBeLessThan(500);
            });
        expect(readFileSync(victimKmsFile, "utf8")).toBe(victimKms);
        await request(http)
            .get("/config-bundles/export")
            .set("Authorization", authorization)
            .expect(200)
            .expect((response) => {
                expect(
                    response.body.documents.map(
                        (document: { $schema: string }) => document.$schema,
                    ),
                ).not.toContainEqual(expect.stringContaining("KmsConfig"));
            });
    });
});
