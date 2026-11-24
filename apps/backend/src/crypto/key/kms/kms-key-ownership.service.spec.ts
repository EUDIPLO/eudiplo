import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { KmsConfig } from "../schemas/kms-config.schema.js";
import { KmsKeyOwnershipService } from "./kms-key-ownership.service.js";
import { tenantOwnsKmsProvider } from "./kms-tenant-restrictions.js";

const vault = (id: string, vaultToken = "token") =>
    ({
        id,
        type: "vault",
        vaultUrl: "https://vault.example",
        vaultToken,
    }) as KmsConfig["providers"][number];

describe("tenantOwnsKmsProvider", () => {
    const file = (provider: Record<string, unknown>) =>
        ({ providers: [provider] }) as unknown as KmsConfig;

    it("holds for a provider of the tenant file with credentials of its own", () => {
        expect(tenantOwnsKmsProvider(file(vault("kms")), "kms")).toBe(true);
        expect(
            tenantOwnsKmsProvider(
                file({
                    id: "kms",
                    type: "aws-kms",
                    region: "eu-central-1",
                    accessKeyId: "id",
                    secretAccessKey: "secret",
                }),
                "kms",
            ),
        ).toBe(true);
    });

    it.each([
        ["no tenant file", null, "kms"],
        ["a provider the file does not define", file(vault("other")), "kms"],
        [
            "an aws-kms provider on the instance's AWS identity",
            file({ id: "kms", type: "aws-kms", region: "eu-central-1" }),
            "kms",
        ],
        [
            "an http provider with the mTLS files of the host",
            file({
                id: "kms",
                type: "http",
                baseUrl: "https://kms.example",
                auth: {
                    type: "mtls",
                    certFile: "/etc/tls/client.crt",
                    keyFile: "/etc/tls/client.key",
                },
            }),
            "kms",
        ],
        [
            "a provider that takes a value from the environment",
            file(vault("kms", "${VAULT_TOKEN}")),
            "kms",
        ],
        [
            "a placeholder with a default",
            file(vault("kms", "${VAULT_TOKEN:fallback}")),
            "kms",
        ],
    ])("does not hold for %s", (_label, config, id) => {
        expect(tenantOwnsKmsProvider(config, id)).toBe(false);
    });
});

