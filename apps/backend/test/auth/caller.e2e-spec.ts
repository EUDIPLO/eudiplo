import { rmSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { clientToken, getToken } from "../utils.js";

/**
 * `GET /auth/me` returns the caller as the backend resolves it from a token
 * of the built-in server, so the web client shows what the backend allows.
 */
describe("Caller (e2e)", () => {
    let app: INestApplication<App>;
    let rootClientId: string;
    let rootSecret: string;

    const me = (token: string) =>
        request(app.getHttpServer())
            .get("/auth/me")
            .set("Authorization", `Bearer ${token}`);

    beforeAll(async () => {
        // The fixtures use fixed tenant and client IDs.
        rmSync("../../tmp/service.db", { force: true });
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        rootClientId = config.getOrThrow<string>("AUTH_CLIENT_ID");
        rootSecret = config.getOrThrow<string>("AUTH_CLIENT_SECRET");
    });

    afterAll(async () => {
        await app?.close();
    });

    test("returns the root client without a tenant", async () => {
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: rootClientId,
                client_secret: rootSecret,
            })
            .expect(201)
            .then((res) => res.body.access_token as string);

        const response = await me(token).expect(200);

        expect(response.body).toEqual({
            subject: rootClientId,
            tenantId: null,
            roles: [Role.Tenants],
        });
    });

    test("returns the tenant and the roles of a client without a role check", async () => {
        const tenantToken = await getToken(
            app,
            rootClientId,
            rootSecret,
            "caller-acme",
            [Role.TenantAdmin],
        );
        const token = await clientToken(app, tenantToken, "caller-reader", [
            Role.SessionsRead,
        ]);

        const response = await me(token).expect(200);

        expect(response.body).toEqual({
            subject: "caller-reader",
            tenantId: "caller-acme",
            roles: [Role.SessionsRead],
        });
    });

    test("returns the client's current roles, not those of the token", async () => {
        const tenantToken = await getToken(
            app,
            rootClientId,
            rootSecret,
            "caller-changed",
            [Role.TenantAdmin],
        );
        const token = await clientToken(app, tenantToken, "caller-shrunk", [
            Role.SessionsRead,
            Role.AuditRead,
        ]);
        await request(app.getHttpServer())
            .patch("/client/caller-shrunk")
            .set("Authorization", `Bearer ${tenantToken}`)
            .send({ roles: [Role.AuditRead] })
            .expect(200);

        const response = await me(token).expect(200);

        expect(response.body.roles).toEqual([Role.AuditRead]);
    });

    test("rejects a request without a token", async () => {
        await request(app.getHttpServer()).get("/auth/me").expect(401);
    });
});
