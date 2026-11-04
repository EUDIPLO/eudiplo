import type { Type } from "@nestjs/common";
import { GUARDS_METADATA, MODULE_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { Role } from "../auth/roles/role.enum.js";
import {
    ROLES_KEY,
    type RoleRequirement,
} from "../auth/roles/roles.decorator.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { CredentialConfigController } from "../issuer/configuration/credentials/credential-config.controller.js";
import { SessionController } from "../session/session.controller.js";
import { PresentationManagementController } from "../verifier/presentations/presentations.controller.js";
import type { McpRequest } from "./mcp-caller.js";
import { McpRolesGuard } from "./mcp-roles.guard.js";
import { McpToolsModule } from "./mcp-tools.module.js";
import { CallerTools } from "./tools/caller.tools.js";
import { ConfigurationTools } from "./tools/configuration.tools.js";
import { SessionTools } from "./tools/session.tools.js";

/** Where `@Tool()` records itself; internal to @nestjs/mcp. */
const MCP_PRIMITIVE_METADATA = "nestjs:mcp:primitive";

const toolProviders = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    McpToolsModule,
) as Type[];

const tools = toolProviders.flatMap((provider) =>
    Object.getOwnPropertyNames(provider.prototype)
        .map((method) => ({
            provider,
            method,
            handler: provider.prototype[method],
        }))
        .filter(({ handler }) =>
            Reflect.hasMetadata(MCP_PRIMITIVE_METADATA, handler),
        ),
);

const reflector = new Reflector();
const requirementOf = (target: Type, handler: object) =>
    reflector.getAllAndOverride<RoleRequirement>(ROLES_KEY, [handler, target]);

/** An MCP context whose HTTP request carries `token`. */
const as = (token: Partial<TokenPayload>) =>
    ({ request: { user: token } as McpRequest }) as any;

const tenant = { id: "acme", name: "Acme" } as TokenPayload["entity"];

describe("MCP tools", () => {
    it("serves the five tools", () => {
        expect(
            tools.map(
                ({ handler }) =>
                    Reflect.getMetadata(MCP_PRIMITIVE_METADATA, handler).options
                        .name,
            ),
        ).toEqual([
            "get_caller",
            "list_credential_configurations",
            "list_presentation_configurations",
            "list_sessions",
            "get_session_stats",
        ]);
    });

    it.each(tools)(
        "$provider.name.$method declares roles and runs the role guard",
        ({ provider, handler }) => {
            expect(
                requirementOf(provider, handler)?.roles.length,
            ).toBeGreaterThan(0);
            const guards = [
                ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
                ...(Reflect.getMetadata(GUARDS_METADATA, provider) ?? []),
            ];
            expect(guards).toContain(McpRolesGuard);
        },
    );

    it.each(tools)("$provider.name.$method only reads", ({ handler }) => {
        const { options } = Reflect.getMetadata(
            MCP_PRIMITIVE_METADATA,
            handler,
        );
        expect(options.annotations).toMatchObject({ readOnlyHint: true });
    });

    it.each([
        [SessionTools, "listSessions", SessionController, "getAllSessions"],
        [SessionTools, "getSessionStats", SessionController, "getSessionStats"],
        [
            ConfigurationTools,
            "listCredentialConfigurations",
            CredentialConfigController,
            "getConfigs",
        ],
        [
            ConfigurationTools,
            "listPresentationConfigurations",
            PresentationManagementController,
            "configuration",
        ],
    ] as [Type, string, Type, string][])(
        "%o.%s needs the roles of its management endpoint",
        (tool, method, controller, handler) => {
            expect(requirementOf(tool, tool.prototype[method])).toEqual(
                requirementOf(controller, controller.prototype[handler]),
            );
        },
    );
});

describe("CallerTools", () => {
    it("names the tenant, client and EUDIPLO roles of the token", () => {
        const result = new CallerTools().getCaller(
            undefined,
            as({
                entity: tenant,
                roles: [Role.SessionsRead, "default-roles-eudiplo" as Role],
                client: { clientId: "assistant", roles: [] },
            }),
        );
        expect(result).toMatchObject({
            clientId: "assistant",
            tenant: { id: "acme", name: "Acme" },
            roles: [Role.SessionsRead],
        });
    });

    it("has no tenant for the root client", () => {
        expect(
            new CallerTools().getCaller(
                undefined,
                as({ roles: [Role.Tenants], subject: "root" }),
            ),
        ).toMatchObject({ clientId: "root", tenant: null });
    });
});

