import { describe, expect, it, vi } from "vitest";
import { KeycloakClientsProvider } from "./keycloak-clients.service.js";

const AUDIENCE = "https://eudiplo.example.com/api";
const MANAGED_ENV = {
    OIDC_AUDIENCE: AUDIENCE,
    AUTH_CLIENT_ID: "root",
    AUTH_CLIENT_SECRET: "secret",
};

/**
 * A provider on a fake Keycloak. `kcClients` maps client IDs to their
 * tenant attribute; `mirrored` are the [client ID, tenant] rows of the
 * local mirror.
 */
function provider({
    env = MANAGED_ENV,
    scope = { id: "scope-1" },
    kcClients = {
        "eudiplo-ui": undefined,
        root: undefined,
        shop: "acme",
        backend: undefined,
        admin: "other",
    },
    mirrored = [
        ["shop", "acme"],
        ["gone", "acme"],
        ["backend", "acme"],
        ["admin", null],
    ],
}: {
    env?: Record<string, string>;
    scope?: { id: string };
    kcClients?: Record<string, string | undefined>;
    mirrored?: [string, string | null][];
} = {}) {
    const kc = {
        clientScopes: {
            findOneByName: vi.fn().mockResolvedValue(scope),
            create: vi.fn(),
            listProtocolMappers: vi.fn().mockResolvedValue([
                {
                    id: "mapper-1",
                    name: "eudiplo-audience",
                    config: { "included.custom.audience": AUDIENCE },
                },
            ]),
            addProtocolMapper: vi.fn(),
            updateProtocolMapper: vi.fn(),
        },
        clients: {
            find: vi.fn(async ({ clientId }: { clientId: string }) =>
                clientId in kcClients
                    ? [
                          {
                              id: `kc-${clientId}`,
                              attributes: kcClients[clientId]
                                  ? { tenant_id: kcClients[clientId] }
                                  : {},
                          },
                      ]
                    : [],
            ),
            create: vi.fn().mockResolvedValue({ id: "kc-new" }),
            update: vi.fn(),
            addDefaultClientScope: vi.fn(),
            getServiceAccountUser: vi.fn().mockResolvedValue({ id: "svc" }),
        },
        roles: { find: vi.fn().mockResolvedValue([]), create: vi.fn() },
        users: {
            listRealmRoleMappings: vi.fn().mockResolvedValue([]),
            addRealmRoleMappings: vi.fn(),
        },
    };
    const clientRepo = {
        find: vi.fn().mockResolvedValue(
            mirrored.map(([clientId, tenantId]) => ({
                clientId,
                tenantId,
            })),
        ),
    };
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const subject = Object.assign(
        Object.create(KeycloakClientsProvider.prototype),
        {
            kc,
            clientRepo,
            logger,
            configService: { get: (key: string) => env[key] },
        },
    ) as KeycloakClientsProvider & { audienceScopeId?: string };
    // init() is the startup step of onModuleInit after the admin login.
    const start = () =>
        (subject as unknown as { init(): Promise<void> }).init();
    const scopesAdded = () =>
        kc.clients.addDefaultClientScope.mock.calls.map(([call]) => call);
    return { kc, logger, subject, start, scopesAdded };
}

describe("KeycloakClientsProvider audience scope", () => {
    it("adds the scope to the clients EUDIPLO manages on every start", async () => {
        const { subject, start, scopesAdded, logger } = provider();

        await start();

        // The web client and the bootstrap client; of the mirrored tenant
        // clients only those Keycloak still holds for that tenant: "gone"
        // was deleted, "backend" is another client with the same ID, and
        // "admin" has no tenant in the mirror.
        expect(scopesAdded()).toEqual([
            { id: "kc-eudiplo-ui", clientScopeId: "scope-1" },
            { id: "kc-root", clientScopeId: "scope-1" },
            { id: "kc-shop", clientScopeId: "scope-1" },
        ]);
        expect(subject.audienceScopeId).toBe("scope-1");
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("uses OIDC_UI_CLIENT_ID for the web client", async () => {
        const { start, scopesAdded } = provider({
            env: { ...MANAGED_ENV, OIDC_UI_CLIENT_ID: "portal" },
            kcClients: { portal: undefined, root: undefined },
            mirrored: [],
        });

        await start();

        expect(scopesAdded().map(({ id }) => id)).toEqual([
            "kc-portal",
            "kc-root",
        ]);
    });

    it("leaves an AUTH_CLIENT_ID client alone that EUDIPLO does not manage", async () => {
        const { start, scopesAdded } = provider({
            env: { OIDC_AUDIENCE: AUDIENCE, AUTH_CLIENT_ID: "root" },
        });

        await start();

        expect(scopesAdded().map(({ id }) => id)).toEqual([
            "kc-eudiplo-ui",
            "kc-shop",
        ]);
    });

    it.each([
        ["unset", {}],
        ["empty", { OIDC_AUDIENCE: "" }],
    ])("starts as before with OIDC_AUDIENCE %s", async (_name, env) => {
        const { kc, start, logger, subject } = provider({ env });

        await expect(start()).resolves.toBeUndefined();

        expect(kc.clientScopes.findOneByName).not.toHaveBeenCalled();
        expect(kc.clients.addDefaultClientScope).not.toHaveBeenCalled();
        expect(subject.audienceScopeId).toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("fails startup when the scope cannot be set up, as every token would be refused", async () => {
        const { kc, start } = provider();
        kc.clientScopes.findOneByName.mockRejectedValue(
            new Error("403 Forbidden"),
        );

        await expect(start()).rejects.toThrow(
            "Could not set up the Keycloak client scope eudiplo-audience for OIDC_AUDIENCE: 403 Forbidden",
        );
    });
});
