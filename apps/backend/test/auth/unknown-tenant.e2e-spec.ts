import { rmSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { AppModule } from "../../src/app.module.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";

/**
 * Public issuer routes name the tenant in the path. An unknown tenant must
 * answer 404 instead of failing further down with a 500.
 */
describe("Unknown tenant (e2e)", () => {
    const unknown = "unknown-tenant-does-not-exist";
    const known = "unknown-tenant-known";
    let app: INestApplication<App>;

    beforeAll(async () => {
        rmSync("../../tmp/service.db", { force: true });
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();

        const config = app.get(ConfigService);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: config.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret: config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .send({ id: known, name: known })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
    });

    test.each([
        ["GET", `/.well-known/openid-credential-issuer/issuers/${unknown}`],
        ["GET", `/.well-known/oauth-authorization-server/issuers/${unknown}`],
        [
            "GET",
            `/.well-known/oauth-authorization-server/issuers/${unknown}/chained-as`,
        ],
        ["GET", `/.well-known/jwks.json/issuers/${unknown}`],
        ["GET", `/.well-known/jwks.json/issuers/${unknown}/chained-as`],
        ["POST", `/issuers/${unknown}/vci/nonce`],
        ["POST", `/issuers/${unknown}/vci/credential`],
        [
            "GET",
            `/issuers/${unknown}/status-management/status-list-aggregation`,
        ],
        ["GET", `/issuers/${unknown}/credentials-metadata/vct/pid`],
        ["GET", `/issuers/${unknown}/trust-list/some-list`],
        ["POST", `/issuers/${unknown}/authorize/token`],
        ["POST", `/issuers/${unknown}/chained-as/par`],
        ["GET", `/issuers/${unknown}/vci/credential-offers/some-session`],
    ] as const)("%s %s answers 404", async (method, path) => {
        const server = request(app.getHttpServer());
        const response = await (method === "GET"
            ? server.get(path)
            : server.post(path).send({})
        ).expect(404);
        expect(response.body.message).toBe(`Tenant '${unknown}' not found`);
    });

    // A tenant created through the API has no Issuer Settings until they are
    // saved or first read, like a tenant that only verifies: it has no
    // metadata to serve.
    test.each([
        `/.well-known/openid-credential-issuer/issuers/${known}`,
        `/.well-known/oauth-authorization-server/issuers/${known}`,
        `/.well-known/oauth-authorization-server/issuers/${known}/chained-as`,
        `/.well-known/jwks.json/issuers/${known}`,
        `/.well-known/jwks.json/issuers/${known}/chained-as`,
        `/.well-known/oauth-authorization-server/issuers/${known}/authorization-servers/x`,
        `/.well-known/jwks.json/issuers/${known}/authorization-servers/x`,
    ])("GET %s answers 404 for a tenant that does not issue", async (path) => {
        const response = await request(app.getHttpServer())
            .get(path)
            .expect(404);
        expect(response.body.error).toBe("well_known_error");
    });

    test("a known tenant still reaches the handler", async () => {
        const response = await request(app.getHttpServer())
            .post(`/issuers/${known}/vci/nonce`)
            .expect(200);
        expect(response.body.c_nonce).toEqual(expect.any(String));
    });
});
