import { rmSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
    type CallToolResult,
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import request from "supertest";
import type { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// The endpoint is a route, so the flag is read when AppModule is imported.
vi.hoisted(() => {
    process.env.MCP_ENABLED = "true";
});

import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { GLOBAL_PREFIX_EXCLUSIONS } from "../../src/main.helpers.js";
import { ValidationErrorFilter } from "../../src/shared/common/filters/validation-error.filter.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { federationKey } from "../federation/federation-fixture.js";

const CLAIM_VALUE = "Erika-Mustermann-MCP";

/**
 * The MCP endpoint behind MCP_ENABLED, served as in production (global
 * `/api` prefix and exception filters) and called with the MCP SDK client
 * over Streamable HTTP.
 */
describe("MCP endpoint (e2e)", () => {
    let app: INestApplication<App>;
    let endpoint: URL;
    let rootToken: string;
    let adminToken: string;
    let otherTenantToken: string;
    let verifierToken: string;
    const clients: Client[] = [];

    const api = () => request(app.getHttpServer());

    async function token(clientId: string, clientSecret: string) {
        const response = await api()
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            })
            .expect(201);
        return response.body.access_token as string;
    }

    async function createTenant(id: string, roles: Role[]) {
        const response = await api()
            .post("/api/tenant")
            .set("Authorization", `Bearer ${rootToken}`)
            .send({ id, name: `${id} tenant`, roles })
            .expect(201);
        return token(
            response.body.client.clientId,
            response.body.client.clientSecret,
        );
    }

    async function createClient(clientId: string, roles: Role[]) {
        const response = await api()
            .post("/api/client")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({ clientId, roles })
            .expect(201);
        return token(clientId, response.body.clientSecret);
    }

    async function connect(accessToken: string) {
        const client = new Client({ name: "eudiplo-e2e", version: "1.0.0" });
        await client.connect(
            new StreamableHTTPClientTransport(endpoint, {
                requestInit: {
                    headers: { Authorization: `Bearer ${accessToken}` },
                },
            }),
        );
        clients.push(client);
        return client;
    }

    async function call(
        accessToken: string,
        name: string,
        args: Record<string, unknown> = {},
    ) {
        const client = await connect(accessToken);
        return (await client.callTool({
            name,
            arguments: args,
        })) as CallToolResult;
    }

    const textOf = (result: CallToolResult) =>
        result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
    const jsonOf = (result: CallToolResult) => {
        expect(result.isError, textOf(result)).toBeFalsy();
        return JSON.parse(textOf(result));
    };

    /** A JSON-RPC request to the endpoint without the MCP client. */
    const rawPost = (
        authorization?: string,
        headers: Record<string, string> = {},
    ) =>
        fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                ...(authorization && { Authorization: authorization }),
                ...headers,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
            }),
        });

    beforeAll(async () => {
        rmSync("../../tmp/service.db", { force: true });
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.setGlobalPrefix("api", { exclude: GLOBAL_PREFIX_EXCLUSIONS });
        app.useGlobalFilters(
            new ValidationErrorFilter(),
            new AllExceptionsFilter(),
        );
        app.useGlobalPipes(createAppValidationPipe());
        const config = app.get(ConfigService);
        config.set("CONFIG_IMPORT_MODE", "disabled");
        await app.listen(0, "127.0.0.1");
        endpoint = new URL("/api/mcp", await app.getUrl());

        rootToken = await token(
            config.getOrThrow("AUTH_CLIENT_ID"),
            config.getOrThrow("AUTH_CLIENT_SECRET"),
        );
        adminToken = await createTenant("mcp-acme", [
            Role.Clients,
            Role.Issuances,
            Role.IssuanceOffer,
            Role.Presentations,
            Role.PresentationRequest,
        ]);
        otherTenantToken = await createTenant("mcp-other", [
            Role.Issuances,
            Role.IssuanceOffer,
            Role.PresentationRequest,
        ]);
        verifierToken = await createClient("mcp-verifier", [
            Role.PresentationRequest,
        ]);

        const admin = `Bearer ${adminToken}`;
        await api()
            .post("/api/issuer/config")
            .set("Authorization", admin)
            .send({
                authorizationServers: [
                    { id: "issuer-built-in", type: "built-in" },
                ],
                display: [],
            })
            .expect(201);
        await api()
            .post("/api/issuer/credentials")
            .set("Authorization", admin)
            .send({
                id: "pid",
                description: "Personal ID",
                config: {
                    format: "dc+sd-jwt",
                    display: [{ name: "PID", locale: "en-US" }],
                },
                vct: "urn:eudi:pid:1",
                fields: [],
                schemaMeta: {
                    id: "https://schemas.example/pid",
                    name: "PID",
                    version: "1.0.0",
                    attestationLoS: "iso_18045_high",
                    bindingType: "key",
                    trustedAuthorities: [
                        {
                            frameworkType: "x509",
                            value: Buffer.from("root").toString("base64"),
                        },
                    ],
                },
            })
            .expect(201);
        await api()
            .post("/api/federation-trust-anchor")
            .set("Authorization", admin)
            .send({
                id: "trust-anchor",
                entityId: "https://trust-anchor.example",
                jwks: { keys: [(await federationKey("trust-anchor")).jwk] },
            })
            .expect(201);
        await api()
            .post("/api/verifier/config")
            .set("Authorization", admin)
            .send({
                id: "age-check",
                description: "Age check",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:eudi:pid:1"] },
                            claims: [{ path: ["age_over_18"] }],
                            trusted_authorities: [
                                {
                                    type: "openid_federation",
                                    values: ["https://trust-anchor.example"],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
        await api()
            .post("/api/issuer/offer")
            .set("Authorization", admin)
            .send({
                response_type: "uri",
                flow: "pre_authorized_code",
                credentialConfigurationIds: ["pid"],
                credentialClaims: {
                    pid: {
                        type: "inline",
                        claims: { given_name: CLAIM_VALUE },
                    },
                },
            })
            .expect(201);
    });

    afterAll(async () => {
        await Promise.all(clients.map((client) => client.close()));
        await app?.close();
        delete process.env.MCP_ENABLED;
    });

    test("is served under the management API prefix and needs an access token", async () => {
        const response = await rawPost();
        expect(response.status).toBe(401);
        expect((await rawPost("Bearer not-a-token")).status).toBe(401);
        expect(
            (await fetch(new URL("/mcp", endpoint), { method: "POST" })).status,
        ).toBe(404);
    });

    test("answers only POST, and no browser pages of other hosts", async () => {
        const authorization = `Bearer ${adminToken}`;
        for (const method of ["GET", "DELETE"]) {
            const response = await fetch(endpoint, {
                method,
                headers: {
                    Authorization: authorization,
                    Accept: "application/json, text/event-stream",
                },
            });
            expect(response.status, method).toBe(405);
        }
        expect(
            (
                await rawPost(authorization, {
                    Origin: "https://attacker.example",
                })
            ).status,
        ).toBe(403);
        expect(
            (await rawPost(authorization, { Origin: "http://localhost:6274" }))
                .status,
        ).toBe(200);
    });

    test("is not part of the OpenAPI document", () => {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
        );
        expect(
            Object.keys(document.paths).filter((path) => path.includes("mcp")),
        ).toEqual([]);
    });

    test("lists the read-only tools", async () => {
        const client = await connect(adminToken);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            "get_caller",
            "get_session_stats",
            "list_credential_configurations",
            "list_presentation_configurations",
            "list_sessions",
        ]);
        for (const tool of tools) {
            expect(tool.annotations?.readOnlyHint).toBe(true);
        }
        expect(
            tools.find((tool) => tool.name === "list_sessions")?.inputSchema
                .properties,
        ).toHaveProperty("pageSize");
    });

    test("get_caller names the token's tenant and roles", async () => {
        expect(jsonOf(await call(verifierToken, "get_caller"))).toMatchObject({
            clientId: "mcp-verifier",
            tenant: { id: "mcp-acme" },
            roles: [Role.PresentationRequest],
        });
        expect(jsonOf(await call(rootToken, "get_caller")).tenant).toBeNull();
    });

    test("tools need the roles of their management endpoint", async () => {
        const denied = await call(
            verifierToken,
            "list_credential_configurations",
        );
        expect(denied.isError).toBe(true);
        expect(textOf(denied)).toBe(
            "This tool needs one of the roles issuance:manage",
        );
        // The root client holds only tenants:manage.
        const root = await call(rootToken, "list_sessions");
        expect(root.isError).toBe(true);
        expect(textOf(root)).toBe(
            "This tool needs one of the roles issuance:offer, presentation:request, sessions:read",
        );
    });

    test("credential configurations are those of the token's tenant", async () => {
        expect(
            jsonOf(await call(adminToken, "list_credential_configurations")),
        ).toEqual([
            {
                id: "pid",
                description: "Personal ID",
                name: "PID",
                format: "dc+sd-jwt",
                vct: "urn:eudi:pid:1",
                docType: null,
                statusManagement: false,
            },
        ]);
        expect(
            jsonOf(
                await call(otherTenantToken, "list_credential_configurations"),
            ),
        ).toEqual([]);
    });

    test("presentation configurations are those of the token's tenant, as summaries", async () => {
        const result = await call(
            verifierToken,
            "list_presentation_configurations",
        );
        expect(jsonOf(result)).toEqual([
            {
                id: "age-check",
                description: "Age check",
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        vctValues: ["urn:eudi:pid:1"],
                    },
                ],
            },
        ]);
        expect(textOf(result)).not.toContain("age_over_18");
        expect(
            jsonOf(
                await call(
                    otherTenantToken,
                    "list_presentation_configurations",
                ),
            ),
        ).toEqual([]);
    });

    test("list_sessions returns summaries of the tenant's sessions without claims", async () => {
        const result = await call(adminToken, "list_sessions", {
            type: "issuance",
            status: "active",
        });
        const page = jsonOf(result);
        expect(page).toMatchObject({ total: 1, page: 1, pageSize: 25 });
        expect(Object.keys(page.items[0]).sort()).toEqual([
            "createdAt",
            "expiresAt",
            "failureCode",
            "id",
            "reference",
            "requestId",
            "status",
            "updatedAt",
        ]);
        expect(textOf(result)).not.toContain(CLAIM_VALUE);

        expect(
            jsonOf(await call(otherTenantToken, "list_sessions")).total,
        ).toBe(0);
    });

    test("list_sessions validates its input with the schema of GET /api/session", async () => {
        const result = await call(adminToken, "list_sessions", {
            pageSize: 1000,
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("pageSize");
    });

    test("get_session_stats counts the sessions and adds the retention", async () => {
        const stats = jsonOf(await call(adminToken, "get_session_stats"));
        expect(stats.issuance).toMatchObject({
            total: 1,
            byStatus: { active: 1 },
        });
        expect(stats.presentation.total).toBe(0);
        expect(stats.retention).toHaveProperty("ttlSeconds");

        const other = jsonOf(await call(otherTenantToken, "get_session_stats"));
        expect(other.issuance.total).toBe(0);
        expect(other.presentation.total).toBe(0);

        // presentation:request alone counts presentation sessions only.
        expect(
            jsonOf(await call(verifierToken, "get_session_stats")),
        ).not.toHaveProperty("issuance");
    });

    test("a token stops working when its client is deleted, as for the management API", async () => {
        const temporary = await createClient("mcp-temporary", [
            Role.IssuanceOffer,
        ]);
        expect((await rawPost(`Bearer ${temporary}`)).status).toBe(200);
        await api()
            .delete("/api/client/mcp-temporary")
            .set("Authorization", `Bearer ${adminToken}`)
            .expect(204);
        expect((await rawPost(`Bearer ${temporary}`)).status).toBe(401);
    });
});
