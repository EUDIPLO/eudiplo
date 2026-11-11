import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { BadRequestException, INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { NOT_A_JWT_MESSAGE } from "../../src/auth/auth.guard.js";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";
import { CLIENT_MANAGED_BY_IDENTITY_PROVIDER } from "../../src/platform/config-portability/idp-managed-clients.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { clientBundle, documentBundle } from "../shared/config-bundle.js";

const AUDIENCE = "eudiplo-api";
const TENANT = "generic-acme";
/** A tenant whose config folder has no `clients/`, as the docs advise. */
const FOLDER_TENANT = "generic-folder";

/**
 * EUDIPLO with `OIDC_PROVIDER=generic` against an identity provider that is
 * not Keycloak: discovery and keys at Authentik's paths, an issuer with a
 * trailing slash, and the roles in a nested claim.
 */
describe("Generic OIDC provider (e2e)", () => {
    let app: INestApplication<App>;
    let provider: Server;
    let base: string;
    let issuer: string;
    let configFolder: string;
    let sign: (
        claims: JWTPayload,
        options?: {
            audience?: string;
            issuer?: string;
            foreignKey?: boolean;
            typ?: string;
        },
    ) => Promise<string>;

    const as = (token: string) => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`),
        post: (path: string, body: object) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
    });

    /** A token of a person in the tenant with the given roles in the nested claim. */
    const personToken = (roles: Role[]) =>
        sign({ sub: "person-1", tenant_id: TENANT, eudiplo: { roles } });

    beforeAll(async () => {
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const foreign = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            kid: "key-1",
            alg: "RS256",
            use: "sig",
        };
        provider = createServer((req, res) => {
            const documents: Record<string, object> = {
                "/application/o/eudiplo/.well-known/openid-configuration": {
                    issuer,
                    authorization_endpoint: `${base}/application/o/authorize/`,
                    token_endpoint: `${base}/application/o/token/`,
                    jwks_uri: `${base}/application/o/eudiplo/jwks/`,
                    end_session_endpoint: `${base}/application/o/eudiplo/end-session/`,
                },
                "/application/o/eudiplo/jwks/": { keys: [jwk] },
            };
            const document = documents[req.url ?? ""];
            res.writeHead(document ? 200 : 404, {
                "content-type": "application/json",
            });
            res.end(JSON.stringify(document ?? {}));
        });
        await new Promise<void>((resolve) =>
            provider.listen(0, "127.0.0.1", resolve),
        );
        base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
        issuer = `${base}/application/o/eudiplo/`;
        sign = (claims, options = {}) =>
            new SignJWT(claims)
                .setProtectedHeader({
                    alg: "RS256",
                    kid: "key-1",
                    ...(options.typ && { typ: options.typ }),
                })
                .setIssuer(options.issuer ?? issuer)
                .setAudience(options.audience ?? AUDIENCE)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(options.foreignKey ? foreign.privateKey : privateKey);

        // The fixtures use a fixed tenant ID.
        rmSync("../../tmp/service.db", { force: true });
        // A config folder with a client file, as a Keycloak setup leaves it.
        configFolder = mkdtempSync(join(tmpdir(), "eudiplo-generic-config-"));
        mkdirSync(join(configFolder, TENANT, "clients"), { recursive: true });
        writeFileSync(
            join(configFolder, TENANT, "clients", "folder-client.json"),
            JSON.stringify({
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: {
                    clientId: "folder-client",
                    secret: "!generate",
                    roles: [Role.IssuanceOffer],
                },
            }),
        );
        mkdirSync(join(configFolder, FOLDER_TENANT));
        writeFileSync(
            join(configFolder, FOLDER_TENANT, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Folder" },
            }),
        );
        vi.stubEnv("CONFIG_FOLDER", configFolder);
        vi.stubEnv("OIDC", issuer);
        vi.stubEnv("OIDC_PROVIDER", "generic");
        vi.stubEnv("OIDC_AUDIENCE", AUDIENCE);
        vi.stubEnv("OIDC_ROLES_CLAIM", "eudiplo.roles");
        vi.stubEnv("OIDC_UI_CLIENT_ID", "eudiplo-console");
        vi.stubEnv("CONFIG_IMPORT_MODE", "disabled");
        // AppModule reads the environment when it is imported.
        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();

        const operator = await sign({
            sub: "operator",
            eudiplo: { roles: [Role.Tenants] },
        });
        await as(operator)
            .post("/tenant", { id: TENANT, name: "Acme" })
            .expect(201);
        await as(operator)
            .post("/tenant", { id: FOLDER_TENANT, name: "Folder" })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
        await new Promise((resolve) => provider?.close(resolve));
        vi.unstubAllEnvs();
        if (configFolder)
            rmSync(configFolder, { recursive: true, force: true });
    });

    test("accepts the provider's token and resolves its tenant and nested roles", async () => {
        // Session counts need a tenant and sessions:read.
        const reader = await as(await personToken([Role.SessionsRead])).get(
            "/session/stats",
        );
        const keyManager = await as(await personToken([Role.Keys])).get(
            "/session/stats",
        );

        expect(reader.status).toBe(200);
        expect(keyManager.status).toBe(403);
    });

    test("tells the Web Client the tenant and the roles of OIDC_ROLES_CLAIM", async () => {
        const response = await as(
            await personToken([Role.SessionsRead, Role.IssuanceOffer]),
        )
            .get("/auth/me")
            .expect(200);

        expect(response.body).toEqual({
            subject: "person-1",
            tenantId: TENANT,
            roles: [Role.SessionsRead, Role.IssuanceOffer],
        });
    });

    test("grants no roles for a roles claim that is a string, not a list", async () => {
        const token = await sign({
            sub: "person-1",
            tenant_id: TENANT,
            eudiplo: { roles: Role.SessionsRead },
        });

        const response = await as(token).get("/auth/me").expect(200);

        expect(response.body.roles).toEqual([]);
    });

    test("tells the Web Client no tenant for a token whose tenant does not exist", async () => {
        const token = await sign({
            sub: "person-1",
            tenant_id: "no-such-tenant",
            eudiplo: { roles: [Role.SessionsRead] },
        });

        const response = await as(token).get("/auth/me").expect(200);

        expect(response.body).toEqual({
            subject: "person-1",
            tenantId: null,
            roles: [Role.SessionsRead],
        });
    });

    test.each([
        ["without a tenant claim", undefined],
        ["whose tenant does not exist", "no-such-tenant"],
    ])(
        "refuses tenant endpoints with 403 for a token %s",
        async (_, tenant) => {
            const token = await sign({
                sub: "person-1",
                ...(tenant && { tenant_id: tenant }),
                eudiplo: {
                    roles: [Role.Issuances, Role.SessionsRead, Role.Keys],
                },
            });

            for (const path of [
                "/issuer/credentials",
                "/session/stats",
                "/key-chain",
            ]) {
                const response = await as(token).get(path);

                expect({
                    path,
                    status: response.status,
                    message: response.body.message,
                }).toEqual({
                    path,
                    status: 403,
                    message:
                        "This endpoint requires a tenant context. Use a tenant-bound account.",
                });
            }
        },
    );

    test("serves the instance's routes to a token without a tenant", async () => {
        const token = await sign({
            sub: "person-1",
            eudiplo: { roles: [Role.Issuances] },
        });

        await as(token).get("/cache/stats").expect(200);
        await request(app.getHttpServer())
            .delete("/cache/trust-list")
            .set("Authorization", `Bearer ${token}`)
            .expect(204);
        // Forgetting sequence numbers acts on the caller's tenant.
        const response = await request(app.getHttpServer())
            .delete("/cache/trust-list/sequence-numbers")
            .set("Authorization", `Bearer ${token}`)
            .expect(403);
        expect(response.body.message).toBe(
            "This endpoint requires a tenant context. Use a tenant-bound account.",
        );
    });

    test("tells the Web Client no subject for a token without sub", async () => {
        const token = await sign({
            tenant_id: TENANT,
            eudiplo: { roles: [Role.SessionsRead] },
        });

        const response = await as(token).get("/auth/me").expect(200);

        expect(response.body.subject).toBeNull();
    });

    test("refuses a token for another audience", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { audience: "other-app" },
        );

        const response = await as(token).get("/session/stats");

        expect(response.status).toBe(401);
    });

    test("accepts an RFC 9068 access token", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { typ: "at+jwt" },
        );

        const response = await as(token).get("/auth/me").expect(200);

        expect(response.body).toEqual({
            subject: "person-1",
            tenantId: TENANT,
            roles: [Role.SessionsRead],
        });
    });

    test("refuses an ID token that carries the audience too", async () => {
        // Zitadel puts the project ID into the audience of both tokens.
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
                nonce: "n-0S6_WzA2Mj",
                at_hash: "77QmUPtjPfzWtF2AnpK9RQ",
            },
            { typ: "JWT" },
        );

        const response = await as(token).get("/session/stats").expect(401);

        expect(response.body.message).toBe(
            "Not an access token: the token carries at_hash, which only ID tokens carry; send the access token",
        );
    });

    test("refuses a token whose type is not an access token's", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { typ: "logout+jwt" },
        );

        const response = await as(token).get("/session/stats").expect(401);

        expect(response.body.message).toBe(
            "Not an access token: its header names another typ than at+jwt or JWT",
        );
    });

    test("refuses a token whose header does not decode with the generic reason", async () => {
        const response = await as("not-base64!.e30.sig")
            .get("/session/stats")
            .expect(401);

        expect(response.body.message).toBe("Unauthorized");
    });

    test("refuses a token of another issuer, also one without the trailing slash", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { issuer: issuer.slice(0, -1) },
        );

        const response = await as(token).get("/session/stats");

        expect(response.status).toBe(401);
    });

    test("refuses a token signed with another key", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { foreignKey: true },
        );

        const response = await as(token).get("/session/stats");

        expect(response.status).toBe(401);
    });

    test("names a bearer token that is no JWT", async () => {
        const response = await as("opaque-zitadel-token")
            .get("/session/stats")
            .expect(401);

        expect(response.body.message).toBe(NOT_A_JWT_MESSAGE);
    });

    test("leaves clients and people to the identity provider", async () => {
        const token = await personToken([Role.Clients, Role.Users]);

        expect((await as(token).get("/client")).status).toBe(501);
        expect((await as(token).get("/user")).status).toBe(501);
    });

    test("refuses to create a client even when a record of an earlier mode has its ID", async () => {
        await app.get(getRepositoryToken(ClientEntity)).save({
            clientId: "generic-leftover",
            tenantId: TENANT,
            roles: [Role.IssuanceOffer],
        });

        const response = await as(await personToken([Role.Clients])).post(
            "/client",
            { clientId: "generic-leftover", roles: [Role.Clients] },
        );

        // Not 409 "already in use": the record cannot be replaced anyway.
        expect(response.status).toBe(501);
        expect(response.body).toMatchObject({
            error: "Not Implemented",
            message:
                "Clients are managed in the identity provider (OIDC_PROVIDER=generic).",
        });
    });

    test("creates a tenant with an empty roles list, without an admin client", async () => {
        const operator = await sign({
            sub: "operator",
            eudiplo: { roles: [Role.Tenants] },
        });

        const response = await as(operator)
            .post("/tenant", { id: "generic-empty", name: "Empty", roles: [] })
            .expect(201);

        expect(response.body.client).toBeUndefined();
    });

    test("refuses a tenant with an admin client before it creates the tenant", async () => {
        const operator = await sign({
            sub: "operator",
            eudiplo: { roles: [Role.Tenants] },
        });

        await as(operator)
            .post("/tenant", {
                id: "generic-half",
                name: "Half",
                roles: [Role.IssuanceOffer],
            })
            .expect(501);
        const tenants = await as(operator).get("/tenant").expect(200);
        expect(
            tenants.body.map((tenant: { id: string }) => tenant.id),
        ).not.toContain("generic-half");
    });

    test("advertises the provider's endpoints and the Web Client's client there", async () => {
        const response = await request(app.getHttpServer())
            .get("/.well-known/oauth-authorization-server")
            .expect(200);

        expect(response.body).toMatchObject({
            issuer,
            token_endpoint: `${base}/application/o/token/`,
            jwks_uri: `${base}/application/o/eudiplo/jwks/`,
            ui_client_id: "eudiplo-console",
            oidc_provider: "generic",
        });
    });

    test("tells the Web Client that the provider manages clients and people", async () => {
        const response = await as(await personToken([Role.SessionsRead]))
            .get("/frontend-config")
            .expect(200);

        expect(response.body.authMode).toBe("generic");
    });

    test("has no built-in token endpoint", async () => {
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: "root",
                client_secret: "root",
            })
            .expect(401);

        // Not the 401 for wrong credentials, which root/root also are.
        expect(response.body.message).toBe(
            "OAuth2 token endpoint is not available when using external OIDC provider. Use your external OIDC provider for authentication.",
        );
    });

    describe("configuration bundles", () => {
        const admin = () => personToken([Role.TenantAdmin]);

        /** A client record as Keycloak or the built-in server left it. */
        const leaveClientRecord = (clientId: string, tenantId = TENANT) =>
            app.get(getRepositoryToken(ClientEntity)).save({
                clientId,
                tenantId,
                roles: [Role.IssuanceOffer],
            });

        test("exports no clients and names the records left from an earlier mode", async () => {
            await leaveClientRecord("generic-export-leftover");

            const response = await as(await admin())
                .get("/config-bundles/export")
                .expect(200);

            expect(
                response.body.manifest.resources.map(
                    (resource: { kind: string }) => resource.kind,
                ),
            ).not.toContain("Client");
            expect(response.body.manifest.warnings).toContainEqual(
                expect.objectContaining({
                    code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
                    resource: { kind: "Client", id: "generic-export-leftover" },
                }),
            );
        });

        test("exports no client document either", async () => {
            await leaveClientRecord("generic-document-leftover");

            const response = await as(await admin())
                .get(
                    "/config-bundles/resources/Client/generic-document-leftover/document",
                )
                .expect(501);

            expect(response.body.message).toBe(
                "Clients are managed in the identity provider (OIDC_PROVIDER=generic).",
            );
        });

        test("blocks a client document in the plan instead of failing the whole request", async () => {
            const bundle = clientBundle(TENANT, {
                clientId: "generic-bundled",
                secret: "!generate",
                roles: [Role.IssuanceOffer],
            });

            const planned = await as(await admin())
                .post("/config-bundles/plan?mode=upsert", bundle)
                .expect(201);

            expect(planned.body.applicable).toBe(false);
            expect(planned.body.items).toEqual([
                expect.objectContaining({
                    kind: "Client",
                    id: "generic-bundled",
                    action: "blocked",
                    issues: expect.arrayContaining([
                        expect.objectContaining({
                            severity: "error",
                            code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
                        }),
                    ]),
                }),
            ]);
        });

        test("refuses to import a client document", async () => {
            const bundle = clientBundle(TENANT, {
                clientId: "generic-imported",
                secret: "!generate",
                roles: [Role.IssuanceOffer],
            });
            const planned = await as(await admin())
                .post("/config-bundles/plan?mode=upsert", bundle)
                .expect(201);

            const response = await as(await admin())
                .post(
                    `/config-bundles/import?mode=upsert&planFingerprint=${planned.body.planFingerprint}`,
                    bundle,
                )
                .expect(400);

            expect(response.body.code).toBe("CONFIG_APPLY_BLOCKED");
            expect(
                await app
                    .get(getRepositoryToken(ClientEntity))
                    .countBy({ clientId: "generic-imported" }),
            ).toBe(0);
        });

        test("refuses the folder import of a tenant whose config folder has a client file", async () => {
            const failure = await app
                .get(ConfigFolderBundleService)
                .applyTenantFolder(TENANT, "upsert")
                .then(
                    () => undefined,
                    (error: BadRequestException) => error.getResponse(),
                );

            expect(failure).toMatchObject({
                code: "CONFIG_APPLY_BLOCKED",
                plan: {
                    items: expect.arrayContaining([
                        expect.objectContaining({
                            kind: "Client",
                            id: "folder-client",
                            action: "blocked",
                            issues: expect.arrayContaining([
                                expect.objectContaining({
                                    code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
                                }),
                            ]),
                        }),
                    ]),
                },
            });
            expect(
                await app
                    .get(getRepositoryToken(ClientEntity))
                    .countBy({ clientId: "folder-client" }),
            ).toBe(0);
        });

        test("keeps a client record in replace mode that the bundle no longer has", async () => {
            await leaveClientRecord("generic-replace-leftover");
            await app.get(ConfigOwnershipService).markApplied({
                tenantId: TENANT,
                kind: "Client",
                resourceId: "generic-replace-leftover",
                ownership: "file-managed",
                source: `bundle:${TENANT}`,
            });
            const bundle = documentBundle(
                TENANT,
                "Tenant",
                "tenant",
                "tenant.json",
                {
                    name: "Acme",
                },
            );

            const planned = await as(await admin())
                .post("/config-bundles/plan?mode=replace", bundle)
                .expect(201);
            expect(planned.body.items).toContainEqual(
                expect.objectContaining({
                    kind: "Client",
                    id: "generic-replace-leftover",
                    action: "skip",
                    issues: [
                        expect.objectContaining({
                            severity: "warning",
                            code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
                        }),
                    ],
                }),
            );
            await as(await admin())
                .post(
                    `/config-bundles/import?mode=replace&confirmReplace=true&planFingerprint=${planned.body.planFingerprint}`,
                    bundle,
                )
                .expect(201);

            expect(
                await app
                    .get(getRepositoryToken(ClientEntity))
                    .countBy({ clientId: "generic-replace-leftover" }),
            ).toBe(1);
        });

        test("keeps and logs a client record in a folder replace that the folder no longer has", async () => {
            await leaveClientRecord("generic-folder-leftover", FOLDER_TENANT);
            await app.get(ConfigOwnershipService).markApplied({
                tenantId: FOLDER_TENANT,
                kind: "Client",
                resourceId: "generic-folder-leftover",
                ownership: "file-managed",
                source: `folder:${join(configFolder, FOLDER_TENANT)}`,
            });
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            try {
                await app
                    .get(ConfigFolderBundleService)
                    .applyTenantFolder(FOLDER_TENANT, "replace");

                expect(warn).toHaveBeenCalledWith(
                    expect.stringContaining(
                        `[${FOLDER_TENANT}] Skipped Client 'generic-folder-leftover' (${CLIENT_MANAGED_BY_IDENTITY_PROVIDER})`,
                    ),
                );
            } finally {
                warn.mockRestore();
            }
            expect(
                await app
                    .get(getRepositoryToken(ClientEntity))
                    .countBy({ clientId: "generic-folder-leftover" }),
            ).toBe(1);
        });
    });
});
