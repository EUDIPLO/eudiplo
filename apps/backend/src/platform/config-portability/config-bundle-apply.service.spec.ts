import { webcrypto } from "node:crypto";
import {
    normalizeDocument,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { BadRequestException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { describe, expect, it, vi } from "vitest";
import type { KmsProviderRegistry } from "../../crypto/key/kms/kms-provider.registry.js";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import { ConfigKmsReferenceService } from "./config-kms-reference.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundle,
    ConfigDocument,
    ConfigImportPlan,
} from "./config-resource.types.js";
import { documentSourceHash } from "./config-source-hash.js";

describe("ConfigBundleApplyService", () => {
    it("does not apply or claim ownership of resources skipped in create mode", async () => {
        const plan: ConfigImportPlan = {
            tenantId: "tenant-a",
            mode: "create",
            applicable: true,
            items: [
                {
                    kind: "Client",
                    id: "existing",
                    action: "skip",
                    sourceVersion: "eudiplo.dev/client/v1",
                    targetVersion: "eudiplo.dev/client/v1",
                    migrations: [],
                    issues: [],
                },
            ],
            issues: [],
        };
        const bundle: ConfigBundle = {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 1,
                sourceVersion: "test",
                exportedAt: new Date(0).toISOString(),
                tenant: "tenant-a",
                resources: [],
                assets: [],
                requirements: [],
                warnings: [],
            },
            documents: [
                {
                    $schema: schemaUrl("Client"),
                    metadata: { generation: 1 },
                    spec: { clientId: "existing" },
                },
            ],
            assets: [],
        };
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.journal = {
            run: async (_tenant: string, _mode: string, execute: any) =>
                execute({ id: "run-1", operations: [] }),
            checkpoint: vi.fn(),
        };
        service.bundleService = { plan: vi.fn().mockResolvedValue(plan) };
        service.filesService = { saveImportedAsset: vi.fn() };
        service.migrationService = {
            upgrade: vi.fn((document) => ({ document })),
        };
        service.ownershipService = {
            markApplied: vi.fn(),
            remove: vi.fn(),
        };

        await expect(
            service.apply(
                "tenant-a",
                bundle,
                "create",
                "folder:/config/tenant-a",
            ),
        ).resolves.toMatchObject(plan);
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
});

function setupApply(
    actions: Array<{
        id: string;
        action: "create" | "unchanged" | "delete";
        metadataChanged?: boolean;
    }>,
) {
    const plan: ConfigImportPlan = {
        tenantId: "tenant-a",
        mode: "upsert",
        applicable: true,
        issues: [],
        items: actions.map((item) => ({
            ...item,
            kind: "Client",
            sourceVersion: "eudiplo.dev/client/v1",
            targetVersion: "eudiplo.dev/client/v1",
            migrations: [],
            issues: [],
        })),
    };
    const bundle = {
        manifest: { tenant: "tenant-a" },
        documents: actions
            .filter((item) => item.action !== "delete")
            .map((item) => ({
                $schema: schemaUrl("Client"),
                metadata: {},
                spec: { clientId: item.id },
            })),
        assets: [],
    } as unknown as ConfigBundle;
    const service = Object.create(ConfigBundleApplyService.prototype) as any;
    service.journal = {
        run: async (_tenant: string, _mode: string, execute: any) =>
            execute({ id: "run-1", operations: [] }),
        checkpoint: vi.fn(),
    };
    service.bundleService = { plan: vi.fn().mockResolvedValue(plan) };
    service.filesService = { saveImportedAsset: vi.fn() };
    service.migrationService = { upgrade: vi.fn((document) => ({ document })) };
    service.ownershipService = {
        get: vi.fn().mockResolvedValue({ ownership: "unmanaged" }),
        markApplied: vi.fn(),
        remove: vi.fn(),
    };
    service.resourceRegistry = { get: () => ({ importPhase: 1 }) };
    service.applyDocument = vi.fn();
    service.deleteDocument = vi.fn();
    return { service, bundle, plan };
}

describe("generated client secrets", () => {
    const document = {
        $schema: schemaUrl("Client"),
        metadata: { generation: 1 },
        spec: { clientId: "app", secret: "!generate" },
    };
    const appliedHash = documentSourceHash(normalizeDocument(document));

    // With Keycloak, the plan lists an existing client as an update even
    // when this source applied its document as it is.
    function setupClientApply(sourceHash: string) {
        const { service, bundle } = setupApply([]);
        service.bundleService.plan.mockResolvedValue({
            tenantId: "tenant-a",
            mode: "upsert",
            applicable: true,
            issues: [],
            items: [
                {
                    kind: "Client",
                    id: "app",
                    action: "update",
                    sourceVersion: "eudiplo.dev/client/v1",
                    targetVersion: "eudiplo.dev/client/v1",
                    migrations: [],
                    issues: [],
                },
            ],
        });
        service.ownershipService.get = vi.fn().mockResolvedValue({
            ownership: "file-managed",
            source: "bundle:tenant-a",
            sourceHash,
        });
        delete service.applyDocument;
        service.repos = { clients: { countBy: vi.fn().mockResolvedValue(1) } };
        service.clientsProvider = {
            updateClient: vi.fn(),
            rotateClientSecret: vi.fn().mockResolvedValue("rotated"),
            setClientSecret: vi.fn(),
        };
        bundle.documents = [document];
        return { service, bundle };
    }

    it("updates a client this source applied as it is and keeps its secret", async () => {
        const { service, bundle } = setupClientApply(appliedHash);
        const result = await service.apply("tenant-a", bundle, "upsert");
        expect(service.clientsProvider.updateClient).toHaveBeenCalled();
        expect(
            service.clientsProvider.rotateClientSecret,
        ).not.toHaveBeenCalled();
        expect(result.generatedSecrets).toBeUndefined();
    });

    // 9.x stored the hash of the same document as Client v1.
    it("keeps the secret of a client 9.x applied as it is", async () => {
        const { service, bundle } = setupClientApply(
            documentSourceHash(
                normalizeDocument({
                    ...document,
                    $schema: schemaUrl("Client", 1),
                }),
            ),
        );
        const result = await service.apply("tenant-a", bundle, "upsert");
        expect(service.clientsProvider.updateClient).toHaveBeenCalled();
        expect(
            service.clientsProvider.rotateClientSecret,
        ).not.toHaveBeenCalled();
        expect(result.generatedSecrets).toBeUndefined();
    });

    it("generates a new secret for a changed document or on reattach", async () => {
        const changed = setupClientApply("other");
        const reattached = setupClientApply(appliedHash);
        const results = [
            await changed.service.apply("tenant-a", changed.bundle, "upsert"),
            await reattached.service.apply(
                "tenant-a",
                reattached.bundle,
                "upsert",
                undefined,
                undefined,
                { reattach: true },
            ),
        ];
        for (const result of results)
            expect(result.generatedSecrets).toMatchObject([
                { kind: "Client", id: "app", value: "rotated" },
            ]);
    });
});

describe("apply reconciliation and recovery", () => {
    it("does not rewrite unchanged resources or their unchanged metadata", async () => {
        const { service, bundle, plan } = setupApply([
            { id: "same", action: "unchanged", metadataChanged: false },
        ]);
        expect(await service.apply("tenant-a", bundle, "upsert")).toMatchObject(
            plan,
        );
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
    it("claims ownership of matching resources without writing them", async () => {
        const { service, bundle } = setupApply([
            { id: "same", action: "unchanged", metadataChanged: true },
        ]);
        await service.apply("tenant-a", bundle, "upsert");
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).toHaveBeenCalledWith(
            expect.objectContaining({
                resourceId: "same",
                ownership: "file-managed",
            }),
            undefined,
            undefined,
        );
    });
    it("reports partial completion and preserves generated secrets when a later operation fails", async () => {
        const { service, bundle } = setupApply([
            { id: "first", action: "create" },
            { id: "failed", action: "create" },
            { id: "pending", action: "delete" },
        ]);
        const secret = {
            kind: "Client",
            id: "first",
            path: "/spec/secret",
            value: "generated-once",
        };
        service.applyDocument
            .mockResolvedValueOnce(secret)
            .mockRejectedValueOnce(
                new Error("provider error containing a private credential"),
            );
        let response: any;
        try {
            await service.apply("tenant-a", bundle, "upsert");
        } catch (error: any) {
            response = error.getResponse();
        }
        expect(response.code).toBe("CONFIG_APPLY_FAILED");
        expect(response.operations).toEqual([
            {
                stage: "resource",
                kind: "Client",
                id: "first",
                status: "completed",
            },
            {
                stage: "ownership",
                kind: "Client",
                id: "first",
                status: "completed",
            },
            {
                stage: "resource",
                kind: "Client",
                id: "failed",
                status: "failed",
            },
            {
                stage: "ownership",
                kind: "Client",
                id: "failed",
                status: "pending",
            },
            {
                stage: "delete",
                kind: "Client",
                id: "pending",
                status: "pending",
            },
            {
                stage: "delete-ownership",
                kind: "Client",
                id: "pending",
                status: "pending",
            },
        ]);
        expect(response.generatedSecrets).toEqual([secret]);
        expect(JSON.stringify(response)).not.toContain("private credential");
        expect(service.deleteDocument).not.toHaveBeenCalled();
    });
    it("distinguishes a successful resource write from a failed ownership write", async () => {
        const { service, bundle } = setupApply([
            { id: "first", action: "create" },
        ]);
        service.ownershipService.markApplied.mockRejectedValue(
            new Error("database failure"),
        );
        try {
            await service.apply("tenant-a", bundle, "upsert");
            throw new Error("Expected apply failure");
        } catch (error: any) {
            expect(
                error
                    .getResponse()
                    .operations.map((operation: any) => operation.status),
            ).toEqual(["completed", "failed"]);
        }
    });
});

describe("reviewed plans and replacement failures", () => {
    it("rejects a stale reviewed plan before any resource, asset or ownership write", async () => {
        const { service, bundle, plan } = setupApply([
            { id: "new", action: "create" },
        ]);
        plan.planFingerprint = "current";
        await expect(
            service.apply("tenant-a", bundle, "upsert", undefined, "reviewed"),
        ).rejects.toMatchObject({
            response: expect.objectContaining({ code: "CONFIG_PLAN_STALE" }),
        });
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.filesService.saveImportedAsset).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
    it("keeps the previous private key when replacement preparation fails", async () => {
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.repos = { keyChains: { delete: vi.fn(), save: vi.fn() } };
        service.keyChainService = {
            importKeyChain: vi
                .fn()
                .mockRejectedValue(new Error("invalid replacement")),
        };
        service.kmsReferenceService = { unsupportedAlgorithm: vi.fn() };
        service.migrationService = {
            unwrapForLegacyImporter: (document: any) => document.spec,
        };
        await expect(
            service.applyKeyChain("tenant", {
                metadata: { id: "key" },
                spec: { keySource: { type: "private-jwk", jwk: {} } },
            }),
        ).rejects.toThrow("invalid replacement");
        expect(service.repos.keyChains.delete).not.toHaveBeenCalled();
        expect(service.repos.keyChains.save).not.toHaveBeenCalled();
    });
    it("replaces a registrar configuration without checking its credentials", async () => {
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.registrarConfigService = {
            saveConfig: vi.fn(),
            replaceConfig: vi.fn(),
        };
        const spec = {
            registrarUrl: "https://registrar.example/api",
            oidcUrl: "https://auth.example/realms/registrar",
            clientId: "client",
            username: "user",
            password: "password",
        };

        await service.applyDocument("tenant", {
            $schema: schemaUrl("RegistrarConfig"),
            kind: "RegistrarConfig",
            metadata: {},
            spec,
        });

        expect(
            service.registrarConfigService.replaceConfig,
        ).toHaveBeenCalledWith("tenant", spec);
        expect(
            service.registrarConfigService.saveConfig,
        ).not.toHaveBeenCalled();
    });
    it("uploads only assets marked as changed by the plan", async () => {
        const { service, bundle, plan } = setupApply([]);
        bundle.assets = [
            { path: "images/same.png", data: "", sha256: "same" },
            { path: "images/new.png", data: "", sha256: "new" },
        ];
        plan.assets = [
            { path: "images/same.png", action: "unchanged", sha256: "same" },
            { path: "images/new.png", action: "create", sha256: "new" },
        ];
        await service.apply("tenant", bundle, "upsert");
        expect(service.filesService.saveImportedAsset).toHaveBeenCalledTimes(1);
        expect(service.filesService.saveImportedAsset.mock.calls[0][1]).toBe(
            "new.png",
        );
    });
});

describe("key chain replacement", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const crypto = webcrypto as Crypto;
    async function keyWithCertificate(ca = false) {
        const keys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const certificate =
            await x509.X509CertificateGenerator.createSelfSigned(
                {
                    serialNumber: "01",
                    name: "CN=Key chain",
                    notBefore: new Date(Date.now() - 60_000),
                    notAfter: new Date(Date.now() + 3_600_000),
                    keys,
                    signingAlgorithm: algorithm,
                    extensions: ca
                        ? [
                              new x509.BasicConstraintsExtension(
                                  true,
                                  undefined,
                                  true,
                              ),
                          ]
                        : [],
                },
                crypto,
            );
        return {
            jwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
            certificate: certificate.toString("pem"),
        };
    }
    function setup() {
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.repos = { keyChains: { save: vi.fn() } };
        service.kmsReferenceService = {
            verify: vi.fn(),
            unsupportedAlgorithm: vi.fn(),
        };
        service.keyChainService = { importKeyChain: vi.fn() };
        service.migrationService = new ConfigMigrationService(
            new ConfigResourceRegistry(),
        );
        return service;
    }
    const keyChain = (spec: Record<string, unknown>): ConfigDocument => ({
        $schema: schemaUrl("KeyChain"),
        kind: "KeyChain",
        metadata: {},
        spec: { id: "key", usageType: "attestation", ...spec },
    });
    // The plan reports these values as removed when the document leaves them out.
    const cleared = {
        description: null,
        rotationEnabled: false,
        rotationIntervalDays: null,
        certValidityDays: null,
    };

    it("clears the values an external key reference leaves out or sets to null", async () => {
        const service = setup();
        const externalReference = {
            type: "external-reference",
            provider: "vault",
            externalKeyId: "vault-key",
            publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        };

        await service.applyKeyChain(
            "tenant",
            keyChain({
                description: "Signing key",
                keySource: externalReference,
                crt: ["cert"],
                rotationPolicy: {
                    enabled: true,
                    intervalDays: 30,
                    certValidityDays: 365,
                },
            }),
        );
        await service.applyKeyChain(
            "tenant",
            keyChain({
                keySource: externalReference,
                crt: ["cert"],
                rotationPolicy: {
                    enabled: false,
                    intervalDays: null,
                    certValidityDays: null,
                },
            }),
        );

        const { save } = service.repos.keyChains;
        expect(save.mock.calls[0][0]).toMatchObject({
            description: "Signing key",
            rotationEnabled: true,
            rotationIntervalDays: 30,
            certValidityDays: 365,
        });
        expect(save.mock.calls[1][0]).toMatchObject(cleared);
    });
    it("clears the values an internal chain with private keys leaves out", async () => {
        const service = setup();
        const root = await keyWithCertificate(true);
        const active = await keyWithCertificate();

        await service.applyKeyChain(
            "tenant",
            keyChain({
                keySource: {
                    type: "private-jwk",
                    jwk: root.jwk,
                    activeJwk: active.jwk,
                },
                crt: [root.certificate],
                activeCertificate: active.certificate,
            }),
        );

        expect(service.repos.keyChains.save).toHaveBeenCalledWith(
            expect.objectContaining(cleared),
        );
    });
    it("rechecks an internal chain with private keys before saving it", async () => {
        const service = setup();
        const root = await keyWithCertificate(true);
        const active = await keyWithCertificate();

        await expect(
            service.applyKeyChain(
                "tenant",
                keyChain({
                    keySource: {
                        type: "private-jwk",
                        jwk: root.jwk,
                        activeJwk: active.jwk,
                    },
                    crt: [root.certificate],
                    activeCertificate: root.certificate,
                }),
            ),
        ).rejects.toThrow(
            "The first certificate in activeCertificate does not belong to keySource.activeJwk.",
        );
        expect(service.repos.keyChains.save).not.toHaveBeenCalled();
    });
    it.each([
        [
            "an internal chain with private keys",
            "jwk",
            async () => {
                const root = await keyWithCertificate(true);
                const active = await keyWithCertificate();
                return {
                    keySource: {
                        type: "private-jwk",
                        jwk: root.jwk,
                        activeJwk: active.jwk,
                    },
                    crt: [root.certificate],
                    activeCertificate: active.certificate,
                };
            },
        ],
        [
            "an external key reference",
            "publicJwk",
            async () => ({
                keySource: {
                    type: "external-reference",
                    provider: "db",
                    externalKeyId: "kms-key",
                    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
                },
                crt: ["cert"],
            }),
        ],
    ])(
        "refuses %s whose algorithm the KMS provider does not offer",
        async (_label, keyField, spec) => {
            const service = setup();
            service.kmsReferenceService = new ConfigKmsReferenceService({
                resolve: () => ({
                    providerId: "db",
                    capabilities: { supportedAlgs: ["ES384"] },
                }),
            } as unknown as KmsProviderRegistry);
            const verify = vi.spyOn(service.kmsReferenceService, "verify");

            await expect(
                service.applyKeyChain("tenant", keyChain(await spec())),
            ).rejects.toThrow(
                new BadRequestException(
                    `KMS provider 'db' does not offer ES256 for the key in keySource.${keyField}. Supported: ES384`,
                ),
            );
            expect(verify).not.toHaveBeenCalled();
            expect(service.repos.keyChains.save).not.toHaveBeenCalled();
        },
    );
    it("stores the rotation values of an internal chain with private keys as given", async () => {
        const service = setup();
        const root = await keyWithCertificate(true);
        const active = await keyWithCertificate();
        const internalChain = (rotationPolicy: Record<string, unknown>) =>
            keyChain({
                keySource: {
                    type: "private-jwk",
                    jwk: root.jwk,
                    activeJwk: active.jwk,
                },
                crt: [root.certificate],
                activeCertificate: active.certificate,
                rotationPolicy,
            });

        await service.applyKeyChain("tenant", internalChain({ enabled: true }));
        await service.applyKeyChain(
            "tenant",
            internalChain({
                enabled: false,
                intervalDays: 30,
                certValidityDays: 60,
            }),
        );

        // The document brings its own active key, so no import defaults apply.
        const { save } = service.repos.keyChains;
        expect(save.mock.calls[0][0]).toMatchObject({
            rotationEnabled: true,
            rotationIntervalDays: null,
            certValidityDays: null,
        });
        expect(save.mock.calls[1][0]).toMatchObject({
            rotationEnabled: false,
            rotationIntervalDays: 30,
            certValidityDays: 60,
        });
    });
    it.each([
        [{ type: "internalChain" }, "internalChain"],
        [{ type: "standalone", activeCertificate: "leaf" }, "standalone"],
        [{ activeCertificate: "leaf" }, "internalChain"],
        [
            {
                keySource: { type: "regenerate", keyChainType: "standalone" },
                activeCertificate: "leaf",
            },
            "standalone",
        ],
    ])("regenerates %o as %s", async (spec, type) => {
        const service = setup();
        service.keyChainService.regenerate = vi.fn();

        await service.applyKeyChain(
            "tenant",
            keyChain({ keySource: { type: "regenerate" }, ...spec }),
        );

        expect(service.keyChainService.regenerate).toHaveBeenCalledWith(
            "tenant",
            "key",
            expect.objectContaining({ type }),
        );
    });

    it("clears the description an imported private key leaves out", async () => {
        const service = setup();
        const { jwk } = await keyWithCertificate();

        await service.applyKeyChain(
            "tenant",
            keyChain({
                keySource: { type: "private-jwk", jwk },
                rotationPolicy: {
                    enabled: false,
                    intervalDays: null,
                    certValidityDays: null,
                },
            }),
        );

        expect(service.keyChainService.importKeyChain).toHaveBeenCalledWith(
            "tenant",
            expect.objectContaining({
                key: jwk,
                description: null,
                rotationPolicy: { enabled: false },
            }),
        );
    });
});
