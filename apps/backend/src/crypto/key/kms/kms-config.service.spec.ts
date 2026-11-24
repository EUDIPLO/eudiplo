import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
    existsSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BadRequestException, Logger } from "@nestjs/common";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import { KmsConfigService, mergeConfigs } from "./kms-config.service.js";

describe("KmsConfigService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.mocked(readdirSync).mockReset();
        vi.mocked(readdirSync).mockReturnValue([]);
    });

    function createService(
        configFolder = "/config",
        tenantVariables = "",
        tenantFiles = "",
        awsDefaultCredentials = false,
    ) {
        const configService = {
            get: vi.fn((key: string) => {
                if (key === "CONFIG_FOLDER") {
                    return configFolder;
                }
                if (key === "KMS_TENANT_VARIABLES") {
                    return tenantVariables;
                }
                if (key === "KMS_TENANT_FILES") {
                    return tenantFiles;
                }
                if (key === "KMS_TENANT_AWS_DEFAULT_CREDENTIALS") {
                    return awsDefaultCredentials;
                }
                return undefined;
            }),
        };

        return new KmsConfigService(
            configService as any,
            new OutboundUrlPolicyService(configService as any),
        );
    }

    describe("a tenant kms.json another process writes", () => {
        const tenantPath = "/config/tenant-a/kms.json";
        let tenantFile: string | undefined;
        const write = (providerId: string | undefined) => {
            tenantFile =
                providerId &&
                JSON.stringify({
                    providers: [
                        {
                            id: providerId,
                            type: "vault",
                            vaultUrl: "https://vault.example",
                            vaultToken: "token",
                        },
                    ],
                });
        };

        beforeEach(() => {
            tenantFile = undefined;
            vi.mocked(existsSync).mockImplementation(
                (path) => String(path) === tenantPath && !!tenantFile,
            );
            vi.mocked(readFileSync).mockImplementation((path) => {
                if (String(path) === tenantPath && tenantFile) {
                    return tenantFile;
                }
                throw new Error(`unexpected path ${String(path)}`);
            });
        });
        const providerIds = (service: KmsConfigService) =>
            service.getProviders("tenant-a").map((provider) => provider.id);

        it("is loaded again, without this process being told", () => {
            const service = createService();
            expect(providerIds(service)).toEqual(["db"]);
            expect(service.getTenantFile("tenant-a")).toBeNull();

            write("first");
            expect(providerIds(service)).toEqual(["db", "first"]);

            // Same length: nothing but the content tells the files apart.
            write("other");
            expect(providerIds(service)).toEqual(["db", "other"]);
            expect(
                service.getTenantFile("tenant-a")?.providers.map((p) => p.id),
            ).toEqual(["other"]);

            write(undefined);
            expect(providerIds(service)).toEqual(["db"]);
            expect(service.getTenantFile("tenant-a")).toBeNull();
        });

        it("fails for a changed file that does not load, instead of keeping the earlier providers", () => {
            const service = createService();
            write("first");
            expect(providerIds(service)).toEqual(["db", "first"]);

            tenantFile = "{ not json";
            expect(() => service.getConfig("tenant-a")).toThrow();
            expect(() => service.getConfig("tenant-a")).toThrow();
            expect(() => service.getTenantFile("tenant-a")).toThrow();

            write("second");
            expect(providerIds(service)).toEqual(["db", "second"]);
        });

        it("still says which providers a file holds whose providers do not load", () => {
            const service = createService();
            tenantFile = JSON.stringify({
                providers: [
                    {
                        id: "own",
                        type: "vault",
                        vaultUrl: "https://vault.example",
                        vaultToken: "token",
                    },
                    {
                        id: "refused",
                        type: "vault",
                        vaultUrl: "https://vault.example",
                        vaultToken: "${NOT_LISTED}",
                    },
                ],
            });

            expect(() => service.getConfig("tenant-a")).toThrow("NOT_LISTED");
            expect(() => service.getTenantSnapshot("tenant-a")).toThrow(
                "NOT_LISTED",
            );
            expect(
                service.getTenantFile("tenant-a")?.providers.map((p) => p.id),
            ).toEqual(["own", "refused"]);
        });

        it("refuses a file that is not JSON without quoting it", () => {
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            const service = createService();
            tenantFile = "hvs.stored-secret";

            for (const read of [
                () => service.getConfig("tenant-a"),
                () => service.getTenantFile("tenant-a"),
            ]) {
                let error: unknown;
                try {
                    read();
                } catch (thrown) {
                    error = thrown;
                }
                expect(error).toBeInstanceOf(BadRequestException);
                expect((error as BadRequestException).message).toBe(
                    "tenant 'tenant-a' kms.json: the file is not valid JSON",
                );
                expect((error as BadRequestException).message).not.toContain(
                    "stored-secret",
                );
            }
            expect(JSON.stringify(warn.mock.calls)).toContain(
                "is not valid JSON",
            );
            expect(JSON.stringify(warn.mock.calls)).not.toContain(
                "stored-secret",
            );
            warn.mockRestore();
        });

        it("stops the startup for a global file that is not JSON without quoting it", () => {
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            vi.mocked(existsSync).mockImplementation(
                (path) => String(path) === "/config/kms.json",
            );
            vi.mocked(readFileSync).mockReturnValue("hvs.stored-secret");

            expect(() => createService()).toThrow(
                /^global kms.json: the file is not valid JSON$/,
            );
            expect(JSON.stringify(warn.mock.calls)).toContain(
                "Failed to read global kms.json",
            );
            expect(JSON.stringify(warn.mock.calls)).not.toContain(
                "stored-secret",
            );
            warn.mockRestore();
        });

        it("reports a file that does not load once per content", () => {
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            const service = createService();
            tenantFile = "{ not json";

            expect(() => service.getConfig("tenant-a")).toThrow();
            expect(() => service.getConfig("tenant-a")).toThrow();

            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockRestore();
        });

        it("takes a file that vanished before it was read as no file, and fails for one it cannot read", () => {
            const service = createService();
            vi.mocked(existsSync).mockReturnValue(true);
            const failWith = (code: string) =>
                vi.mocked(readFileSync).mockImplementation(() => {
                    throw Object.assign(new Error(code), { code });
                });

            failWith("ENOENT");
            expect(providerIds(service)).toEqual(["db"]);
            expect(service.getTenantFile("tenant-a")).toBeNull();

            // Not the global provider of the same ID instead of the tenant's.
            failWith("EACCES");
            expect(() => service.getConfig("tenant-a")).toThrow("EACCES");
        });

        it("hands out configuration and file from one read", () => {
            const service = createService();
            write("first");
            vi.mocked(readFileSync).mockClear();

            const snapshot = service.getTenantSnapshot("tenant-a");

            expect(readFileSync).toHaveBeenCalledTimes(1);
            expect(snapshot.config.providers.map((p) => p.id)).toEqual([
                "db",
                "first",
            ]);
            expect(snapshot.file?.providers.map((p) => p.id)).toEqual([
                "first",
            ]);
        });

        it("is parsed once while its content stays the same", () => {
            const service = createService();
            write("first");

            const first = service.getConfig("tenant-a");

            expect(service.getConfig("tenant-a")).toBe(first);
            expect(service.getTenantFile("tenant-a")).toBe(
                service.getTenantFile("tenant-a"),
            );
        });

        it("hands out the stored file with its placeholders, from the same load", () => {
            vi.stubEnv("TENANT_TOKEN", "secret");
            const service = createService("/config", "TENANT_TOKEN");
            tenantFile = JSON.stringify({
                providers: [
                    {
                        id: "vault",
                        type: "vault",
                        vaultUrl: "https://vault.example",
                        vaultToken: "${TENANT_TOKEN}",
                    },
                ],
            });

            expect(service.getProviders("tenant-a")[1]).toMatchObject({
                vaultToken: "secret",
            });
            expect(
                service.getTenantFile("tenant-a")?.providers[0],
            ).toMatchObject({ vaultToken: "${TENANT_TOKEN}" });
        });
    });

    it("returns global providers when no tenant kms.json exists", () => {
        vi.mocked(existsSync).mockImplementation(
            (path) => String(path) === "/config/kms.json",
        );
        vi.mocked(readFileSync).mockImplementation((path) => {
            if (String(path) === "/config/kms.json") {
                return JSON.stringify({
                    defaultProvider: "db",
                    providers: [
                        {
                            id: "db",
                            type: "db",
                            description: "Default database provider",
                        },
                        {
                            id: "global-csc",
                            type: "csc",
                            baseUrl: "https://global.example.com",
                            tokenUrl: "https://global.example.com/token",
                            clientId: "global",
                            clientSecret: "secret",
                        },
                    ],
                });
            }
            throw new Error(`unexpected path ${String(path)}`);
        });

        const service = createService();

        expect(service.getDefaultProviderId("tenant-a")).toBe("db");
        expect(service.getProviders("tenant-a").map((p) => p.id)).toEqual([
            "db",
            "global-csc",
        ]);
    });

    it("merges tenant providers with global providers", () => {
        vi.mocked(existsSync).mockImplementation((path) => {
            const value = String(path);
            return (
                value === "/config/kms.json" ||
                value === "/config/tenant-a/kms.json"
            );
        });
        vi.mocked(readFileSync).mockImplementation((path) => {
            const value = String(path);
            if (value === "/config/kms.json") {
                return JSON.stringify({
                    defaultProvider: "db",
                    providers: [
                        {
                            id: "db",
                            type: "db",
                            description: "Default database provider",
                        },
                        {
                            id: "global-vault",
                            type: "vault",
                            vaultUrl: "https://vault.global",
                            vaultToken: "token",
                        },
                    ],
                });
            }

            if (value === "/config/tenant-a/kms.json") {
                return JSON.stringify({
                    defaultProvider: "tenant-csc",
                    providers: [
                        {
                            id: "tenant-csc",
                            type: "csc",
                            baseUrl: "https://tenant.example.com",
                            tokenUrl: "https://tenant.example.com/token",
                            clientId: "tenant",
                            clientSecret: "secret",
                        },
                    ],
                });
            }

            throw new Error(`unexpected path ${value}`);
        });

        const service = createService();

        expect(service.getDefaultProviderId("tenant-a")).toBe("tenant-csc");
        expect(service.getProviders("tenant-a").map((p) => p.id)).toEqual([
            "db",
            "global-vault",
            "tenant-csc",
        ]);
    });

    it("lets tenant config override a global provider with the same id", () => {
        vi.mocked(existsSync).mockImplementation((path) => {
            const value = String(path);
            return (
                value === "/config/kms.json" ||
                value === "/config/tenant-a/kms.json"
            );
        });
        vi.mocked(readFileSync).mockImplementation((path) => {
            const value = String(path);
            if (value === "/config/kms.json") {
                return JSON.stringify({
                    defaultProvider: "shared",
                    providers: [
                        {
                            id: "shared",
                            type: "vault",
                            vaultUrl: "https://vault.global",
                            vaultToken: "token",
                        },
                    ],
                });
            }

            if (value === "/config/tenant-a/kms.json") {
                return JSON.stringify({
                    providers: [
                        {
                            id: "shared",
                            type: "csc",
                            baseUrl: "https://tenant.example.com",
                            tokenUrl: "https://tenant.example.com/token",
                            clientId: "tenant",
                            clientSecret: "secret",
                        },
                    ],
                });
            }

            throw new Error(`unexpected path ${value}`);
        });

        const service = createService();

        const provider = service
            .getProviders("tenant-a")
            .find((p) => p.id === "shared");

        expect(provider?.type).toBe("csc");
        expect(service.getDefaultProviderId("tenant-a")).toBe("shared");
    });

    it("reads kms.json files wrapped in a configuration document", () => {
        vi.mocked(existsSync).mockImplementation((path) => {
            const value = String(path);
            return (
                value === "/config/kms.json" ||
                value === "/config/tenant-a/kms.json"
            );
        });
        vi.mocked(readFileSync).mockImplementation((path) => {
            const value = String(path);
            if (value === "/config/kms.json") {
                return JSON.stringify({
                    $schema:
                        "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json",
                    spec: {
                        defaultProvider: "db",
                        providers: [
                            {
                                id: "db",
                                type: "db",
                                description: "Default database provider",
                            },
                        ],
                    },
                });
            }

            if (value === "/config/tenant-a/kms.json") {
                return JSON.stringify({
                    $schema:
                        "https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json",
                    metadata: { generation: 2 },
                    spec: {
                        defaultProvider: "tenant-db",
                        providers: [
                            {
                                id: "tenant-db",
                                type: "db",
                                algorithms: ["ES384"],
                            },
                        ],
                    },
                });
            }

            throw new Error(`unexpected path ${value}`);
        });

        const service = createService();

        expect(service.getDefaultProviderId()).toBe("db");
        expect(service.getProviders("tenant-a")).toEqual([
            { id: "db", type: "db", description: "Default database provider" },
            { id: "tenant-db", type: "db", algorithms: ["ES384"] },
        ]);
        expect(service.getDefaultProviderId("tenant-a")).toBe("tenant-db");
    });

    it("rejects a kms.json document of another kind", () => {
        vi.mocked(existsSync).mockImplementation(
            (path) => String(path) === "/config/kms.json",
        );
        vi.mocked(readFileSync).mockImplementation(() =>
            JSON.stringify({
                $schema:
                    "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
                spec: { name: "demo" },
            }),
        );

        expect(() => createService()).toThrow(/expected a KmsConfig document/);
    });

    it("uses the global config for a tenant ID that is no folder name", () => {
        vi.mocked(existsSync).mockReturnValue(false);
        const service = createService();
        vi.mocked(existsSync).mockClear();

        for (const tenantId of ["../x", "x/../victim"]) {
            expect(service.getConfig(tenantId)).toBe(service.getConfig());
        }
        expect(existsSync).not.toHaveBeenCalled();
        expect(readFileSync).not.toHaveBeenCalled();
    });
    describe("environment placeholders", () => {
        const vault = (vaultUrl: string, vaultToken: string) => ({
            providers: [{ id: "vault", type: "vault", vaultUrl, vaultToken }],
        });

        /** Files by path; a missing path does not exist. */
        function files(content: Record<string, unknown>) {
            vi.mocked(existsSync).mockImplementation(
                (path) => String(path) === "/config" || String(path) in content,
            );
            vi.mocked(readFileSync).mockImplementation((path) =>
                JSON.stringify(content[String(path)]),
            );
        }

        beforeEach(() => {
            vi.stubEnv("MASTER_SECRET", "master-secret-do-not-leak");
            vi.stubEnv("VAULT_TOKEN", "instance-vault-token");
            vi.stubEnv("OPERATOR_SECRET", "operator-secret");
            vi.stubEnv("TENANT_TOKEN", "tenant-token");
        });

        it.each([
            ["${MASTER_SECRET}", /MASTER_SECRET.*setting of EUDIPLO itself/],
            ["x${MASTER_SECRET}", /MASTER_SECRET.*setting of EUDIPLO itself/],
            ["${VAULT_TOKEN}", /VAULT_TOKEN.*only the global kms.json/],
            ["${OPERATOR_SECRET}", /OPERATOR_SECRET.*KMS_TENANT_VARIABLES/],
        ])("a tenant kms.json does not resolve %s", (vaultToken, reason) => {
            files({
                "/config/tenant-a/kms.json": vault(
                    "https://attacker.example.com",
                    vaultToken,
                ),
            });
            const service = createService("/config", "TENANT_TOKEN");

            try {
                service.getProviders("tenant-a");
                expect.unreachable("expected the variable to be refused");
            } catch (error) {
                const response = (
                    error as { getResponse: () => any }
                ).getResponse();
                expect(response.message).toMatch(reason);
                expect(JSON.stringify(response)).not.toMatch(
                    /do-not-leak|instance-vault-token|operator-secret/,
                );
            }
            // The global configuration and other tenants keep working.
            expect(service.getDefaultProviderId()).toBe("db");
            expect(service.getProviders("tenant-b")).toHaveLength(1);
        });

        it("a tenant kms.json resolves the variables listed in KMS_TENANT_VARIABLES", () => {
            files({
                "/config/tenant-a/kms.json": vault(
                    "https://vault.example.com",
                    "${TENANT_TOKEN}",
                ),
            });

            expect(
                createService("/config", "TENANT_TOKEN").getProviders(
                    "tenant-a",
                ),
            ).toContainEqual(
                expect.objectContaining({ vaultToken: "tenant-token" }),
            );
        });

        it("the global kms.json resolves the operator's variables and the Vault settings, not other settings of EUDIPLO", () => {
            files({
                "/config/kms.json": vault(
                    "https://vault.example.com",
                    "${VAULT_TOKEN}${OPERATOR_SECRET}",
                ),
            });
            expect(createService().getProviders()).toContainEqual(
                expect.objectContaining({
                    vaultToken: "instance-vault-tokenoperator-secret",
                }),
            );

            files({
                "/config/kms.json": vault(
                    "https://vault.example.com",
                    "${MASTER_SECRET}",
                ),
            });
            expect(() => createService()).toThrow(
                expect.objectContaining({
                    response: expect.objectContaining({
                        message: expect.stringMatching(
                            /global kms.json: \$\{MASTER_SECRET\} names a setting of EUDIPLO itself/,
                        ),
                    }),
                }),
            );
        });

        it("does not start with a setting of EUDIPLO in KMS_TENANT_VARIABLES", () => {
            files({});
            expect(() => createService("/config", "MASTER_SECRET")).toThrow(
                /KMS_TENANT_VARIABLES: MASTER_SECRET is a setting of EUDIPLO itself/,
            );
        });

        it("starts with a tenant file it cannot read and a folder it cannot list", () => {
            const logged = vi
                .spyOn(Logger.prototype, "error")
                .mockImplementation(() => undefined);
            vi.mocked(existsSync).mockImplementation(
                (path) => String(path) !== "/config/kms.json",
            );
            vi.mocked(readFileSync).mockReturnValue("{");
            vi.mocked(readdirSync).mockReturnValue([
                { name: "tenant-a", isDirectory: () => true },
            ] as any);
            expect(() => createService()).not.toThrow();

            vi.mocked(readdirSync).mockImplementation(() => {
                throw new Error("EACCES");
            });
            expect(() => createService()).not.toThrow();
            expect(logged).not.toHaveBeenCalled();
            logged.mockRestore();
            vi.mocked(readdirSync).mockReset();
        });

        it.each([
            [
                "a provider id",
                { providers: [{ id: "${TENANT_TOKEN}", type: "db" }] },
            ],
            [
                "defaultProvider",
                {
                    defaultProvider: "x${TENANT_TOKEN}",
                    providers: [{ id: "db", type: "db" }],
                },
            ],
        ])(
            "a tenant kms.json cannot use a listed variable in %s",
            (_, config) => {
                const logged = vi
                    .spyOn(Logger.prototype, "error")
                    .mockImplementation(() => undefined);
                files({ "/config/tenant-a/kms.json": config });
                vi.mocked(readdirSync).mockReturnValue([
                    { name: "tenant-a", isDirectory: () => true },
                ] as any);

                const service = createService("/config", "TENANT_TOKEN");

                const refusal = (load: () => unknown) => {
                    let thrown: { getResponse: () => any } | undefined;
                    try {
                        load();
                    } catch (error) {
                        thrown = error as { getResponse: () => any };
                    }
                    expect(thrown).toBeDefined();
                    const response = thrown?.getResponse();
                    expect(JSON.stringify(response)).not.toContain(
                        "tenant-token",
                    );
                    return response;
                };
                // The file is not loaded. The reason may be the schema's: it
                // runs first and knows no provider of that name.
                refusal(() => service.getProviders("tenant-a"));
                expect(
                    refusal(() =>
                        service.resolveTenantConfig(
                            config,
                            "tenant KMS configuration",
                        ),
                    ).message,
                ).toMatch(
                    /names \$\{TENANT_TOKEN\}: the identifiers of a tenant kms\.json cannot hold a placeholder/,
                );
                // Reported at startup, without the variable's value.
                expect(logged).toHaveBeenCalledTimes(1);
                expect(logged.mock.calls[0][0]).toMatch(/identifiers/);
                expect(logged.mock.calls[0][0]).not.toContain("tenant-token");
                logged.mockRestore();
            },
        );

        it("reports an identifier placeholder together with the other refused variables", () => {
            const logged = vi
                .spyOn(Logger.prototype, "error")
                .mockImplementation(() => undefined);
            files({
                "/config/tenant-a/kms.json": {
                    providers: [
                        {
                            id: "${TENANT_TOKEN}",
                            type: "vault",
                            vaultUrl: "https://attacker.example.com",
                            vaultToken: "${MASTER_SECRET}",
                        },
                    ],
                },
            });
            vi.mocked(readdirSync).mockReturnValue([
                { name: "tenant-a", isDirectory: () => true },
            ] as any);

            createService("/config", "TENANT_TOKEN");

            expect(logged).toHaveBeenCalledTimes(1);
            expect(logged.mock.calls[0][0]).toMatch(
                /providers\.0\.id names \$\{TENANT_TOKEN\}.*MASTER_SECRET/,
            );
            expect(logged.mock.calls[0][0]).not.toMatch(
                /tenant-token|do-not-leak/,
            );
            logged.mockRestore();
        });

        it("reports tenant files with refused variables at startup", () => {
            const logged = vi
                .spyOn(Logger.prototype, "error")
                .mockImplementation(() => undefined);
            files({
                "/config/tenant-a/kms.json": vault(
                    "https://attacker.example.com",
                    "${MASTER_SECRET}",
                ),
                "/config/tenant-b/kms.json": vault(
                    "https://vault.example.com",
                    "${TENANT_TOKEN}",
                ),
            });
            vi.mocked(readdirSync).mockReturnValue(
                ["tenant-a", "tenant-b", "images"].map((name) => ({
                    name,
                    isDirectory: () => true,
                })) as any,
            );

            createService("/config", "TENANT_TOKEN");

            expect(logged).toHaveBeenCalledTimes(1);
            expect(logged.mock.calls[0][0]).toMatch(
                /\/config\/tenant-a\/kms\.json cannot be loaded.*MASTER_SECRET/,
            );
            expect(logged.mock.calls[0][0]).not.toContain("do-not-leak");
            logged.mockRestore();
        });
    });

    describe("settings only the global kms.json may hold", () => {
        const LIBRARY = "/usr/lib/softhsm/libsofthsm2.so";
        const pkcs11 = (library: string) => ({
            providers: [
                { id: "hsm", type: "pkcs11", library, slot: 0, pin: "1234" },
            ],
        });
        const mtls = (certFile: string, keyFile: string, caFile?: string) => ({
            providers: [
                {
                    id: "signer",
                    type: "http",
                    baseUrl: "https://signer.example.com",
                    auth: { type: "mtls", certFile, keyFile, caFile },
                },
            ],
        });
        const aws = (credentials: Record<string, string>) => ({
            providers: [
                { id: "aws", type: "aws-kms", region: "eu-1", ...credentials },
            ],
        });

        function files(content: Record<string, unknown>) {
            vi.mocked(existsSync).mockImplementation(
                (path) => String(path) === "/config" || String(path) in content,
            );
            vi.mocked(readFileSync).mockImplementation((path) =>
                JSON.stringify(content[String(path)]),
            );
        }

        it.each([
            ["an uploaded library", pkcs11("/app/config/uploads/3f1c2b7e")],
            ["a relative library", pkcs11("libsofthsm2.so")],
            ["a device as key file", mtls("/etc/certs/a.crt", "/dev/zero")],
            [
                "an unlisted CA file",
                mtls("/etc/certs/a.crt", "/etc/certs/a.key", "/etc/passwd"),
            ],
        ])("a tenant kms.json does not load with %s", (_name, config) => {
            files({ "/config/tenant-a/kms.json": config });
            const service = createService(
                "/config",
                "",
                `${LIBRARY}, /etc/certs/a.crt,/etc/certs/a.key`,
            );

            expect(() => service.getConfig("tenant-a")).toThrow(
                /not listed in KMS_TENANT_FILES/,
            );
            expect(() =>
                service.resolveTenantConfig(config, "tenant KMS configuration"),
            ).toThrow(/not listed in KMS_TENANT_FILES/);
        });

        it("a tenant kms.json loads with the files listed in KMS_TENANT_FILES", () => {
            vi.stubEnv("TENANT_LIBRARY", LIBRARY);
            files({
                "/config/tenant-a/kms.json": pkcs11(
                    "/usr/lib/softhsm/../softhsm/libsofthsm2.so",
                ),
                "/config/tenant-b/kms.json": mtls(
                    "/etc/certs/a.crt",
                    "/etc/certs/a.key",
                ),
                "/config/tenant-c/kms.json": pkcs11("${TENANT_LIBRARY}"),
            });
            const service = createService(
                "/config",
                "TENANT_LIBRARY",
                `${LIBRARY}, /etc/certs/a.crt,/etc/certs/a.key`,
            );

            for (const tenant of ["tenant-a", "tenant-b", "tenant-c"]) {
                expect(service.getProviders(tenant)).toHaveLength(2);
            }
        });

        it.each([{}, { accessKeyId: "AKIA" }, { secretAccessKey: "secret" }])(
            "a tenant kms.json does not load an aws-kms provider with the credentials %j",
            (credentials) => {
                files({ "/config/tenant-a/kms.json": aws(credentials) });

                expect(() => createService().getConfig("tenant-a")).toThrow(
                    /needs accessKeyId and secretAccessKey/,
                );
            },
        );

        it("a tenant kms.json loads an aws-kms provider without credentials with KMS_TENANT_AWS_DEFAULT_CREDENTIALS", () => {
            files({ "/config/tenant-a/kms.json": aws({}) });
            const logged = vi
                .spyOn(Logger.prototype, "error")
                .mockImplementation(() => undefined);
            vi.mocked(readdirSync).mockReturnValue([
                { name: "tenant-a", isDirectory: () => true },
            ] as any);

            const service = createService("/config", "", "", true);

            expect(service.getProviders("tenant-a")).toHaveLength(2);
            expect(() =>
                service.resolveTenantConfig(
                    aws({}),
                    "tenant KMS configuration",
                ),
            ).not.toThrow();
            expect(logged).not.toHaveBeenCalled();
            logged.mockRestore();
        });

        it.each([{ accessKeyId: "AKIA" }, { secretAccessKey: "secret" }])(
            "not with only %j: one value alone does not choose the instance's identity",
            (credentials) => {
                files({ "/config/tenant-a/kms.json": aws(credentials) });

                expect(() =>
                    createService("/config", "", "", true).getConfig(
                        "tenant-a",
                    ),
                ).toThrow(/only one of them is set/);
            },
        );

        it("a tenant kms.json loads an aws-kms provider with its own credentials", () => {
            files({
                "/config/tenant-a/kms.json": aws({
                    accessKeyId: "AKIA",
                    secretAccessKey: "secret",
                }),
            });

            expect(createService().getProviders("tenant-a")).toHaveLength(2);
        });

        it("the global kms.json keeps all of them", () => {
            files({
                "/config/kms.json": {
                    providers: [
                        ...pkcs11("/opt/hsm/lib.so").providers,
                        ...mtls("/etc/certs/g.crt", "/etc/certs/g.key")
                            .providers,
                        ...aws({}).providers,
                    ],
                },
            });

            expect(createService().getProviders()).toHaveLength(3);
        });

        const servers = (url: string) => ({
            providers: [
                { id: "vault", type: "vault", vaultUrl: url, vaultToken: "t" },
                { id: "signer", type: "http", baseUrl: url },
                {
                    id: "oauth",
                    type: "http",
                    baseUrl: "https://signer.example.com",
                    auth: {
                        type: "oauth2-client-credentials",
                        tokenUrl: url,
                        clientId: "id",
                        clientSecret: "secret",
                    },
                },
                {
                    id: "csc",
                    type: "csc",
                    baseUrl: url,
                    tokenUrl: url,
                    clientId: "id",
                    clientSecret: "secret",
                },
            ],
        });

        it.each([
            [
                "a private address",
                "https://10.0.0.5:8200",
                /private or loopback/,
            ],
            ["the backend's own host", "https://localhost:8200", /not allowed/],
            [
                "a server without TLS",
                "http://kms.example.com",
                /must use HTTPS/,
            ],
        ])(
            "a tenant kms.json does not load with a provider on %s",
            (_name, url, reason) => {
                const config = servers(url);
                files({ "/config/tenant-a/kms.json": config });
                const service = createService();

                expect(() => service.getConfig("tenant-a")).toThrow(reason);
                let issues: { path: unknown[]; code: string }[] = [];
                try {
                    service.resolveTenantConfig(
                        config,
                        "tenant KMS configuration",
                    );
                } catch (error) {
                    issues = (error as any).getResponse().errors;
                }
                expect(issues).toEqual([
                    expect.objectContaining({
                        path: ["providers", 0, "vaultUrl"],
                        code: "refused_outbound_url",
                    }),
                    expect.objectContaining({
                        path: ["providers", 1, "baseUrl"],
                    }),
                    expect.objectContaining({
                        path: ["providers", 2, "auth", "tokenUrl"],
                    }),
                    expect.objectContaining({
                        path: ["providers", 3, "baseUrl"],
                    }),
                    expect.objectContaining({
                        path: ["providers", 3, "tokenUrl"],
                    }),
                ]);
            },
        );

        it("a tenant kms.json loads with providers on public servers, and the global kms.json with any server", () => {
            files({
                "/config/kms.json": servers("http://10.0.0.5:8200"),
                "/config/tenant-a/kms.json": {
                    providers: servers("https://kms.example.com").providers.map(
                        (provider) => ({
                            ...provider,
                            id: `own-${provider.id}`,
                        }),
                    ),
                },
            });

            expect(createService().getProviders("tenant-a")).toHaveLength(8);
        });

        it("does not start with a relative path in KMS_TENANT_FILES", () => {
            files({});
            expect(() => createService("/config", "", "lib.so")).toThrow(
                /KMS_TENANT_FILES: 'lib.so' is not an absolute path/,
            );
        });

        it.each([
            {
                id: "signer",
                type: "http",
                baseUrl: "https://signer.example.com",
                keysPath: "@attacker.example/keys",
            },
            {
                id: "csc",
                type: "csc",
                baseUrl: "https://csc.example.com",
                tokenUrl: "https://csc.example.com/token",
                clientId: "client",
                clientSecret: "secret",
                apiPath: ".attacker.example/csc/v2",
            },
        ])(
            "a tenant kms.json does not load a $type provider whose path leaves baseUrl",
            (provider) => {
                files({
                    "/config/tenant-a/kms.json": { providers: [provider] },
                });

                expect(() => createService().getConfig("tenant-a")).toThrow(
                    /must be a path on the server of baseUrl/,
                );
            },
        );

        it("reports tenant files with refused settings at startup", () => {
            const logged = vi
                .spyOn(Logger.prototype, "error")
                .mockImplementation(() => undefined);
            vi.stubEnv("TENANT_LIBRARY", LIBRARY);
            files({
                "/config/tenant-a/kms.json": pkcs11("/app/uploads/3f1c2b7e"),
                "/config/tenant-b/kms.json": pkcs11(LIBRARY),
                "/config/tenant-c/kms.json": pkcs11("${TENANT_LIBRARY}"),
                "/config/tenant-d/kms.json": aws({}),
                // Loads: nothing to report for a baseUrl behind a placeholder.
                "/config/tenant-f/kms.json": {
                    providers: [
                        {
                            id: "signer",
                            type: "http",
                            baseUrl: "${TENANT_LIBRARY}",
                            keysPath: "/v1/keys",
                        },
                    ],
                },
                "/config/tenant-e/kms.json": aws({
                    accessKeyId: "${TENANT_LIBRARY}",
                }),
                "/config/tenant-g/kms.json": {
                    providers: [
                        {
                            id: "vault",
                            type: "vault",
                            vaultUrl: "https://10.0.0.5:8200",
                            vaultToken: "token",
                        },
                    ],
                },
            });
            vi.mocked(readdirSync).mockReturnValue(
                [
                    "tenant-a",
                    "tenant-b",
                    "tenant-c",
                    "tenant-d",
                    "tenant-e",
                    "tenant-f",
                    "tenant-g",
                ].map((name) => ({ name, isDirectory: () => true })) as any,
            );

            createService("/config", "TENANT_LIBRARY", LIBRARY);

            expect(logged.mock.calls.map((call) => call[0])).toEqual([
                expect.stringMatching(
                    /\/config\/tenant-a\/kms\.json cannot be loaded.*KMS_TENANT_FILES/,
                ),
                expect.stringMatching(
                    /\/config\/tenant-d\/kms\.json cannot be loaded.*accessKeyId/,
                ),
                expect.stringMatching(
                    /\/config\/tenant-e\/kms\.json cannot be loaded.*accessKeyId and secretAccessKey/,
                ),
                expect.stringMatching(
                    /\/config\/tenant-g\/kms\.json cannot be loaded.*outbound URL policy/,
                ),
            ]);
            logged.mockRestore();
        });
    });
});

describe("mergeConfigs", () => {
    it("hands on the providers of the global file as they are, so the registry can tell them from a tenant's", () => {
        const global = {
            providers: [
                { id: "db", type: "db" },
                { id: "kms", type: "db" },
            ],
        } as any;
        const tenant = { providers: [{ id: "kms", type: "db" }] } as any;

        const merged = mergeConfigs(global, tenant);

        expect(merged.providers[0]).toBe(global.providers[0]);
        expect(merged.providers[1]).toBe(tenant.providers[0]);
    });
});
