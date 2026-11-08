import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import {
    BadRequestException,
    InternalServerErrorException,
    Logger,
    ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { importedRotationIntervals } from "../../crypto/key/key-chain-import-rotation.js";
import { ConfigImportService } from "../config-import/config-import.service.js";
import { ConfigImportOrchestratorService } from "../config-import/config-import-orchestrator.service.js";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import { ConfigFolderBundleService } from "./config-folder-bundle.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";

function createService(
    apply = vi.fn(),
    replacePlaceholders = <T>(value: T): T => value,
) {
    const registry = new ConfigResourceRegistry();
    const registerPortableRunner = vi.fn();
    const service = new ConfigFolderBundleService(
        {
            getOrThrow: () =>
                fileURLToPath(
                    new URL("../../../../../assets/config", import.meta.url),
                ),
        } as unknown as ConfigService,
        { replacePlaceholders } as ConfigImportService,
        new ConfigMigrationService(registry),
        registry,
        { apply } as unknown as ConfigBundleApplyService,
        {
            registerPortableRunner,
        } as unknown as ConfigImportOrchestratorService,
    );
    return { service, registerPortableRunner };
}

describe("ConfigFolderBundleService", () => {
    it("builds a portable bundle from the demo tenant folder", () => {
        const { service } = createService();

        const bundle = service.buildBundle(
            "demo",
            fileURLToPath(
                new URL("../../../../../assets/config/demo", import.meta.url),
            ),
        );

        expect(bundle.documents).toHaveLength(15);
        expect(bundle.assets).toHaveLength(4);
        expect(bundle.documents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    $schema: schemaUrl("IssuanceConfig"),
                }),
                expect.objectContaining({
                    $schema: schemaUrl("PresentationConfig"),
                }),
                expect.objectContaining({ $schema: schemaUrl("KeyChain") }),
            ]),
        );
        expect(bundle.manifest.resources).toHaveLength(bundle.documents.length);
        // Startups do not renew the certificates the import creates, so the
        // demo key chains must rotate before they expire.
        for (const document of bundle.documents) {
            const policy = (document.spec as any).rotationPolicy;
            if (!policy?.enabled) continue;
            const { intervalDays, certValidityDays } =
                importedRotationIntervals(policy);
            expect(intervalDays).toBeLessThan(certValidityDays);
        }
    });

    function tenantFolder(files: Record<string, string>): string {
        const root = mkdtempSync(join(tmpdir(), "eudiplo-folder-bundle-"));
        for (const [path, content] of Object.entries(files)) {
            mkdirSync(join(root, path, ".."), { recursive: true });
            writeFileSync(join(root, path), content);
        }
        return root;
    }

    it("answers 400 with the file and its required inputs when a folder file does not migrate", () => {
        const { service } = createService();
        // A 9.x trust list file: v2 needs contactUri and website. The file
        // name is not the ID; the issues name the document's.
        const root = tenantFolder({
            "trust-lists/legacy.json": JSON.stringify({
                $schema: schemaUrl("TrustList", 1),
                metadata: { generation: 1 },
                spec: {
                    id: "legacy-list",
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId: "issuer",
                            revocationKeyChainId: "status",
                            info: { name: "Example" },
                        },
                    ],
                },
            }),
        });
        try {
            let thrown: unknown;
            try {
                service.buildBundle("demo", root);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BadRequestException);
            const response = (thrown as BadRequestException).getResponse();
            expect(response).toEqual({
                code: "CONFIG_FOLDER_INVALID",
                // The startup import logs it; the format is the one of a
                // bundle's blocking issues.
                message: expect.stringMatching(
                    /^trust-lists\/legacy\.json: TRUST_LIST_CONTACT_URI_MISSING in TrustList\/legacy-list at \/spec\/entities\/0\/info\/contactUri: Add contactUri: .*; TRUST_LIST_WEBSITE_MISSING in TrustList\/legacy-list at \/spec\/entities\/0\/info\/website: Add website /,
                ),
                file: "trust-lists/legacy.json",
                issues: [
                    expect.objectContaining({
                        severity: "required-input",
                        code: "TRUST_LIST_CONTACT_URI_MISSING",
                        path: "/spec/entities/0/info/contactUri",
                        resource: { kind: "TrustList", id: "legacy-list" },
                    }),
                    expect.objectContaining({
                        severity: "required-input",
                        code: "TRUST_LIST_WEBSITE_MISSING",
                        path: "/spec/entities/0/info/website",
                        resource: { kind: "TrustList", id: "legacy-list" },
                    }),
                ],
            });
            // The startup import logs the message.
            expect((thrown as Error).message).toBe(
                (response as { message: string }).message,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("answers 400 with one CONFIG_FILE_INVALID issue for a file that is no JSON", () => {
        const { service } = createService();
        // The parser's message would quote the secret.
        const root = tenantFolder({
            "clients/broken.json": '{"secret": "top-secret",',
        });
        try {
            let thrown: unknown;
            try {
                service.buildBundle("demo", root);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BadRequestException);
            expect((thrown as BadRequestException).getResponse()).toEqual({
                code: "CONFIG_FOLDER_INVALID",
                message: "clients/broken.json: is not valid JSON",
                file: "clients/broken.json",
                issues: [
                    {
                        severity: "error",
                        code: "CONFIG_FILE_INVALID",
                        path: "",
                        message: "is not valid JSON",
                    },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("answers 400 with one CONFIG_FILE_INVALID issue for an unresolved placeholder", () => {
        const reason =
            "/spec/secret: Unresolved placeholder ${SHOP_SECRET}: no environment value or default is available";
        const { service } = createService(vi.fn(), () => {
            throw new Error(reason);
        });
        const root = tenantFolder({
            "clients/shop.json": JSON.stringify({
                $schema: schemaUrl("Client"),
                metadata: { generation: 1 },
                spec: { clientId: "shop", secret: "${SHOP_SECRET}", roles: [] },
            }),
        });
        try {
            let thrown: unknown;
            try {
                service.buildBundle("demo", root);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BadRequestException);
            expect((thrown as BadRequestException).getResponse()).toEqual({
                code: "CONFIG_FOLDER_INVALID",
                message: `clients/shop.json: ${reason}`,
                file: "clients/shop.json",
                issues: [
                    {
                        severity: "error",
                        code: "CONFIG_FILE_INVALID",
                        path: "",
                        message: reason,
                    },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("answers 400 with one CONFIG_FILE_INVALID issue for a file of another resource kind", () => {
        const { service } = createService();
        const root = tenantFolder({
            "clients/other.json": JSON.stringify({
                $schema: schemaUrl("TrustList"),
                metadata: { generation: 1 },
                spec: { id: "other", entities: [] },
            }),
        });
        try {
            let thrown: unknown;
            try {
                service.buildBundle("demo", root);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BadRequestException);
            expect((thrown as BadRequestException).getResponse()).toEqual({
                code: "CONFIG_FOLDER_INVALID",
                message:
                    "clients/other.json: contains TrustList, expected Client",
                file: "clients/other.json",
                issues: [
                    {
                        severity: "error",
                        code: "CONFIG_FILE_INVALID",
                        path: "",
                        message: "contains TrustList, expected Client",
                    },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("applies a tenant folder with a stable ownership source", async () => {
        const apply = vi.fn().mockResolvedValue({ items: [] });
        const { service, registerPortableRunner } = createService(apply);

        await service.applyTenantFolder("demo", "replace");

        expect(registerPortableRunner).toHaveBeenCalledOnce();
        expect(apply).toHaveBeenCalledWith(
            "demo",
            expect.objectContaining({
                manifest: expect.objectContaining({ tenant: "demo" }),
            }),
            "replace",
            `folder:${fileURLToPath(new URL("../../../../../assets/config/demo", import.meta.url))}`,
        );
    });

    function spyOnWarn() {
        return vi
            .spyOn(Logger.prototype, "warn")
            .mockImplementation(() => undefined);
    }

    function folderService(apply: ReturnType<typeof vi.fn>) {
        return { service: createService(apply).service, warn: spyOnWarn() };
    }

    it("names clients that got a generated secret at startup, never the secret", async () => {
        const { service, warn } = folderService(
            vi.fn().mockResolvedValue({
                items: [],
                generatedSecrets: [
                    {
                        kind: "Client",
                        id: "folder-client",
                        path: "/spec/secret",
                        value: "generated-secret-value",
                    },
                ],
            }),
        );
        try {
            await service.applyTenantFolder("demo", "upsert");

            const messages = warn.mock.calls.map(([message]) =>
                String(message),
            );
            expect(messages).toEqual([
                expect.stringContaining(
                    "[demo] Client 'folder-client' got a generated secret",
                ),
            ]);
            expect(messages[0]).toContain(
                "/api/config-bundles/resources/Client/folder-client/reattach/plan",
            );
            expect(messages.join()).not.toContain("generated-secret-value");
        } finally {
            warn.mockRestore();
        }
    });

    it("names clients that got a generated secret before a startup apply failed", async () => {
        const failure = new InternalServerErrorException({
            code: "CONFIG_APPLY_FAILED",
            generatedSecrets: [
                {
                    kind: "Client",
                    id: "folder-client",
                    path: "/spec/secret",
                    value: "generated-secret-value",
                },
            ],
        });
        const { service, warn } = folderService(
            vi.fn().mockRejectedValue(failure),
        );
        try {
            await expect(
                service.applyTenantFolder("demo", "upsert"),
            ).rejects.toBe(failure);

            const messages = warn.mock.calls.map(([message]) =>
                String(message),
            );
            expect(messages).toEqual([
                expect.stringContaining("Client 'folder-client'"),
            ]);
            expect(messages.join()).not.toContain("generated-secret-value");
        } finally {
            warn.mockRestore();
        }
    });

    it("warns about no client when the startup import generated no secret", async () => {
        const { service, warn } = folderService(
            vi.fn().mockResolvedValue({ items: [] }),
        );
        try {
            await service.applyTenantFolder("demo", "upsert");

            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("rethrows a startup apply failure without generated secrets and warns about no client", async () => {
        const failure = new Error("boom");
        const { service, warn } = folderService(
            vi.fn().mockRejectedValue(failure),
        );
        try {
            await expect(
                service.applyTenantFolder("demo", "upsert"),
            ).rejects.toBe(failure);

            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("names clients from a journal failure that reports generated secrets", async () => {
        const failure = new ServiceUnavailableException({
            code: "CONFIG_JOURNAL_WRITE_FAILED",
            generatedSecrets: [
                {
                    kind: "Client",
                    id: "folder-client",
                    path: "/spec/secret",
                    value: "generated-secret-value",
                },
            ],
        });
        const { service, warn } = folderService(
            vi.fn().mockRejectedValue(failure),
        );
        try {
            await expect(
                service.applyTenantFolder("demo", "upsert"),
            ).rejects.toBe(failure);

            expect(warn).toHaveBeenCalledOnce();
            expect(String(warn.mock.calls[0][0])).toContain(
                "Client 'folder-client'",
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("uses stable IDs for legacy singleton configuration files", () => {
        const tenantRoot = tenantFolder({
            "registrar.json": JSON.stringify({
                registrarUrl: "https://registrar.example.com/api",
                oidcUrl: "https://auth.example.com/realms/registrar",
                clientId: "test-client",
                username: "test-user",
                password: "test-password",
            }),
            "issuance/issuance.json": JSON.stringify({
                authorizationServers: [
                    { id: "issuer-built-in", type: "built-in" },
                ],
            }),
        });
        const { service } = createService();

        try {
            const bundle = service.buildBundle("test", tenantRoot);

            expect(bundle.documents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        $schema: schemaUrl("RegistrarConfig"),
                        metadata: { generation: 1 },
                    }),
                    expect.objectContaining({
                        $schema: schemaUrl("IssuanceConfig"),
                        metadata: { generation: 1 },
                    }),
                ]),
            );
        } finally {
            rmSync(tenantRoot, { recursive: true, force: true });
        }
    });
});
