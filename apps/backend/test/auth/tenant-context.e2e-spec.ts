import { rmSync } from "node:fs";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { INestApplication } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import { ConfigService } from "@nestjs/config";
import { MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { ROLES_KEY } from "../../src/auth/roles/roles.decorator.js";
import { TENANT_CONTEXT_KEY } from "../../src/auth/tenant-context.guard.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";

const TENANT_CONTEXT_MESSAGE =
    "This endpoint requires a tenant context. Use a tenant-bound account.";

/**
 * `@Secured` routes act on the caller's tenant and refuse a token without
 * one with 403, unless they are marked `tenant: "optional"`. The root client
 * of the built-in server has no tenant.
 */
describe("Tenant context (e2e)", () => {
    const tenantId = "tenant-context";
    let app: INestApplication<App>;
    let rootToken: string;
    let tenantClientId: string;

    const as = (token: string) => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`),
        post: (path: string, body: object = {}) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
    });

    beforeAll(async () => {
        rmSync("../../tmp/service.db", { force: true });
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();

        const config = app.get(ConfigService);
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: config.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret: config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201);
        rootToken = response.body.access_token;
        const tenant = await as(rootToken)
            .post("/tenant", {
                id: tenantId,
                name: tenantId,
                roles: [Role.IssuanceOffer],
            })
            .expect(201);
        tenantClientId = tenant.body.client.clientId;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("needs a tenant on every secured route except the listed ones", () => {
        const reflector = new Reflector();
        const optional: string[] = [];
        for (const module of app.get(ModulesContainer).values()) {
            for (const { metatype } of module.controllers.values()) {
                const prototype = (metatype as { prototype: object }).prototype;
                for (const name of new MetadataScanner().getAllMethodNames(
                    prototype,
                )) {
                    const handler = (prototype as Record<string, object>)[name];
                    const targets = [handler, metatype as object];
                    if (
                        !Reflect.hasMetadata(PATH_METADATA, handler) ||
                        !reflector.getAllAndOverride(ROLES_KEY, targets)
                    ) {
                        continue;
                    }
                    const tenant = reflector.getAllAndOverride(
                        TENANT_CONTEXT_KEY,
                        targets,
                    );
                    expect(tenant).toBeDefined();
                    if (tenant !== "required") {
                        optional.push(`${metatype.name}.${name}`);
                    }
                }
            }
        }

        expect(optional.sort()).toEqual([
            "CacheController.clearAllCaches",
            "CacheController.clearStatusListCache",
            "CacheController.clearTrustListCache",
            "CacheController.getStats",
            "ClientController.rotateClientSecret",
            "ConfigPortabilityController.upgrade",
            "TenantController.deleteTenant",
            "TenantController.getTenant",
            "TenantController.getTenants",
            "TenantController.initTenant",
            "TenantController.updateTenant",
        ]);
    });

    test("serves the operator's routes to the root client, which has no tenant", async () => {
        await as(rootToken).get(`/tenant/${tenantId}`).expect(200);

        const rotated = await as(rootToken)
            .post(`/client/${tenantClientId}/rotate-secret`)
            .expect(201);
        expect(rotated.body.secret).toEqual(expect.any(String));

        const upgraded = await as(rootToken)
            .post("/config-bundles/documents/upgrade", {
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Upgraded" },
            })
            .expect(201);
        expect(upgraded.body.document).toBeDefined();

        const stats = await as(rootToken).get("/cache/stats").expect(200);
        expect(stats.body.statusListCache).toBeDefined();
    });

    test("refuses the root client on a tenant's routes with 403", async () => {
        const response = await as(rootToken).get("/config-bundles/operations");

        expect(response.status).toBe(403);
        expect(response.body.message).toBe(TENANT_CONTEXT_MESSAGE);
    });
});
