import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    CLIENTS_PROVIDER,
    type ClientsProvider,
} from "../../src/auth/client/client.provider.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { ConfigResourceMetadataEntity } from "../../src/platform/config-portability/entities/config-resource-metadata.entity.js";

// Kept apart from test/utils.ts: importing it before the environment is set
// turns the startup import off.

const folderTenant = "rotation-folder";
const fileClient = "rotation-file-client";
const fileSecret = "rotation-file-secret";

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe("rotating the secret of another tenant's client", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    const originalEnvironment = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        FOLDER: process.env.FOLDER,
    };

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-rotate-secret-"));
        const tenantFolder = join(runtimeFolder, "config", folderTenant);
        mkdirSync(join(tenantFolder, "clients"), { recursive: true });
        writeFileSync(
            join(tenantFolder, "info.json"),
            JSON.stringify({ name: folderTenant }),
        );
        writeFileSync(
            join(tenantFolder, "clients", `${fileClient}.json`),
            JSON.stringify({
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: {
                    clientId: fileClient,
                    secret: fileSecret,
                    roles: [Role.IssuanceOffer],
                },
            }),
        );

        process.env.CONFIG_FOLDER = join(runtimeFolder, "config");
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

    const token = async (clientId: string, clientSecret: string) => {
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            })
            .expect(201);
        return `Bearer ${response.body.access_token}`;
    };

    const rootToken = () => {
        const appConfig = app.get(ConfigService);
        return token(
            appConfig.getOrThrow<string>("AUTH_CLIENT_ID"),
            appConfig.getOrThrow<string>("AUTH_CLIENT_SECRET"),
        );
    };

    const metadata = (tenantId: string, resourceId: string) =>
        app
            .get(DataSource)
            .getRepository(ConfigResourceMetadataEntity)
            .findOneBy({ tenantId, kind: "Client", resourceId });

    /** A tenant manager that also belongs to a tenant of its own. */
    const tenantManagerWithTenant = async (tenantId: string) => {
        await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", await rootToken())
            .send({ id: tenantId, name: tenantId, roles: [] })
            .expect(201);
        const clientId = `${tenantId}-manager`;
        // The API grants tenants:manage to no tenant client; an operator may.
        const created = await app
            .get<ClientsProvider>(CLIENTS_PROVIDER)
            .addClient(tenantId, {
                clientId,
                roles: [Role.Tenants, Role.Clients],
            });
        return token(clientId, created.clientSecret!);
    };

    it("refuses a file-managed client to the operator without a tenant", async () => {
        await expect(metadata(folderTenant, fileClient)).resolves.toMatchObject(
            { ownership: "file-managed" },
        );

        await request(app.getHttpServer())
            .post(`/client/${fileClient}/rotate-secret`)
            .set("Authorization", await rootToken())
            .expect(409);

        // The secret from the folder still works.
        await token(fileClient, fileSecret);
    });

    it("refuses a file-managed client to a client manager of its tenant", async () => {
        const clientId = "rotation-folder-manager";
        const created = await app
            .get<ClientsProvider>(CLIENTS_PROVIDER)
            .addClient(folderTenant, {
                clientId,
                roles: [Role.Clients, Role.IssuanceOffer],
            });

        await request(app.getHttpServer())
            .post(`/client/${fileClient}/rotate-secret`)
            .set("Authorization", await token(clientId, created.clientSecret!))
            .expect(409);

        await token(fileClient, fileSecret);
    });

    it("refuses a file-managed client to a tenant manager of another tenant", async () => {
        const authorization =
            await tenantManagerWithTenant("rotation-manager-a");

        await request(app.getHttpServer())
            .post(`/client/${fileClient}/rotate-secret`)
            .set("Authorization", authorization)
            .expect(409);

        await token(fileClient, fileSecret);
        await expect(
            metadata("rotation-manager-a", fileClient),
        ).resolves.toBeNull();
    });

    it("checks and records the client's tenant for a tenant manager of another tenant", async () => {
        const managerTenant = "rotation-manager-b";
        const clientTenant = "rotation-client-tenant";
        const authorization = await tenantManagerWithTenant(managerTenant);
        const http = app.getHttpServer();
        const tenant = await request(http)
            .post("/tenant")
            .set("Authorization", await rootToken())
            .send({
                id: clientTenant,
                name: clientTenant,
                roles: [Role.IssuanceOffer],
            })
            .expect(201);
        const clientId: string = tenant.body.client.clientId;
        // A record of the manager's own tenant must not decide.
        await app
            .get(DataSource)
            .getRepository(ConfigResourceMetadataEntity)
            .save({
                tenantId: managerTenant,
                kind: "Client",
                resourceId: clientId,
                ownership: "file-managed",
                source: "stale",
            });

        const rotated = await request(http)
            .post(`/client/${clientId}/rotate-secret`)
            .set("Authorization", authorization)
            .expect(201);

        await token(clientId, rotated.body.secret);
        await expect(metadata(clientTenant, clientId)).resolves.toMatchObject({
            ownership: "unmanaged",
        });
        await expect(metadata(managerTenant, clientId)).resolves.toMatchObject({
            ownership: "file-managed",
            source: "stale",
        });
    });

    it("checks and records the client's tenant for the operator without a tenant", async () => {
        const clientTenant = "rotation-operator-target";
        const http = app.getHttpServer();
        const authorization = await rootToken();
        const tenant = await request(http)
            .post("/tenant")
            .set("Authorization", authorization)
            .send({
                id: clientTenant,
                name: clientTenant,
                roles: [Role.IssuanceOffer],
            })
            .expect(201);
        const clientId: string = tenant.body.client.clientId;

        const rotated = await request(http)
            .post(`/client/${clientId}/rotate-secret`)
            .set("Authorization", authorization)
            .expect(201);

        await token(clientId, rotated.body.secret);
        await expect(metadata(clientTenant, clientId)).resolves.toMatchObject({
            ownership: "unmanaged",
        });
    });
});
