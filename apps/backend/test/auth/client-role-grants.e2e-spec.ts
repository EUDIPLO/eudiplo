import { rmSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { AppModule } from "../../src/app.module.js";
import {
    CLIENTS_PROVIDER,
    ClientsProvider,
} from "../../src/auth/client/client.provider.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { clientBundle } from "../shared/config-bundle.js";

/**
 * A client manager can only grant the roles it holds, and only act on
 * clients whose roles it holds or may grant, so it cannot widen its own
 * rights through `/api/client` or a configuration bundle.
 */
describe("Client role grants (e2e)", () => {
    const tenantId = "client-role-grants";
    const adminClientId = `${tenantId}-admin`;
    const otherTenantId = "client-role-grants-other";
    const platformTenantId = "client-role-grants-platform";
    let app: INestApplication<App>;
    let rootClientId: string;
    let rootSecret: string;
    let rootToken: string;
    let adminToken: string;
    let adminSecret: string;
    let managerToken: string;
    let otherAdminToken: string;
    let platformAdminToken: string;
    let platformTenantAdminToken: string;

    function tokenFor(clientId: string, secret: string) {
        return request(app.getHttpServer()).post("/api/oauth2/token").send({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: secret,
        });
    }

    async function accessToken(clientId: string, secret: string) {
        const response = await tokenFor(clientId, secret).expect(201);
        return response.body.access_token as string;
    }

    function createClient(token: string, clientId: string, roles: Role[]) {
        return request(app.getHttpServer())
            .post("/client")
            .set("Authorization", `Bearer ${token}`)
            .send({ clientId, roles });
    }

    async function createTenant(id: string, roles: Role[]) {
        const response = await request(app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${rootToken}`)
            .send({ id, name: id, roles })
            .expect(201);
        return response.body.client as {
            clientId: string;
            clientSecret: string;
        };
    }

    /**
     * Lets the provider report a client that a create would take over, as
     * Keycloak does for a client of the tenant EUDIPLO has no record of. The
     * built-in authorization server knows no such client.
     */
    function takeoverOfClientWith(roles: string[]) {
        return vi
            .spyOn(
                app.get<ClientsProvider>(CLIENTS_PROVIDER),
                "getReplacedClientRoles",
            )
            .mockResolvedValue(roles);
    }

    function getClient(token: string, clientId: string) {
        return request(app.getHttpServer())
            .get(`/client/${clientId}`)
            .set("Authorization", `Bearer ${token}`);
    }

    beforeAll(async () => {
        // The fixtures use fixed client IDs, which are unique across tenants.
        rmSync("../../tmp/service.db", { force: true });
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        // Maps unknown and duplicate clients to 404 and 409 as in production.
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();

        const config = app.get(ConfigService);
        rootClientId = config.getOrThrow<string>("AUTH_CLIENT_ID");
        rootSecret = config.getOrThrow<string>("AUTH_CLIENT_SECRET");
        rootToken = await accessToken(rootClientId, rootSecret);

        // The tenant's admin client gets clients:manage plus these roles.
        const admin = await createTenant(tenantId, [
            Role.Issuances,
            Role.TenantAdmin,
        ]);
        adminSecret = admin.clientSecret;
        adminToken = await accessToken(adminClientId, adminSecret);

        // A narrower client manager, created by the tenant admin.
        const manager = await createClient(adminToken, "grants-manager", [
            Role.Clients,
            Role.IssuanceOffer,
        ]).expect(201);
        managerToken = await accessToken(
            "grants-manager",
            manager.body.clientSecret,
        );
        for (const [clientId, roles] of [
            ["grants-offer", [Role.IssuanceOffer]],
            ["grants-update", [Role.IssuanceOffer]],
            ["grants-delete", [Role.IssuanceOffer]],
            ["grants-registrar", [Role.Registrar, Role.Presentations]],
        ] as const) {
            await createClient(adminToken, clientId, [...roles]).expect(201);
        }

        const otherAdmin = await createTenant(otherTenantId, [
            Role.IssuanceOffer,
        ]);
        otherAdminToken = await accessToken(
            otherAdmin.clientId,
            otherAdmin.clientSecret,
        );
        await createClient(otherAdminToken, "grants-other-offer", [
            Role.IssuanceOffer,
        ]).expect(201);

        // A tenant whose admin client holds tenants:manage, next to a client
        // with only tenant:admin.
        const platformAdmin = await createTenant(platformTenantId, [
            Role.Tenants,
        ]);
        platformAdminToken = await accessToken(
            platformAdmin.clientId,
            platformAdmin.clientSecret,
        );
        const platformTenantAdmin = await createClient(
            platformAdminToken,
            "grants-platform-tenant-admin",
            [Role.Clients, Role.TenantAdmin],
        ).expect(201);
        platformTenantAdminToken = await accessToken(
            "grants-platform-tenant-admin",
            platformTenantAdmin.body.clientSecret,
        );
        for (const clientId of [
            "grants-platform-peer",
            "grants-platform-keep",
        ]) {
            await createClient(platformAdminToken, clientId, [
                Role.TenantAdmin,
            ]).expect(201);
        }
    });

    afterAll(async () => {
        await app?.close();
    });

    describe("create", () => {
        test("grants a role the caller holds", async () => {
            const response = await createClient(
                managerToken,
                "grants-created",
                [Role.IssuanceOffer],
            ).expect(201);
            expect(response.body.roles).toEqual([Role.IssuanceOffer]);
        });

        test.each([
            Role.Registrar,
            Role.Issuances,
            Role.Users,
            Role.TenantAdmin,
            Role.Tenants,
        ])("refuses %s, which the caller does not hold", async (role) => {
            const response = await createClient(
                managerToken,
                `grants-denied-${role.replace(":", "-")}`,
                [Role.IssuanceOffer, role],
            ).expect(403);
            expect(response.body.message).toContain(`Cannot grant ${role}`);
        });

        test("tenant:admin grants every role except the reserved ones", async () => {
            const created = await createClient(
                adminToken,
                "grants-by-tenant-admin",
                [Role.Registrar, Role.Users],
            ).expect(201);
            expect(created.body.roles).toEqual([Role.Registrar, Role.Users]);
            const refused = await createClient(
                adminToken,
                "grants-tenant-admin",
                [Role.TenantAdmin],
            ).expect(403);
            expect(refused.body.message).toContain(
                `Cannot grant ${Role.TenantAdmin}`,
            );
        });

        test("refuses the ID of another tenant's client and leaves it alone", async () => {
            await createClient(managerToken, "grants-other-offer", [
                Role.IssuanceOffer,
            ]).expect(409);
            const other = await getClient(
                otherAdminToken,
                "grants-other-offer",
            ).expect(200);
            expect(other.body.tenantId).toBe(otherTenantId);
        });

        test("tenant creation does not take over a client with the admin client's ID", async () => {
            const squatted = `${tenantId}-squat-admin`;
            await createClient(managerToken, squatted, [
                Role.IssuanceOffer,
            ]).expect(201);
            await request(app.getHttpServer())
                .post("/tenant")
                .set("Authorization", `Bearer ${rootToken}`)
                .send({
                    id: `${tenantId}-squat`,
                    name: "squat",
                    roles: [Role.Issuances],
                })
                .expect(409);
            const client = await getClient(managerToken, squatted).expect(200);
            expect(client.body.tenantId).toBe(tenantId);
            await request(app.getHttpServer())
                .get(`/tenant/${tenantId}-squat`)
                .set("Authorization", `Bearer ${rootToken}`)
                .expect(404);
        });

        test("creating an existing tenant again updates its admin client", async () => {
            const id = `${tenantId}-recreated`;
            const first = await createTenant(id, [Role.IssuanceOffer]);
            const second = await createTenant(id, [
                Role.IssuanceOffer,
                Role.Registrar,
            ]);
            expect(second.clientId).toBe(first.clientId);
            await tokenFor(second.clientId, second.clientSecret).expect(201);
            await tokenFor(first.clientId, first.clientSecret).expect(401);
            const token = await accessToken(
                second.clientId,
                second.clientSecret,
            );
            const client = await getClient(token, second.clientId).expect(200);
            expect(client.body.roles).toContain(Role.Registrar);
        });

        test("refuses to take over a client with a role the caller does not hold", async () => {
            const takeover = takeoverOfClientWith([Role.TenantAdmin]);
            try {
                const response = await createClient(
                    managerToken,
                    "grants-takeover",
                    [Role.IssuanceOffer],
                ).expect(403);
                expect(response.body.message).toContain(
                    "Cannot manage client grants-takeover",
                );
                expect(takeover).toHaveBeenCalledWith(
                    tenantId,
                    "grants-takeover",
                );
            } finally {
                takeover.mockRestore();
            }
            await getClient(adminToken, "grants-takeover").expect(404);
        });

        test("refuses the root client's ID", async () => {
            const response = await createClient(managerToken, rootClientId, [
                Role.IssuanceOffer,
            ]).expect(409);
            expect(response.body.message).toBe(
                `Client ID '${rootClientId}' is already in use`,
            );
            await tokenFor(rootClientId, rootSecret).expect(201);
        });
    });

    describe("update", () => {
        test("changes a client with roles the caller holds", async () => {
            await request(app.getHttpServer())
                .patch("/client/grants-update")
                .set("Authorization", `Bearer ${managerToken}`)
                .send({
                    description: "changed",
                    roles: [Role.IssuanceOffer, Role.Clients],
                })
                .expect(200);
            const client = await getClient(adminToken, "grants-update").expect(
                200,
            );
            expect(client.body).toMatchObject({
                description: "changed",
                roles: [Role.IssuanceOffer, Role.Clients],
            });
        });

        test("refuses to add a role the caller does not hold", async () => {
            await request(app.getHttpServer())
                .patch("/client/grants-offer")
                .set("Authorization", `Bearer ${managerToken}`)
                .send({ roles: [Role.IssuanceOffer, Role.Registrar] })
                .expect(403);
            const client = await getClient(adminToken, "grants-offer").expect(
                200,
            );
            expect(client.body.roles).toEqual([Role.IssuanceOffer]);
        });

        test("refuses to change a client with more roles, even without new roles", async () => {
            const response = await request(app.getHttpServer())
                .patch("/client/grants-registrar")
                .set("Authorization", `Bearer ${managerToken}`)
                .send({ description: "taken over" })
                .expect(403);
            expect(response.body.message).toContain(
                `Cannot manage client grants-registrar: it has ${Role.Registrar}`,
            );
        });

        test("a tenant:admin caller keeps tenant:admin on a client", async () => {
            await request(app.getHttpServer())
                .patch(`/client/${adminClientId}`)
                .set("Authorization", `Bearer ${adminToken}`)
                .send({
                    description: "tenant admin",
                    roles: [Role.Clients, Role.Issuances, Role.TenantAdmin],
                })
                .expect(200);
            const client = await getClient(adminToken, adminClientId).expect(
                200,
            );
            expect(client.body.roles).toContain(Role.TenantAdmin);
        });

        test("answers 404 for an unknown client", async () => {
            const response = await request(app.getHttpServer())
                .patch("/client/grants-unknown")
                .set("Authorization", `Bearer ${managerToken}`)
                .send({ description: "missing" })
                .expect(404);
            expect(response.body.message).toBe(
                "Client 'grants-unknown' not found",
            );
        });
    });

    describe("rotate secret", () => {
        test("refuses a client with roles the caller does not hold", async () => {
            const response = await request(app.getHttpServer())
                .post(`/client/${adminClientId}/rotate-secret`)
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(403);
            expect(response.body.message).toContain(
                `Cannot manage client ${adminClientId}`,
            );
            expect(response.body.secret).toBeUndefined();
            await tokenFor(adminClientId, adminSecret).expect(201);
        });

        test("rotates a client with roles the caller holds", async () => {
            const response = await request(app.getHttpServer())
                .post("/client/grants-offer/rotate-secret")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(201);
            expect(response.body.secret).toEqual(expect.any(String));
            await tokenFor("grants-offer", response.body.secret).expect(201);
        });

        test("a tenant:admin caller rotates a tenant:admin client", async () => {
            const response = await request(app.getHttpServer())
                .post("/client/grants-platform-peer/rotate-secret")
                .set("Authorization", `Bearer ${platformTenantAdminToken}`)
                .expect(201);
            await tokenFor("grants-platform-peer", response.body.secret).then(
                (token) => expect(token.status).toBe(201),
            );
        });

        test("the root client rotates any client", async () => {
            const response = await request(app.getHttpServer())
                .post("/client/grants-registrar/rotate-secret")
                .set("Authorization", `Bearer ${rootToken}`)
                .expect(201);
            await tokenFor("grants-registrar", response.body.secret).then(
                (token) => expect(token.status).toBe(201),
            );
        });

        test("answers 404 for an unknown client", async () => {
            const response = await request(app.getHttpServer())
                .post("/client/grants-unknown/rotate-secret")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(404);
            expect(response.body.message).toBe(
                "Client 'grants-unknown' not found",
            );
        });
    });

    describe("delete", () => {
        test("refuses a client with roles the caller does not hold", async () => {
            const response = await request(app.getHttpServer())
                .delete("/client/grants-registrar")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(403);
            expect(response.body.message).toContain(
                "Cannot manage client grants-registrar",
            );
            await getClient(adminToken, "grants-registrar").expect(200);
        });

        test("deletes a client with roles the caller holds", async () => {
            await request(app.getHttpServer())
                .delete("/client/grants-delete")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(204);
            const clients = await request(app.getHttpServer())
                .get("/client")
                .set("Authorization", `Bearer ${adminToken}`)
                .expect(200);
            expect(
                clients.body.map(
                    (client: { clientId: string }) => client.clientId,
                ),
            ).not.toContain("grants-delete");
        });

        test("stays a no-op for an unknown client", async () => {
            const response = await request(app.getHttpServer())
                .delete("/client/grants-unknown")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(204);
            expect(response.body).toEqual({});
        });
    });

    describe("tenant isolation", () => {
        test("does not reach a client of another tenant", async () => {
            await request(app.getHttpServer())
                .patch("/client/grants-other-offer")
                .set("Authorization", `Bearer ${managerToken}`)
                .send({ description: "foreign" })
                .expect(404);
            await request(app.getHttpServer())
                .post("/client/grants-other-offer/rotate-secret")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(404);
            await request(app.getHttpServer())
                .delete("/client/grants-other-offer")
                .set("Authorization", `Bearer ${managerToken}`)
                .expect(204);
            const other = await getClient(
                otherAdminToken,
                "grants-other-offer",
            ).expect(200);
            expect(other.body.tenantId).toBe(otherTenantId);
            expect(other.body.description).not.toBe("foreign");
        });
    });

    describe("configuration bundle", () => {
        function plan(bundle: object) {
            return request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${platformTenantAdminToken}`)
                .send(bundle);
        }

        test("refuses to rotate the secret of a client with more roles", async () => {
            const bundle = clientBundle(platformTenantId, {
                clientId: `${platformTenantId}-admin`,
                secret: "!generate",
                roles: [Role.Clients],
            });
            const planned = await plan(bundle).expect(403);
            expect(planned.body.message).toContain(
                `Cannot manage client ${platformTenantId}-admin`,
            );
            const imported = await request(app.getHttpServer())
                .post(
                    `/config-bundles/import?mode=upsert&planFingerprint=${"0".repeat(64)}`,
                )
                .set("Authorization", `Bearer ${platformTenantAdminToken}`)
                .send(bundle)
                .expect(403);
            expect(imported.body.message).toContain("Cannot manage client");
        });

        test("lets a client keep a role the caller may not grant", async () => {
            const bundle = clientBundle(platformTenantId, {
                clientId: "grants-platform-keep",
                secret: "!generate",
                description: "kept tenant:admin",
                roles: [Role.TenantAdmin],
            });
            const planned = await plan(bundle);
            expect(planned.status, JSON.stringify(planned.body)).toBe(201);
            await request(app.getHttpServer())
                .post(
                    `/config-bundles/import?mode=upsert&planFingerprint=${planned.body.planFingerprint}`,
                )
                .set("Authorization", `Bearer ${platformTenantAdminToken}`)
                .send(bundle)
                .then((response) =>
                    expect(response.status, JSON.stringify(response.body)).toBe(
                        201,
                    ),
                );
        });

        test("refuses to add a role the caller may not grant", async () => {
            const planned = await plan(
                clientBundle(platformTenantId, {
                    clientId: "grants-platform-new",
                    secret: "!generate",
                    roles: [Role.TenantAdmin],
                }),
            ).expect(403);
            expect(planned.body.message).toContain("Cannot grant tenant:admin");
        });

        test("refuses to create a client that takes over one with more roles", async () => {
            const bundle = clientBundle(platformTenantId, {
                clientId: "grants-platform-takeover",
                secret: "!generate",
                roles: [Role.IssuanceOffer],
            });
            const takeover = takeoverOfClientWith([Role.Tenants]);
            try {
                const planned = await plan(bundle).expect(403);
                expect(planned.body.message).toContain(
                    "Cannot manage client grants-platform-takeover",
                );
                const imported = await request(app.getHttpServer())
                    .post(
                        `/config-bundles/import?mode=upsert&planFingerprint=${"0".repeat(64)}`,
                    )
                    .set("Authorization", `Bearer ${platformTenantAdminToken}`)
                    .send(bundle)
                    .expect(403);
                expect(imported.body.message).toContain(
                    "Cannot manage client grants-platform-takeover",
                );
            } finally {
                takeover.mockRestore();
            }
        });

        test("a takeover needs the right to grant every requested role, also one the client has", async () => {
            const takeover = takeoverOfClientWith([Role.TenantAdmin]);
            try {
                const planned = await plan(
                    clientBundle(platformTenantId, {
                        clientId: "grants-platform-takeover",
                        secret: "!generate",
                        roles: [Role.TenantAdmin],
                    }),
                ).expect(403);
                expect(planned.body.message).toContain(
                    "Cannot grant tenant:admin",
                );
            } finally {
                takeover.mockRestore();
            }
        });

        test("blocks a client ID that another tenant uses", async () => {
            const planned = await plan(
                clientBundle(platformTenantId, {
                    clientId: "grants-other-offer",
                    secret: "!generate",
                    roles: [Role.IssuanceOffer],
                }),
            ).expect(201);
            expect(planned.body.applicable).toBe(false);
            expect(planned.body.items[0]).toMatchObject({
                action: "blocked",
                issues: [expect.objectContaining({ code: "CLIENT_ID_TAKEN" })],
            });
        });
    });
});
