import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { stubSecretReferences } from "../../../../test/secrets/secret-test-sources.js";
import { SecretReferences } from "../../../platform/secrets/application/secret-references.js";
import { IssuanceConfigurationNotFound } from "./domain/issuance-configuration.js";
import { IssuanceService } from "./issuance.service.js";

describe("IssuanceService.storeIssuanceConfiguration", () => {
    const service = (
        save = vi.fn(async (config) => config),
        unregistered = vi.fn().mockResolvedValue([]),
        allowHttp = false,
    ) => ({
        save,
        unregistered,
        issuance: Object.assign(Object.create(IssuanceService.prototype), {
            federationTrustAnchors: { unregistered },
            outboundUrlPolicy: { allowHttp: () => allowHttp },
            keyChainService: {
                authorizationServerKeyChainRefusal: vi.fn(
                    async (_tenantId: string, id: string) =>
                        id === "token-key" ? undefined : `${id} refused`,
                ),
            },
            issuanceConfigRepo: {
                getForTenant: vi.fn().mockResolvedValue({
                    tenantId: "tenant-1",
                    authorizationServers: [
                        {
                            type: "built-in",
                            id: "issuer-built-in",
                            token: { signingKeyId: "stored-key" },
                        },
                    ],
                }),
                save,
            },
        }) as IssuanceService,
    });

    it("refuses a token.signingKeyId that names no authorization server key chain", async () => {
        const { issuance, save } = service();

        await expect(
            issuance.storeIssuanceConfiguration("tenant-1", {
                authorizationServers: [
                    {
                        type: "chained",
                        id: "chained",
                        token: { signingKeyId: "credential-key" },
                    },
                ] as any,
            }),
        ).rejects.toThrow(
            "Authorization server 'chained': credential-key refused",
        );
        expect(save).not.toHaveBeenCalled();

        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [
                {
                    type: "chained",
                    id: "chained",
                    token: { signingKeyId: "token-key" },
                },
            ] as any,
        });
        expect(save).toHaveBeenCalled();
    });

    it("keeps accepting a stored token.signingKeyId from before the check", async () => {
        const { issuance, save } = service();

        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [
                {
                    type: "built-in",
                    id: "issuer-built-in",
                    token: { signingKeyId: "stored-key" },
                },
            ] as any,
        });

        expect(save).toHaveBeenCalled();
    });

    it("rejects the removed 'vp' option of chained authorization servers", async () => {
        const { issuance, save } = service();

        const result = issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [
                {
                    type: "chained",
                    id: "legacy-vp",
                    vp: { enabled: true, presentationConfigId: "pid" },
                },
            ] as any,
        });

        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        await expect(result).rejects.toThrow(
            /'legacy-vp'.*removed in EUDIPLO 9\.0.*'oid4vp'/,
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("stores other authorization servers", async () => {
        const { issuance, save } = service();

        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [
                { type: "oid4vp", id: "pid-auth", presentationConfigId: "pid" },
            ] as any,
        });

        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                authorizationServers: [
                    {
                        type: "oid4vp",
                        id: "pid-auth",
                        presentationConfigId: "pid",
                    },
                ],
            }),
        );
    });

    it.each([
        [{ role: "trust_anchor" }, /role 'leaf'/],
        [{ role: "intermediate" }, /role 'leaf'/],
        [{ enforceSigningPolicy: false }, /always enforced/],
    ])(
        "rejects the unsupported federation option %o",
        async (option, message) => {
            const { issuance, save } = service();

            const result = issuance.storeIssuanceConfiguration("tenant-1", {
                federation: {
                    trustAnchors: [
                        {
                            entityId: "https://ta.example.org",
                            entityConfigurationUri:
                                "https://ta.example.org/.well-known/openid-federation",
                        },
                    ],
                    ...option,
                },
            } as any);

            await expect(result).rejects.toBeInstanceOf(BadRequestException);
            await expect(result).rejects.toThrow(message);
            expect(save).not.toHaveBeenCalled();
        },
    );

    const withEntityId = (entityId: string) =>
        ({
            authorizationServers: [{ type: "built-in", id: "issuer-built-in" }],
            federation: {
                entityId,
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        }) as any;

    it("rejects an http entity id without OUTBOUND_URL_ALLOW_HTTP", async () => {
        const { issuance, save } = service();

        const result = issuance.storeIssuanceConfiguration(
            "tenant-1",
            withEntityId("http://localhost:3000/issuers/tenant-1"),
        );

        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        await expect(result).rejects.toThrow(/OUTBOUND_URL_ALLOW_HTTP/);
        expect(save).not.toHaveBeenCalled();
    });

    it("accepts an http entity id with OUTBOUND_URL_ALLOW_HTTP", async () => {
        const { issuance, save } = service(undefined, undefined, true);

        await issuance.storeIssuanceConfiguration(
            "tenant-1",
            withEntityId("http://localhost:3000/issuers/tenant-1"),
        );

        expect(save).toHaveBeenCalledOnce();
    });

    it("keeps an empty entity id as not set", async () => {
        const { issuance, save } = service();

        await issuance.storeIssuanceConfiguration("tenant-1", withEntityId(""));

        expect(save).toHaveBeenCalledOnce();
    });

    it("rejects an entity id that is no URL even with OUTBOUND_URL_ALLOW_HTTP", async () => {
        const { issuance, save } = service(undefined, undefined, true);

        await expect(
            issuance.storeIssuanceConfiguration(
                "tenant-1",
                withEntityId("tenant-1"),
            ),
        ).rejects.toThrow(/is not a URL/);
        expect(save).not.toHaveBeenCalled();
    });

    it("accepts the supported federation options", async () => {
        const { issuance, save } = service();

        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [{ type: "built-in", id: "issuer-built-in" }],
            federation: {
                role: "leaf",
                enforceSigningPolicy: true,
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        } as any);

        expect(save).toHaveBeenCalledOnce();
    });

    it("rejects federation trust anchors the tenant has not registered with pinned keys", async () => {
        const { issuance, save, unregistered } = service(
            undefined,
            vi.fn().mockResolvedValue(["https://ta.example.org"]),
        );

        const result = issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [{ type: "built-in", id: "issuer-built-in" }],
            federation: {
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        } as any);

        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        await expect(result).rejects.toThrow(
            "OpenID Federation trust anchors without pinned keys: https://ta.example.org",
        );
        expect(unregistered).toHaveBeenCalledWith("tenant-1", [
            "https://ta.example.org",
        ]);
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps accepting changes that leave stored, unregistered trust anchors alone", async () => {
        const { issuance, save, unregistered } = service(
            undefined,
            vi.fn().mockResolvedValue([]),
        );
        (issuance as any).issuanceConfigRepo.getForTenant.mockResolvedValue({
            tenantId: "tenant-1",
            authorizationServers: [{ type: "built-in", id: "built-in" }],
            federation: {
                trustAnchors: [{ entityId: "https://ta.example.org" }],
            },
        });

        // The Web Client always sends `federation`, also when unchanged.
        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [{ type: "built-in", id: "issuer-built-in" }],
            federation: {
                trustAnchors: [
                    { entityId: "https://ta.example.org" },
                    { entityId: "https://new-ta.example.org" },
                ],
            },
        } as any);

        expect(unregistered).toHaveBeenCalledWith("tenant-1", [
            "https://new-ta.example.org",
        ]);
        expect(save).toHaveBeenCalledOnce();
    });

    it("does not check the stored trust anchors when federation is cleared", async () => {
        const { issuance, unregistered } = service();

        await issuance.storeIssuanceConfiguration("tenant-1", {
            authorizationServers: [{ type: "built-in", id: "issuer-built-in" }],
            federation: null,
        } as any);

        expect(unregistered).toHaveBeenCalledWith("tenant-1", []);
    });
});

