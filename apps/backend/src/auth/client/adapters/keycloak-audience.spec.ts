import { describe, expect, it, vi } from "vitest";
import { KeycloakClientsProvider } from "./keycloak-clients.service.js";

const AUDIENCE = "https://eudiplo.example.com/api";

function provider({
    env = {
        OIDC_AUDIENCE: AUDIENCE,
        AUTH_CLIENT_ID: "root",
        AUTH_CLIENT_SECRET: "secret",
    },
    scope,
    mappers = [],
    kcClients = {
        "eudiplo-ui": undefined,
        root: undefined,
        shop: "acme",
        backend: undefined,
    },
    mirrored = [
        ["shop", "acme"],
        ["gone", "acme"],
        ["backend", "acme"],
    ],
}: {
    env?: Record<string, string>;
    scope?: { id: string };
    mappers?: { id?: string; name?: string; config?: Record<string, string> }[];
    /** Keycloak clients by client ID, with their tenant attribute. */
    kcClients?: Record<string, string | undefined>;
    mirrored?: [string, string][];
} = {}) {
    let created = false;
    const kc = {
        clientScopes: {
            findOneByName: vi.fn(
                async () =>
                    scope ?? (created ? { id: "scope-new" } : undefined),
            ),
            create: vi.fn(async () => {
                created = true;
                return { id: "scope-new" };
            }),
            listProtocolMappers: vi.fn().mockResolvedValue(mappers),
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
            addDefaultClientScope: vi.fn(),
            create: vi.fn().mockResolvedValue({ id: "kc-ui" }),
        },
        roles: { find: vi.fn().mockResolvedValue([]), create: vi.fn() },
    };
    const clientRepo = {
        find: vi
            .fn()
            .mockResolvedValue(
                mirrored.map(([clientId, tenantId]) => ({
                    clientId,
                    tenantId,
                })),
            ),
    };
    const configService = { get: (key: string) => env[key] };
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const subject = Object.assign(
        Object.create(KeycloakClientsProvider.prototype),
        { kc, clientRepo, configService, logger },
    ) as KeycloakClientsProvider & { audienceScopeId?: string };
    const ensure = () =>
        (
            subject as unknown as { ensureAudienceScope(): Promise<void> }
        ).ensureAudienceScope();
    return { kc, subject, ensure };
}

const scopesAdded = (kc: ReturnType<typeof provider>["kc"]) =>
    kc.clients.addDefaultClientScope.mock.calls.map(([call]) => call);

describe("KeycloakClientsProvider audience scope", () => {
    it("does nothing without OIDC_AUDIENCE", async () => {
        const { kc, ensure } = provider({ env: {} });

        await ensure();

        expect(kc.clientScopes.findOneByName).not.toHaveBeenCalled();
        expect(kc.clients.addDefaultClientScope).not.toHaveBeenCalled();
    });

    it("creates the scope with an audience mapper and adds it to every managed client", async () => {
        const { kc, subject, ensure } = provider();

        await ensure();

        expect(kc.clientScopes.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "eudiplo-audience",
                protocol: "openid-connect",
                protocolMappers: [
                    expect.objectContaining({
                        protocolMapper: "oidc-audience-mapper",
                        config: expect.objectContaining({
                            "included.custom.audience": AUDIENCE,
                            "access.token.claim": "true",
                        }),
                    }),
                ],
            }),
        );
        // The web client, the bootstrap client and the mirrored tenant
        // clients that Keycloak still has for their tenant: "gone" was
        // deleted, and "backend" is another client with the same ID.
        expect(scopesAdded(kc)).toEqual([
            { id: "kc-eudiplo-ui", clientScopeId: "scope-new" },
            { id: "kc-root", clientScopeId: "scope-new" },
            { id: "kc-shop", clientScopeId: "scope-new" },
        ]);
        expect(subject.audienceScopeId).toBe("scope-new");
    });

    it("adds the mapper to an existing scope that lacks it", async () => {
        const { kc, ensure } = provider({ scope: { id: "scope-1" } });

        await ensure();

        expect(kc.clientScopes.create).not.toHaveBeenCalled();
        expect(kc.clientScopes.addProtocolMapper).toHaveBeenCalledWith(
            { id: "scope-1" },
            expect.objectContaining({ name: "eudiplo-audience" }),
        );
    });

    it("updates the mapper when OIDC_AUDIENCE changed", async () => {
        const { kc, ensure } = provider({
            scope: { id: "scope-1" },
            mappers: [
                {
                    id: "mapper-1",
                    name: "eudiplo-audience",
                    config: { "included.custom.audience": "https://old" },
                },
            ],
        });

        await ensure();

        expect(kc.clientScopes.updateProtocolMapper).toHaveBeenCalledWith(
            { id: "scope-1", mapperId: "mapper-1" },
            expect.objectContaining({
                id: "mapper-1",
                config: expect.objectContaining({
                    "included.custom.audience": AUDIENCE,
                }),
            }),
        );
    });

    it("leaves a current mapper alone", async () => {
        const { kc, ensure } = provider({
            scope: { id: "scope-1" },
            mappers: [
                {
                    id: "mapper-1",
                    name: "eudiplo-audience",
                    config: { "included.custom.audience": AUDIENCE },
                },
            ],
        });

        await ensure();

        expect(kc.clientScopes.addProtocolMapper).not.toHaveBeenCalled();
        expect(kc.clientScopes.updateProtocolMapper).not.toHaveBeenCalled();
    });

    it("fails startup when the scope cannot be set up, as every token would be refused", async () => {
        const { kc, subject } = provider({ env: { OIDC_AUDIENCE: AUDIENCE } });
        kc.clientScopes.findOneByName.mockRejectedValue(
            new Error("403 Forbidden"),
        );

        await expect(
            (subject as unknown as { init(): Promise<void> }).init(),
        ).rejects.toThrow(
            "Could not set up the Keycloak client scope eudiplo-audience for OIDC_AUDIENCE: 403 Forbidden",
        );
    });

    it("starts without OIDC_AUDIENCE, as before", async () => {
        const { kc, subject } = provider({ env: {} });

        await expect(
            (subject as unknown as { init(): Promise<void> }).init(),
        ).resolves.toBeUndefined();
        expect(kc.clientScopes.findOneByName).not.toHaveBeenCalled();
    });

    it("leaves an AUTH_CLIENT_ID client alone that EUDIPLO does not manage", async () => {
        const { kc, ensure } = provider({
            env: { OIDC_AUDIENCE: AUDIENCE, AUTH_CLIENT_ID: "root" },
        });

        await ensure();

        expect(scopesAdded(kc).map(({ id }) => id)).toEqual([
            "kc-eudiplo-ui",
            "kc-shop",
        ]);
    });
});
