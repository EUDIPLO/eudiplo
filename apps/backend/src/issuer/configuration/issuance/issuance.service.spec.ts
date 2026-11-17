import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
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

    it("lists a new upstream client secret as a changed field without storing it", async () => {
        const record = vi.fn();
        const issuance = Object.assign(
            Object.create(IssuanceService.prototype),
            {
                issuanceConfigRepo: {
                    getForTenant: vi.fn().mockResolvedValue({
                        tenantId: "tenant-1",
                        authorizationServers: [chained("old-secret")],
                    }),
                    save: vi.fn(async (config) => config),
                },
                tenantActionLogService: { record },
                federationTrustAnchors: {
                    unregistered: vi.fn().mockResolvedValue([]),
                },
            },
        ) as IssuanceService;

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