describe("KmsKeyOwnershipService", () => {
    function setup(options: {
        global?: KmsConfig["providers"];
        stored?: KmsConfig | null;
        storedThrows?: boolean;
        keyChains?: Array<Record<string, unknown>>;
    }) {
        const find = vi.fn(async () => options.keyChains ?? []);
        const service = new KmsKeyOwnershipService(
            { find } as never,
            {
                getConfig: () => ({
                    providers: options.global ?? [vault("shared")],
                }),
                getTenantFile: () => {
                    if (options.storedThrows) {
                        throw new Error("expected a KmsConfig document");
                    }
                    return options.stored ?? null;
                },
            } as never,
        );
        return { service, find };
    }

    describe("exclusive", () => {
        it("runs the tasks of a tenant one after the other, also after a failure", async () => {
            const { service } = setup({});
            const order: string[] = [];
            let release = () => {};
            const first = service.exclusive("tenant", async () => {
                order.push("first starts");
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                order.push("first ends");
                throw new Error("failed");
            });
            const second = service.exclusive("tenant", async () => {
                order.push("second");
                return "done";
            });
            const other = service.exclusive("other", async () => {
                order.push("other tenant");
            });

            await other;
            expect(order).toEqual(["first starts", "other tenant"]);
            release();

            await expect(first).rejects.toThrow("failed");
            await expect(second).resolves.toBe("done");
            expect(order).toEqual([
                "first starts",
                "other tenant",
                "first ends",
                "second",
            ]);
        });
    });

    describe("replaceTenantFile", () => {
        const stored = { providers: [vault("shared")] };

        it("does not write while key chains would lose their provider", async () => {
            const { service } = setup({
                stored,
                keyChains: [{ id: "a", kmsProvider: "shared" }],
            });
            const write = vi.fn();

            await expect(
                service.replaceTenantFile("tenant", null, write),
            ).rejects.toThrow(ConflictException);
            expect(write).not.toHaveBeenCalled();
        });

        it("writes otherwise and returns what the write returns", async () => {
            const { service } = setup({ stored });

            await expect(
                service.replaceTenantFile("tenant", null, () => "written"),
            ).resolves.toBe("written");
        });
    });

    describe("refusedExternalKeys", () => {
        it("refuses a key no key chain of the tenant holds on a shared provider", async () => {
            const { service, find } = setup({
                keyChains: [{ id: "a", externalKeyId: "held" }],
            });

            await expect(
                service.refusedExternalKeys("tenant", "shared", [
                    "held",
                    "foreign",
                ]),
            ).resolves.toContain("'foreign' is not a key of this tenant");
            expect(find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: "tenant", kmsProvider: "shared" },
                }),
            );
        });

        it("accepts the keys the tenant's key chains hold, also a root key", async () => {
            const { service } = setup({
                keyChains: [
                    {
                        id: "a",
                        externalKeyId: "active",
                        rootExternalKeyId: "root",
                    },
                ],
            });

            await expect(
                service.refusedExternalKeys("tenant", "shared", [
                    "root",
                    "active",
                ]),
            ).resolves.toBeUndefined();
        });

        it("accepts any key of a provider only the tenant can act as", async () => {
            const { service, find } = setup({
                stored: { providers: [vault("shared")] },
            });

            await expect(
                service.refusedExternalKeys("tenant", "shared", ["any"]),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });

        it("takes the provider from the tenant file a bundle writes", async () => {
            const { service } = setup({});

            await expect(
                service.refusedExternalKeys("tenant", "shared", ["any"], {
                    providers: [vault("shared")],
                }),
            ).resolves.toBeUndefined();
            // The bundle removes the tenant's own provider.
            const removing = setup({
                stored: { providers: [vault("shared")] },
            });
            await expect(
                removing.service.refusedExternalKeys(
                    "tenant",
                    "shared",
                    ["any"],
                    null,
                ),
            ).resolves.toContain("'any' is not a key of this tenant");
        });

        it("refuses a key on a tenant provider that uses the instance's identity", async () => {
            const { service } = setup({
                global: [],
                stored: {
                    providers: [
                        { id: "aws", type: "aws-kms", region: "eu-central-1" },
                    ],
                } as KmsConfig,
            });

            await expect(
                service.refusedExternalKeys("tenant", "aws", ["key-id"]),
            ).resolves.toContain("'key-id' is not a key of this tenant");
        });

        it("leaves a provider the tenant does not have to the check that reports it", async () => {
            const { service, find } = setup({});

            await expect(
                service.refusedExternalKeys("tenant", "unknown", ["any"]),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });
    });

    describe("keyChainsLosingOwnProvider", () => {
        const stored = { providers: [vault("shared"), vault("mine")] };
        const using = [
            { id: "a", kmsProvider: "shared" },
            { id: "b", kmsProvider: "shared" },
        ];

        it("refuses removing an own provider that shadows a shared one under key chains", async () => {
            const { service, find } = setup({ stored, keyChains: using });

            const refusal = await service.keyChainsLosingOwnProvider(
                "tenant",
                null,
            );

            expect(refusal).toContain("KMS provider 'shared'");
            expect(refusal).toContain("'a', 'b'");
            const query = find.mock.calls[0][0];
            expect(query.where.tenantId).toBe("tenant");
            // Also 'mine', which no shared provider would replace today.
            expect(query.where.kmsProvider.value).toEqual(["shared", "mine"]);
            expect(query.order).toEqual({ id: "ASC" });
        });

        it("names the key chains of one provider when several would be lost", async () => {
            const { service } = setup({
                global: [vault("shared"), vault("mine")],
                stored,
                keyChains: [
                    { id: "a", kmsProvider: "mine" },
                    { id: "b", kmsProvider: "shared" },
                ],
            });

            const refusal = await service.keyChainsLosingOwnProvider(
                "tenant",
                null,
            );

            expect(refusal).toContain("KMS provider 'mine'");
            expect(refusal).toContain("key chain 'a'.");
            expect(refusal).not.toContain("'b'");
        });

        it("refuses turning it into a provider that takes a value from the environment", async () => {
            const { service } = setup({ stored, keyChains: using });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", {
                    providers: [vault("shared", "${VAULT_TOKEN}")],
                }),
            ).resolves.toContain("KMS provider 'shared'");
        });

        it("accepts the change while no key chain uses the provider", async () => {
            const { service } = setup({ stored, keyChains: [] });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", null),
            ).resolves.toBeUndefined();
        });

        it("accepts an update that keeps the provider the tenant's own", async () => {
            const { service, find } = setup({ stored, keyChains: using });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", {
                    providers: [vault("shared", "<redacted>"), vault("mine")],
                }),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });

        it("accepts falling back to a provider that keeps keys in the database", async () => {
            const { service, find } = setup({
                global: [
                    { id: "shared", type: "db" },
                ] as KmsConfig["providers"],
                stored: {
                    providers: [
                        vault("shared"),
                        { id: "own-db", type: "db" },
                    ] as KmsConfig["providers"],
                },
                keyChains: using,
            });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", null),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });

        it("refuses removing an own provider that no provider would replace today", async () => {
            const { service } = setup({
                global: [],
                stored: { providers: [vault("mine")] },
                keyChains: [{ id: "a", kmsProvider: "mine" }],
            });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", null),
            ).resolves.toContain("KMS provider 'mine'");
        });

        it("lets the tenant replace a stored file that is no KMS configuration", async () => {
            const { service, find } = setup({
                stored,
                storedThrows: true,
                keyChains: using,
            });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", null),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });

        it("has nothing to refuse without a stored tenant file", async () => {
            const { service, find } = setup({ keyChains: using });

            await expect(
                service.keyChainsLosingOwnProvider("tenant", null),
            ).resolves.toBeUndefined();
            expect(find).not.toHaveBeenCalled();
        });
    });
});