describe("IssuanceService audit log", () => {
    const upstream = (clientSecret: string) => ({
        issuer: "https://idp.example",
        clientId: "c",
        clientSecret,
    });
    const chained = (clientSecret: string) => ({
        type: "chained",
        id: "chained",
        upstream: upstream(clientSecret),
    });

    function service(secrets = new SecretReferences()) {
        const record = vi.fn();
        const save = vi.fn(async (config) => config);
        const issuance = Object.assign(
            Object.create(IssuanceService.prototype),
            {
                issuanceConfigRepo: {
                    getForTenant: vi.fn().mockResolvedValue({
                        tenantId: "tenant-1",
                        authorizationServers: [chained("old-secret")],
                    }),
                    save,
                },
                tenantActionLogService: { record },
                federationTrustAnchors: {
                    unregistered: vi.fn().mockResolvedValue([]),
                },
                secrets,
            },
        ) as IssuanceService;
        return { issuance, record, save };
    }

    it("shows a secret reference as the upstream client secret in the audit log", async () => {
        const { issuance, record } = service(stubSecretReferences().secrets);
        const reference = "${vault:kv/eudiplo/tenant-1/idp#secret}";

        await issuance.storeIssuanceConfiguration(
            "tenant-1",
            { authorizationServers: [chained(reference)] } as any,
            { client: { clientId: "admin" } } as any,
        );

        const [entry] = record.mock.calls[0];
        expect(entry.before.authorizationServers[0].upstream).toEqual(
            upstream("[REDACTED]"),
        );
        expect(entry.after.authorizationServers[0].upstream).toEqual(
            upstream(reference),
        );
    });

    it("refuses an upstream client secret reference outside the tenant's grant, storing nothing", async () => {
        const { issuance, save } = service(stubSecretReferences().secrets);

        await expect(
            issuance.storeIssuanceConfiguration("tenant-1", {
                authorizationServers: [
                    { type: "built-in", id: "own" },
                    chained("${vault:kv/eudiplo/other/idp#secret}"),
                ],
            } as any),
        ).rejects.toThrow(
            /authorizationServers\[1\]\.upstream\.clientSecret: .*no grant of tenant 'tenant-1'/,
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("checks a bound reference against the upstream issuer and refuses a malformed one", async () => {
        const bound = "${vault:kv/operator/idp#secret}";
        const { issuance, save } = service(
            stubSecretReferences({
                tenants: {
                    "tenant-1": {
                        bound: [
                            {
                                ref: bound,
                                fields: [
                                    "IssuanceConfig:authorizationServers.*.upstream.clientSecret",
                                ],
                                destinations: ["https://idp.example"],
                            },
                        ],
                    },
                },
            }).secrets,
        );
        const store = (server: unknown) =>
            issuance.storeIssuanceConfiguration("tenant-1", {
                authorizationServers: [{ type: "built-in", id: "own" }, server],
            } as any);

        await expect(store(chained(bound))).resolves.toBeDefined();
        save.mockClear();
        await expect(
            store({
                ...chained(bound),
                upstream: {
                    ...upstream(bound),
                    issuer: "https://elsewhere.example",
                },
            }),
        ).rejects.toThrow(/authorizationServers\[1\]\.upstream\.clientSecret/);
        await expect(store(chained("${vault:kv}"))).rejects.toThrow(
            /authorizationServers\[1\]\.upstream\.clientSecret/,
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("refuses only a change that sets authorizationServers for a reference no longer granted", async () => {
        const { issuance, save } = service(stubSecretReferences().secrets);
        (
            issuance as unknown as {
                issuanceConfigRepo: { getForTenant: ReturnType<typeof vi.fn> };
            }
        ).issuanceConfigRepo.getForTenant.mockResolvedValue({
            tenantId: "tenant-1",
            authorizationServers: [
                chained("${vault:kv/eudiplo/other/idp#secret}"),
            ],
        });

        await expect(
            issuance.storeIssuanceConfiguration("tenant-1", {
                offerLifetimeSeconds: 60,
            } as any),
        ).resolves.toBeDefined();
        expect(save).toHaveBeenCalledTimes(1);
        await expect(
            issuance.storeIssuanceConfiguration("tenant-1", {
                authorizationServers: [
                    chained("${vault:kv/eudiplo/other/idp#secret}"),
                ],
            } as any),
        ).rejects.toThrow(/authorizationServers\[0\]\.upstream\.clientSecret/);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it("keeps the stored configuration when a folder file names a refused reference", async () => {
        const { issuance } = service(stubSecretReferences().secrets);
        const importConfigsForTenant = vi.fn();
        const deleteForTenant = vi.fn();
        Object.assign(issuance, {
            configImportService: { importConfigsForTenant },
        });
        Object.assign(
            (issuance as unknown as { issuanceConfigRepo: object })
                .issuanceConfigRepo,
            { deleteForTenant },
        );
        await (
            issuance as unknown as {
                importForTenant(tenantId: string): Promise<void>;
            }
        ).importForTenant("tenant-1");
        const { deleteExisting } = importConfigsForTenant.mock.calls[0][1];

        await expect(
            deleteExisting("tenant-1", {
                authorizationServers: [
                    chained("${vault:kv/eudiplo/other/idp#secret}"),
                ],
            }),
        ).rejects.toThrow(/authorizationServers\[0\]\.upstream\.clientSecret/);
        expect(deleteForTenant).not.toHaveBeenCalled();

        await deleteExisting("tenant-1", {
            authorizationServers: [
                chained("${vault:kv/eudiplo/tenant-1/idp#secret}"),
            ],
        });
        expect(deleteForTenant).toHaveBeenCalledWith("tenant-1");
    });

    it("lists a new upstream client secret as a changed field without storing it", async () => {
        const { issuance, record } = service();

        await issuance.storeIssuanceConfiguration(
            "tenant-1",
            { authorizationServers: [chained("new-secret")] } as any,
            { client: { clientId: "admin" } } as any,
        );

        const [entry] = record.mock.calls[0];
        expect(entry.changedFields).toEqual(["authorizationServers"]);
        expect(entry.before.authorizationServers[0].upstream).toEqual(
            upstream("[REDACTED]"),
        );
        expect(entry.after.authorizationServers[0].upstream).toEqual(
            upstream("[REDACTED]"),
        );
        expect(JSON.stringify(entry)).not.toMatch(/old-secret|new-secret/);
    });
});

describe("IssuanceService.getIssuanceConfigurationOrDefault", () => {
    function service(getForTenant: () => Promise<unknown>) {
        const issuance = Object.assign(
            Object.create(IssuanceService.prototype),
            { issuanceConfigRepo: { getForTenant: vi.fn(getForTenant) } },
        ) as IssuanceService;
        const store = vi
            .spyOn(issuance, "storeIssuanceConfiguration")
            .mockResolvedValue({ tenantId: "tenant-1" } as never);
        return { issuance, store };
    }

    it("returns the default without storing it when the caller only reads", async () => {
        const { issuance, store } = service(() =>
            Promise.reject(new IssuanceConfigurationNotFound("tenant-1")),
        );

        const config = await issuance.getIssuanceConfigurationOrDefault(
            "tenant-1",
            { store: false },
        );

        expect(store).not.toHaveBeenCalled();
        expect(config.authorizationServers).toEqual([
            { type: "built-in", id: "issuer-built-in", enabled: true },
        ]);
    });

    it("stores the default for a caller that may change it", async () => {
        const { issuance, store } = service(() =>
            Promise.reject(new IssuanceConfigurationNotFound("tenant-1")),
        );

        await issuance.getIssuanceConfigurationOrDefault("tenant-1", {
            store: true,
        });

        expect(store).toHaveBeenCalledWith("tenant-1", {});
    });

    it("passes on other failures instead of answering with a default", async () => {
        const { issuance, store } = service(() =>
            Promise.reject(new Error("database down")),
        );

        await expect(
            issuance.getIssuanceConfigurationOrDefault("tenant-1", {
                store: false,
            }),
        ).rejects.toThrow("database down");
        expect(store).not.toHaveBeenCalled();
    });
});