describe("SessionTools", () => {
    it("lists sessions with the scope and hidden sessions of GET /api/session", async () => {
        const sessions = { listForTenant: vi.fn().mockResolvedValue("page") };
        const tools = new SessionTools(sessions as any, {} as any);
        const query = { page: 2, pageSize: 10 };

        await expect(
            tools.listSessions(
                query,
                as({
                    entity: tenant,
                    roles: [Role.SessionsRead, Role.IssuanceOffer],
                }),
            ),
        ).resolves.toBe("page");
        // issuance:offer may change issuance sessions; presentation sessions
        // it only reads through sessions:read.
        expect(sessions.listForTenant).toHaveBeenCalledWith(
            "acme",
            { ...query, hideOpen: ["presentation"] },
            undefined,
        );
    });

    it("refuses the root client, which has no tenant", () => {
        const tools = new SessionTools({} as any, {} as any);
        expect(() =>
            tools.listSessions(
                { page: 1, pageSize: 25 },
                as({ roles: [Role.SessionsRead] }),
            ),
        ).toThrow("the access token belongs to no tenant");
    });

    it("adds the retention settings to the counts, as GET /api/session/stats", async () => {
        const sessions = {
            statsForTenant: vi.fn().mockResolvedValue({ issuance: {} }),
        };
        const config = {
            getEffectiveConfig: vi.fn().mockResolvedValue({ ttlSeconds: 60 }),
        };
        const tools = new SessionTools(sessions as any, config as any);

        await expect(
            tools.getSessionStats(
                {},
                as({ entity: tenant, roles: [Role.IssuanceOffer] }),
            ),
        ).resolves.toEqual({ issuance: {}, retention: { ttlSeconds: 60 } });
        expect(sessions.statsForTenant).toHaveBeenCalledWith(
            "acme",
            "issuance",
            {},
        );
    });
});

describe("ConfigurationTools", () => {
    it("summarizes credential configurations without claims, keys or webhooks", async () => {
        const credentialConfigs = {
            get: vi.fn().mockResolvedValue([
                {
                    id: "pid",
                    description: "PID",
                    config: {
                        format: "dc+sd-jwt",
                        display: [{ name: "Personal ID", locale: "en" }],
                    },
                    vct: { vct: "urn:eudi:pid:1", name: "PID" },
                    statusManagement: true,
                    claims: { given_name: "Erika" },
                    keyChainId: "signing",
                    webhookEndpointId: "hook",
                },
                {
                    id: "mdl",
                    config: {
                        format: "mso_mdoc",
                        docType: "org.iso.18013.5.1.mDL",
                    },
                },
            ]),
        };
        const tools = new ConfigurationTools(
            credentialConfigs as any,
            {} as any,
        );

        await expect(
            tools.listCredentialConfigurations(
                undefined,
                as({ entity: tenant, roles: [Role.Issuances] }),
            ),
        ).resolves.toEqual([
            {
                id: "pid",
                description: "PID",
                name: "Personal ID",
                format: "dc+sd-jwt",
                vct: "urn:eudi:pid:1",
                docType: null,
                statusManagement: true,
            },
            {
                id: "mdl",
                description: null,
                name: null,
                format: "mso_mdoc",
                vct: null,
                docType: "org.iso.18013.5.1.mDL",
                statusManagement: false,
            },
        ]);
        expect(credentialConfigs.get).toHaveBeenCalledWith("acme");
    });

    it("summarizes presentation configurations by their credential queries", async () => {
        const presentationConfigs = {
            getPresentationConfigs: vi.fn().mockResolvedValue([
                {
                    id: "age",
                    description: "Age check",
                    dcql_query: {
                        credentials: [
                            {
                                id: "pid",
                                format: "dc+sd-jwt",
                                meta: { vct_values: ["urn:eudi:pid:1"] },
                                claims: [{ path: ["age_over_18"] }],
                            },
                            {
                                id: "mdl",
                                format: "mso_mdoc",
                                meta: {
                                    doctype_value: "org.iso.18013.5.1.mDL",
                                },
                            },
                        ],
                    },
                    registration_cert: { jwt: "secret" },
                },
            ]),
        };
        const tools = new ConfigurationTools(
            {} as any,
            presentationConfigs as any,
        );

        await expect(
            tools.listPresentationConfigurations(
                undefined,
                as({ entity: tenant, roles: [Role.PresentationRequest] }),
            ),
        ).resolves.toEqual([
            {
                id: "age",
                description: "Age check",
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        vctValues: ["urn:eudi:pid:1"],
                    },
                    {
                        id: "mdl",
                        format: "mso_mdoc",
                        docType: "org.iso.18013.5.1.mDL",
                    },
                ],
            },
        ]);
    });
});
