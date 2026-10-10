import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { IssuanceService } from "./issuance.service.js";

describe("IssuanceService.storeIssuanceConfiguration", () => {
    const service = (save = vi.fn(async (config) => config)) => ({
        save,
        issuance: Object.assign(Object.create(IssuanceService.prototype), {
            issuanceConfigRepo: {
                getForTenant: vi.fn().mockResolvedValue({
                    tenantId: "tenant-1",
                    authorizationServers: [
                        { type: "built-in", id: "built-in" },
                    ],
                }),
                save,
            },
        }) as IssuanceService,
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
