import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getTenantAdminToken } from "../utils.js";

describe("GET /storage/:key (e2e)", () => {
    let app: INestApplication<App>;
    let key: string;

    beforeAll(async () => {
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        const token = await getTenantAdminToken(
            app,
            config.getOrThrow<string>("AUTH_CLIENT_ID"),
            config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            `storage-download-${Date.now()}`,
            [Role.Issuances],
        );
        const upload = await request(app.getHttpServer())
            .post("/storage")
            .set("Authorization", `Bearer ${token}`)
            .attach(
                "file",
                join(__dirname, "../fixtures/haip/images/company.png"),
            )
            .expect(201);
        key = upload.body.key;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("streams an uploaded file as an attachment", async () => {
        const response = await request(app.getHttpServer())
            .get(`/storage/${key}`)
            .expect(200);

        expect(response.headers["content-disposition"]).toMatch(/^attachment/);
        expect(response.headers["content-type"]).toBe("image/png");
    });

    test("answers an unknown key with 404", async () => {
        await request(app.getHttpServer())
            .get("/storage/00000000-0000-4000-8000-000000000000.png")
            .expect(404);
    });

    test("answers a key outside the storage folder with 404 and names no path", async () => {
        const response = await request(app.getHttpServer())
            .get("/storage/..%2F..%2Fpackage.json")
            .expect(404);

        expect(JSON.stringify(response.body)).not.toContain(process.cwd());
    });
});
