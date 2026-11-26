import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubSecretReferences } from "../../../../test/secrets/secret-test-sources.js";
import type { SecretReferences } from "../../../platform/secrets/application/secret-references.js";

vi.mock("node:fs", () => ({
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ providers: [] })),
    rmSync: vi.fn(),
}));

vi.mock("@eudiplo/config-format/config-io.js", () => ({
    atomicWriteFileSync: vi.fn(),
}));

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteFileSync } from "@eudiplo/config-format/config-io.js";
import { BadRequestException } from "@nestjs/common";
import { KmsTenantConfigService } from "./kms-tenant-config.service.js";

describe("KmsTenantConfigService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const resolveTenantConfig = vi.fn();

    function createService(secrets?: SecretReferences) {
        const configService = {
            get: vi.fn((key: string) =>
                key === "CONFIG_FOLDER" ? "/config" : undefined,
            ),
        };
        return new KmsTenantConfigService(
            configService as any,
            {
                getConfig: vi.fn(),
                invalidateTenantCache: vi.fn(),
                resolveTenantConfig,
            } as any,
            { invalidateTenant: vi.fn() } as any,
            secrets,
        );
    }

    const config = { providers: [{ id: "db", type: "db" as const }] };

    it.each(["../outside", "x/../victim"])(
        "does not touch another folder's kms.json for the tenant ID %j",
        (tenantId) => {
            const service = createService();

            // Reads, such as bundle exports, see no tenant file.
            expect(service.getTenantConfig(tenantId)).toBeNull();
            expect(() => service.saveTenantConfig(tenantId, config)).toThrow(
                /not a folder name/,
            );
            expect(() => service.updateTenantConfig(tenantId, config)).toThrow(
                /not a folder name/,
            );
            expect(() => service.deleteTenantConfig(tenantId)).toThrow(
                /not a folder name/,
            );

            expect(existsSync).not.toHaveBeenCalled();
            expect(readFileSync).not.toHaveBeenCalled();
            expect(mkdirSync).not.toHaveBeenCalled();
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
            expect(rmSync).not.toHaveBeenCalled();
        },
    );

    describe("getEffectiveConfigView", () => {
        const global = {
            defaultProvider: "db",
            providers: [
                { id: "db", type: "db" as const },
                {
                    id: "shared",
                    type: "vault" as const,
                    vaultUrl: "https://vault.example.com",
                    vaultToken: "global-token",
                },
            ],
        };

        afterEach(() => {
            // The other tests read the default of the module mock.
            vi.mocked(readFileSync).mockReturnValue(
                JSON.stringify({ providers: [] }),
            );
        });

        function createViewService(stored: unknown, resolved: unknown) {
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            const getConfig = vi.fn((tenantId?: string) =>
                tenantId ? resolved : global,
            );
            const service = new KmsTenantConfigService(
                {
                    get: vi.fn((key: string) =>
                        key === "CONFIG_FOLDER" ? "/config" : undefined,
                    ),
                } as any,
                { getConfig, invalidateTenantCache: vi.fn() } as any,
                { invalidateTenant: vi.fn() } as any,
            );
            return { service, getConfig };
        }

        it("shows tenant providers as stored and never a resolved value", () => {
            const stored = {
                defaultProvider: "own",
                providers: [
                    {
                        id: "own",
                        type: "vault",
                        vaultUrl: "${TENANT_VAULT_URL}",
                        vaultToken: "${TENANT_TOKEN}",
                    },
                ],
            };
            // What loading the file gives: every placeholder replaced, and
            // an id the stored file does not hold.
            const resolved = {
                defaultProvider: "own",
                providers: [
                    ...global.providers,
                    {
                        id: "resolved-secret",
                        type: "vault",
                        vaultUrl: "https://resolved.example.com",
                        vaultToken: "resolved-secret",
                    },
                ],
            };
            const { service } = createViewService(stored, resolved);

            const view = service.getEffectiveConfigView("tenant-a");

            expect(JSON.stringify(view)).not.toContain("resolved");
            expect(JSON.stringify(view)).not.toContain("global-token");
            expect(view.defaultProvider).toBe("own");
            expect(view.providers.map((provider) => provider.id)).toEqual([
                "db",
                "shared",
                "own",
            ]);
            expect(view.providers[2]).toMatchObject({
                vaultUrl: "${TENANT_VAULT_URL}",
                vaultToken: "${TENANT_TOKEN}",
            });
        });

        it("shows a tenant provider in place of the global one with the same id", () => {
            const stored = {
                providers: [
                    {
                        id: "shared",
                        type: "vault",
                        vaultUrl: "https://tenant-vault.example.com",
                        vaultToken: "${TENANT_TOKEN}",
                    },
                ],
            };
            const { service } = createViewService(stored, global);

            const view = service.getEffectiveConfigView("tenant-a");

            expect(view.defaultProvider).toBe("db");
            expect(
                view.providers.filter((provider) => provider.id === "shared"),
            ).toEqual([
                expect.objectContaining({
                    vaultUrl: "https://tenant-vault.example.com",
                    vaultToken: "${TENANT_TOKEN}",
                }),
            ]);
            expect(JSON.stringify(view)).not.toContain("global-token");
        });

        it("shows the global configuration for a tenant without a kms.json", () => {
            const { service } = createViewService({}, global);
            vi.mocked(existsSync).mockReturnValueOnce(false);

            const view = service.getEffectiveConfigView("tenant-a");

            expect(view.providers.map((provider) => provider.id)).toEqual([
                "db",
                "shared",
            ]);
            expect(JSON.stringify(view)).not.toContain("global-token");
        });

        it("gives the reason when the stored tenant file does not load", () => {
            const { service, getConfig } = createViewService(
                { providers: [{ id: "${TENANT_TOKEN}", type: "db" }] },
                global,
            );
            getConfig.mockImplementation((tenantId?: string) => {
                if (tenantId) throw new BadRequestException("refused");
                return global;
            });

            expect(() => service.getEffectiveConfigView("tenant-a")).toThrow(
                "refused",
            );
        });
    });

    it("says whether a tenant can store a kms.json", () => {
        const service = createService();

        expect(service.canStoreTenantConfig("tenant-a")).toBe(true);
        expect(service.canStoreTenantConfig("x/../victim")).toBe(false);
        // Without CONFIG_FOLDER, saving reports the missing folder itself.
        expect(
            new KmsTenantConfigService(
                { get: vi.fn(() => undefined) } as any,
                {} as any,
                {} as any,
            ).canStoreTenantConfig("x/../victim"),
        ).toBe(true);
    });

    it("writes and deletes the tenant's own kms.json", () => {
        const service = createService();

        service.saveTenantConfig("tenant-a", config);
        service.deleteTenantConfig("tenant-a");

        expect(atomicWriteFileSync).toHaveBeenCalledWith(
            "/config/tenant-a/kms.json",
            expect.any(String),
        );
        expect(rmSync).toHaveBeenCalledWith("/config/tenant-a/kms.json");
    });
    describe("a stored file that is no KMS configuration", () => {
        afterEach(() => {
            vi.mocked(readFileSync).mockReset();
            vi.mocked(readFileSync).mockReturnValue(
                JSON.stringify({ providers: [] }),
            );
        });

        const vault = (vaultToken: string) => ({
            providers: [
                {
                    id: "vault",
                    type: "vault" as const,
                    vaultUrl: "https://vault.example",
                    vaultToken,
                },
            ],
        });

        it.each([
            ["not JSON", "hvs.stored-secret"],
            ["no valid KMS configuration", JSON.stringify({ providers: 1 })],
        ])(
            "is replaced when it is %s, and nothing of it is kept",
            (_, text) => {
                vi.mocked(existsSync).mockReturnValue(true);
                vi.mocked(readFileSync).mockReturnValue(text);
                const service = createService();

                expect(() => service.getTenantConfig("tenant-a")).toThrow(
                    BadRequestException,
                );
                expect(() =>
                    service.updateTenantConfig("tenant-a", vault("<redacted>")),
                ).toThrow(/stores no value/);
                expect(() =>
                    service.updateTenantConfig("tenant-a", vault("${TOKEN}")),
                ).toThrow(/does not accept placeholders/);
                expect(() =>
                    service.updateTenantConfig("tenant-a", {
                        providers: [
                            {
                                id: "hsm",
                                type: "pkcs11" as const,
                                library: "/usr/lib/softhsm/libsofthsm2.so",
                                slot: 0,
                                pin: "1234",
                            },
                        ],
                    }),
                ).toThrow(/names a file of the backend's host/);
                expect(atomicWriteFileSync).not.toHaveBeenCalled();

                service.updateTenantConfig("tenant-a", vault("token"));

                expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
                expect(
                    JSON.parse(vi.mocked(atomicWriteFileSync).mock.calls[0][1]),
                ).toEqual(vault("token"));
            },
        );

        it("is not replaced when it cannot be read", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockImplementation(() => {
                throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            });
            const service = createService();

            expect(() =>
                service.updateTenantConfig("tenant-a", vault("token")),
            ).toThrow("EACCES");
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });
    });

    describe("secret references", () => {
        const vault = (vaultToken: string) => ({
            providers: [
                {
                    id: "vault",
                    type: "vault" as const,
                    vaultUrl: "https://vault.example.com",
                    vaultToken,
                },
            ],
        });

        it("does not store a reference outside the tenant's namespace, and reports it to plans", () => {
            const service = createService(stubSecretReferences().secrets);
            const update = vault("${vault:kv/eudiplo/other/kms#token}");

            expect(() => service.saveTenantConfig("tenant-a", update)).toThrow(
                /providers\[0\] \('vault'\)\.vaultToken: .*no grant of tenant 'tenant-a'/,
            );
            expect(service.refusedSetting("tenant-a", update)).toEqual({
                code: "KMS_SETTING_REFUSED",
                message: expect.stringContaining(
                    "no grant of tenant 'tenant-a'",
                ),
            });
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });

        it("checks a bound reference against the server the credential is sent to", () => {
            const bound = "${vault:kv/operator/kms#token}";
            const service = createService(
                stubSecretReferences({
                    tenants: {
                        "tenant-a": {
                            bound: [
                                {
                                    ref: bound,
                                    fields: [
                                        "KmsConfig:providers.*.vaultToken",
                                    ],
                                    destinations: ["https://vault.example.com"],
                                },
                            ],
                        },
                    },
                }).secrets,
            );

            service.saveTenantConfig("tenant-a", vault(bound));
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
            const moved = vault(bound);
            moved.providers[0].vaultUrl = "https://attacker.example.com";
            expect(() => service.saveTenantConfig("tenant-a", moved)).toThrow(
                /providers\[0\] \('vault'\)\.vaultToken: /,
            );
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
        });

        it("refuses a malformed reference instead of storing it as text", () => {
            const service = createService(stubSecretReferences().secrets);
            const update = vault("${vault:kv}");

            expect(() => service.saveTenantConfig("tenant-a", update)).toThrow(
                /providers\[0\] \('vault'\)\.vaultToken: /,
            );
            expect(service.refusedSetting("tenant-a", update)?.code).toBe(
                "KMS_SETTING_REFUSED",
            );
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });

        it("keeps reference-like text a redacted literal without a policy", () => {
            const service = createService();
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue(
                JSON.stringify(vault("${vault:kv/x#y}")),
            );
            expect(
                service.getTenantConfigView("tenant-a")?.providers[0],
            ).toMatchObject({ vaultToken: "<redacted>" });
        });

        it("reports nothing to plans for a configuration of another shape", () => {
            const service = createService(stubSecretReferences().secrets);
            expect(
                service.refusedSetting("tenant-a", { providers: {} }),
            ).toBeUndefined();
        });

        it("stores a reference of its own namespace and shows it as written", () => {
            const reference = "${vault:kv/eudiplo/tenant-a/kms#token}";
            const service = createService(stubSecretReferences().secrets);

            service.saveTenantConfig("tenant-a", vault(reference));

            expect(atomicWriteFileSync).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining(reference),
            );
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue(
                JSON.stringify(vault(reference)),
            );
            expect(
                service.getTenantConfigView("tenant-a")?.providers[0],
            ).toMatchObject({ vaultToken: reference });
        });
    });

    describe("placeholders", () => {
        const vault = (vaultUrl: string, vaultToken: string) => ({
            providers: [
                { id: "vault", type: "vault" as const, vaultUrl, vaultToken },
            ],
        });

        it.each(["${MASTER_SECRET}", "prefix-${MASTER_SECRET}"])(
            "does not store the new placeholder %s",
            (vaultToken) => {
                const service = createService();
                const update = vault(
                    "https://attacker.example.com",
                    vaultToken,
                );

                expect(() =>
                    service.saveTenantConfig("tenant-a", update),
                ).toThrow(/does not accept placeholders/);
                expect(() =>
                    service.updateTenantConfig("tenant-a", update),
                ).toThrow(/does not accept placeholders/);
                expect(service.refusedSetting("tenant-a", update)).toEqual({
                    code: "KMS_PLACEHOLDER_REFUSED",
                    message: expect.stringMatching(
                        /providers\[0\] \('vault'\)\.vaultToken/,
                    ),
                });
                expect(atomicWriteFileSync).not.toHaveBeenCalled();
            },
        );

        it("keeps a placeholder the operator stored, but not for a new address", () => {
            const stored = vault(
                "https://vault.example.com",
                "${TENANT_TOKEN}",
            );
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            const service = createService();

            service.saveTenantConfig("tenant-a", stored);
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
            expect(service.refusedSetting("tenant-a", stored)).toBeUndefined();

            expect(() =>
                service.saveTenantConfig(
                    "tenant-a",
                    vault("https://attacker.example.com", "${TENANT_TOKEN}"),
                ),
            ).toThrow(/vaultUrl changes/);
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
        });

        it("reports a kept placeholder the tenant could not load, and nothing for other faults", () => {
            const stored = vault("https://vault.example.com", "${UNLISTED}");
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            const service = createService();
            resolveTenantConfig.mockImplementationOnce(() => {
                throw new BadRequestException({
                    message:
                        "${UNLISTED} is not listed in KMS_TENANT_VARIABLES",
                    errors: [{ code: "refused_environment_variable" }],
                });
            });
            expect(service.refusedSetting("tenant-a", stored)).toEqual({
                code: "KMS_PLACEHOLDER_REFUSED",
                message: expect.stringContaining("UNLISTED"),
            });

            // Validation reports a document of another shape.
            expect(
                service.refusedSetting("tenant-a", { providers: "x" }),
            ).toBeUndefined();
            // A stored file that cannot be read is reported when it is loaded.
            vi.mocked(readFileSync).mockReturnValue("{");
            expect(service.refusedSetting("tenant-a", stored)).toBeUndefined();
        });

        it("writes nothing the tenant could not load", () => {
            const stored = vault("https://vault.example.com", "${UNLISTED}");
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            resolveTenantConfig.mockImplementationOnce(() => {
                throw new Error("${UNLISTED} is not listed");
            });

            expect(() =>
                createService().saveTenantConfig("tenant-a", stored),
            ).toThrow(/UNLISTED/);
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });
    });

    describe("files of the backend's host", () => {
        const pkcs11 = (library: string) => ({
            providers: [
                {
                    id: "hsm",
                    type: "pkcs11" as const,
                    library,
                    slot: 0,
                    pin: "1234",
                },
            ],
        });
        const mtls = (baseUrl: string, keyFile = "/etc/certs/a.key") => ({
            providers: [
                {
                    id: "signer",
                    type: "http" as const,
                    baseUrl,
                    auth: {
                        type: "mtls" as const,
                        certFile: "/etc/certs/a.crt",
                        keyFile,
                    },
                },
            ],
        });

        it("does not store a library or mTLS file the API brings in", () => {
            const service = createService();

            for (const update of [
                pkcs11("/app/config/uploads/3f1c2b7e"),
                mtls("https://signer.example.com"),
            ]) {
                expect(() =>
                    service.saveTenantConfig("tenant-a", update),
                ).toThrow(/names a file of the backend's host/);
                expect(() =>
                    service.updateTenantConfig("tenant-a", update),
                ).toThrow(/names a file of the backend's host/);
                expect(service.refusedSetting("tenant-a", update)).toEqual({
                    code: "KMS_SETTING_REFUSED",
                    message: expect.stringContaining("KMS_TENANT_FILES"),
                });
            }
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });

        it("keeps the files the operator stored, but not for a new address or another file", () => {
            const stored = mtls("https://signer.example.com");
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            const service = createService();

            service.saveTenantConfig("tenant-a", stored);
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
            expect(service.refusedSetting("tenant-a", stored)).toBeUndefined();

            expect(() =>
                service.saveTenantConfig(
                    "tenant-a",
                    mtls("https://attacker.example.com"),
                ),
            ).toThrow(/baseUrl changes/);
            expect(() =>
                service.saveTenantConfig(
                    "tenant-a",
                    mtls("https://signer.example.com", "/etc/certs/b.key"),
                ),
            ).toThrow(/auth\.keyFile names a file of the backend's host/);
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
        });

        it("does not store an aws-kms provider without credentials the API brings in", () => {
            vi.mocked(readFileSync).mockReturnValue(
                JSON.stringify({ providers: [] }),
            );
            const service = createService();
            const update = {
                providers: [
                    { id: "aws", type: "aws-kms" as const, region: "eu-1" },
                ],
            };

            expect(() => service.saveTenantConfig("tenant-a", update)).toThrow(
                /needs accessKeyId and secretAccessKey/,
            );
            expect(() => service.saveTenantConfig("tenant-a", update)).toThrow(
                BadRequestException,
            );
            expect(service.refusedSetting("tenant-a", update)).toEqual({
                code: "KMS_SETTING_REFUSED",
                message: expect.stringContaining(
                    "KMS_TENANT_AWS_DEFAULT_CREDENTIALS",
                ),
            });
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
        });

        it("keeps the one the operator stored, and reports why it cannot be loaded", () => {
            const stored = {
                providers: [
                    { id: "aws", type: "aws-kms" as const, region: "eu-1" },
                ],
            };
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored));
            const service = createService();

            // The load check (mocked here) accepts it, as with the setting on.
            service.saveTenantConfig("tenant-a", stored);
            expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
            expect(service.refusedSetting("tenant-a", stored)).toBeUndefined();

            // The operator did not: the load check refuses it.
            resolveTenantConfig.mockImplementationOnce(() => {
                throw new BadRequestException({
                    message: "providers[0] ('aws') needs accessKeyId",
                    errors: [{ code: "missing_aws_credentials" }],
                });
            });
            expect(service.refusedSetting("tenant-a", stored)).toEqual({
                code: "KMS_SETTING_REFUSED",
                message: "providers[0] ('aws') needs accessKeyId",
            });
        });
    });
});
