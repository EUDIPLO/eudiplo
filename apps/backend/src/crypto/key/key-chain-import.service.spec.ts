import {
    createPrivateKey,
    generateKeyPairSync,
    type KeyObject,
    webcrypto,
} from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainImportService } from "./key-chain-import.service.js";

const newPrivateJwk = () =>
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
        format: "jwk",
    });

describe("key replacement preparation", () => {
    it.each(["db", "vault"])(
        "keeps the live %s row when replacement certificate preparation fails",
        async (type) => {
            const service = Object.create(
                KeyChainImportService.prototype,
            ) as any;
            service.keyChainRepository = {
                findOne: vi
                    .fn()
                    .mockResolvedValue({ id: "key", usage: KeyUsage.Sign }),
                save: vi.fn(),
                delete: vi.fn(),
            };
            service.tenantRepository = {
                findOneByOrFail: async () => ({ name: "Tenant" }),
            };
            service.getPublicUrl = () => "https://issuer.example";
            service.resolveCertificateChain = () => undefined;
            const adapter = {
                type,
                capabilities: { supportedAlgs: ["ES256"], defaultAlg: "ES256" },
                importKey: vi
                    .fn()
                    .mockResolvedValue({ ref: { publicJwk: {} } }),
            };
            service.kmsRegistry = { resolve: () => adapter };
            service.certBuilder = {
                createSelfSignedCert: vi
                    .fn()
                    .mockRejectedValue(
                        new Error("certificate preparation failed"),
                    ),
            };
            const dto = {
                id: "key",
                key: { ...newPrivateJwk(), kid: "original-key-id" },
                usageType: "attestation",
            };
            await expect(service.importKeyChain("tenant", dto)).rejects.toThrow(
                "certificate preparation failed",
            );
            const imported = adapter.importKey.mock.calls[0][0];
            if (type === "db") expect(imported.kid).toBe("original-key-id");
            else expect(imported.kid).toMatch(/^key-import-/);
            expect(dto.key.kid).toBe("original-key-id");
            expect(service.keyChainRepository.save).not.toHaveBeenCalled();
            expect(service.keyChainRepository.delete).not.toHaveBeenCalled();
        },
    );
});

describe("system-owned key chains", () => {
    it("refuses to replace the tenant's encryption key chain", async () => {
        const service = Object.create(KeyChainImportService.prototype) as any;
        service.keyChainRepository = {
            findOne: vi
                .fn()
                .mockResolvedValue({ id: "key", usage: KeyUsage.Encrypt }),
            save: vi.fn(),
        };
        service.tenantRepository = {
            findOneByOrFail: async () => ({ name: "Tenant" }),
        };
        service.getPublicUrl = () => "https://issuer.example";
        const adapter = { type: "db", importKey: vi.fn() };
        service.kmsRegistry = { resolve: () => adapter };

        await expect(
            service.importKeyChain("tenant", {
                id: "key",
                key: newPrivateJwk(),
                usageType: "encrypt",
            }),
        ).rejects.toThrow(ConflictException);

        expect(service.keyChainRepository.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: "tenant", id: "key" },
            }),
        );
        expect(adapter.importKey).not.toHaveBeenCalled();
        expect(service.keyChainRepository.save).not.toHaveBeenCalled();
    });
});

describe("algorithms the provider does not offer", () => {
    it.each([
        ["standalone", false],
        ["internalChain", true],
    ])(
        "refuses a P-384 key for a provider without ES384 (%s)",
        async (_type, ca) => {
            const service = Object.create(
                KeyChainImportService.prototype,
            ) as any;
            service.keyChainRepository = {
                findOne: vi.fn().mockResolvedValue(null),
                save: vi.fn(),
            };
            service.tenantRepository = {
                findOneByOrFail: async () => ({ name: "Tenant" }),
            };
            service.getPublicUrl = () => "https://issuer.example";
            const adapter = {
                type: "http",
                providerId: "remote",
                capabilities: {
                    supportedAlgs: ["ES256"],
                    defaultAlg: "ES256",
                },
                importKey: vi.fn(),
            };
            service.kmsRegistry = { resolve: () => adapter };
            const { privateKey } = await generateKeyPair("ES384", {
                extractable: true,
            });
            const key = await exportJWK(privateKey);

            const result = service.importKeyChain("tenant", {
                id: "key",
                key,
                usageType: "attestation",
                type: ca ? "internalChain" : undefined,
            });
            await expect(result).rejects.toThrow(BadRequestException);
            await expect(result).rejects.toThrow(
                "KMS provider 'remote' does not offer ES384 for the imported key. Supported: ES256",
            );
            expect(adapter.importKey).not.toHaveBeenCalled();
            expect(service.keyChainRepository.save).not.toHaveBeenCalled();
        },
    );
});

describe("algorithms the provider offers", () => {
    it("imports a P-384 key for a provider with ES384", async () => {
        const service = Object.create(KeyChainImportService.prototype) as any;
        service.keyChainRepository = {
            findOne: vi.fn().mockResolvedValue(null),
            save: vi.fn(),
        };
        service.tenantRepository = {
            findOneByOrFail: async () => ({ name: "Tenant" }),
        };
        service.getPublicUrl = () => "https://issuer.example";
        service.logger = { log: vi.fn() };
        const adapter = {
            type: "http",
            providerId: "remote",
            capabilities: {
                supportedAlgs: ["ES256", "ES384"],
                defaultAlg: "ES256",
            },
            importKey: vi.fn(async ({ privateJwk }) => {
                const { d, ...publicJwk } = privateJwk;
                return { ref: { privateJwk, publicJwk } };
            }),
        };
        service.kmsRegistry = { resolve: () => adapter };
        service.certBuilder = {
            createSelfSignedCert: vi.fn().mockResolvedValue("PEM"),
        };
        const { privateKey } = await generateKeyPair("ES384", {
            extractable: true,
        });

        await service.importKeyChain("tenant", {
            id: "key",
            key: await exportJWK(privateKey),
            usageType: "attestation",
        });

        expect(adapter.importKey.mock.calls[0][0].privateJwk.alg).toBe("ES384");
        expect(service.keyChainRepository.save).toHaveBeenCalled();
        // An attestation key without certificate gets a document signer.
        expect(
            service.certBuilder.createSelfSignedCert.mock.calls[0][0].profile,
        ).toBe("documentSigner");
    });
});

describe("JWK private key imports", () => {
    const service = Object.create(
        KeyChainImportService.prototype,
    ) as KeyChainImportService;

    it("accepts a private key whose d belongs to x and y", () => {
        const key = newPrivateJwk();

        expect((service as any).resolvePrivateKey({ key })).toEqual(key);
    });

    it("rejects an import without key or keyPem", () => {
        expect(() => (service as any).resolvePrivateKey({})).toThrow(
            "An import requires key or keyPem.",
        );
    });

    it.each([
        ["without d", { ...newPrivateJwk(), d: undefined }],
        [
            "whose d belongs to another key",
            { ...newPrivateJwk(), d: newPrivateJwk().d },
        ],
    ])("rejects a private key %s", (_, key) => {
        expect(() => (service as any).resolvePrivateKey({ key })).toThrow(
            BadRequestException,
        );
    });
});

describe("PEM private key imports", () => {
    it("converts a PKCS#8 EC private key to JWK", async () => {
        const service = Object.create(
            KeyChainImportService.prototype,
        ) as KeyChainImportService;
        const { privateKey } = await generateKeyPair("ES256", {
            extractable: true,
        });
        const keyPem = await exportPKCS8(privateKey);

        const key = await (service as any).resolvePrivateKey({ keyPem });

        expect(key).toMatchObject({
            kty: "EC",
            crv: "P-256",
        });
        expect(key.d).toBeTypeOf("string");
    });

    it("rejects a PKCS#8 key that carries another key's public key", () => {
        const service = Object.create(
            KeyChainImportService.prototype,
        ) as KeyChainImportService;
        const sec1 = (privateKey: KeyObject) =>
            privateKey.export({ format: "der", type: "sec1" });
        const own = sec1(
            generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
        );
        const other = sec1(
            generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
        );
        // The uncompressed P-256 public key (65 bytes) ends the SEC1 structure.
        const der = Buffer.concat([
            own.subarray(0, own.length - 65),
            other.subarray(other.length - 65),
        ]);
        const keyPem = createPrivateKey({
            key: der,
            format: "der",
            type: "sec1",
        }).export({ format: "pem", type: "pkcs8" });

        expect(() => (service as any).resolvePrivateKey({ keyPem })).toThrow(
            "Invalid private key",
        );
    });
});

describe("imports with rotation enabled", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const crypto = webcrypto as Crypto;

    /** A key with a certificate, self-signed unless an issuer key is given. */
    async function keyWithCertificate(options: {
        ca: boolean;
        issuer?: CryptoKeyPair;
        issuerName?: string;
    }) {
        const keys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const certificate = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "01",
                subject: "CN=Key chain",
                issuer: options.issuerName ?? "CN=Key chain",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: keys.publicKey,
                signingKey: (options.issuer ?? keys).privateKey,
                extensions: [
                    new x509.BasicConstraintsExtension(
                        options.ca,
                        undefined,
                        true,
                    ),
                ],
            },
            crypto,
        );
        const { kty, crv, x, y, d } = await crypto.subtle.exportKey(
            "jwk",
            keys.privateKey,
        );
        return {
            key: { kty: kty!, crv: crv!, x: x!, y: y!, d: d! },
            pem: certificate.toString("pem"),
        };
    }

    function serviceFor() {
        const service = Object.create(KeyChainImportService.prototype) as any;
        service.logger = { log: vi.fn() };
        service.keyChainRepository = {
            findOne: vi.fn().mockResolvedValue(null),
            save: vi.fn(),
        };
        service.tenantRepository = {
            findOneByOrFail: async () => ({ name: "Tenant" }),
        };
        service.getPublicUrl = () => "https://issuer.example";
        service.kmsRegistry = {
            resolve: () => ({
                type: "db",
                providerId: "db",
                capabilities: { supportedAlgs: ["ES256"], defaultAlg: "ES256" },
                importKey: vi.fn(async ({ privateJwk }) => {
                    const { d, ...publicJwk } = privateJwk;
                    return { ref: { privateJwk, publicJwk } };
                }),
            }),
        };
        service.importInternalChain = vi.fn().mockResolvedValue("key");
        return service;
    }

    it.each([
        [{ enabled: true, intervalDays: 30 }, 30],
        [{ enabled: true }, 90],
    ])(
        "keeps the key of a standalone key chain as its signing key (%o)",
        async (rotationPolicy, intervalDays) => {
            const service = serviceFor();
            const { key, pem } = await keyWithCertificate({ ca: false });

            await service.importKeyChain("tenant", {
                id: "key",
                key,
                usageType: "attestation",
                crt: [pem],
                rotationPolicy,
            });

            expect(service.importInternalChain).not.toHaveBeenCalled();
            expect(service.keyChainRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    activeJwk: expect.objectContaining({ d: key.d }),
                    activeCertificate: pem,
                    rootJwk: null,
                    rootCertificate: null,
                    rotationEnabled: true,
                    rotationIntervalDays: intervalDays,
                    certValidityDays: 365,
                }),
            );
        },
    );

    it.each([
        ["a CA certificate", { ca: true }],
        ["no certificate", undefined],
    ])("imports the key as a CA key with %s", async (_, certificate) => {
        const service = serviceFor();
        const { key, pem } = await keyWithCertificate({ ca: true });

        await service.importKeyChain("tenant", {
            id: "key",
            key,
            usageType: "attestation",
            crt: certificate ? [pem] : undefined,
            rotationPolicy: { enabled: true },
        });

        expect(service.importInternalChain).toHaveBeenCalled();
        expect(service.keyChainRepository.save).not.toHaveBeenCalled();
    });

    it("rejects the self-signed certificate of another key", async () => {
        const service = serviceFor();
        const { key } = await keyWithCertificate({ ca: false });
        const other = await keyWithCertificate({ ca: false });

        await expect(
            service.importKeyChain("tenant", {
                id: "key",
                key,
                usageType: "attestation",
                crt: [other.pem],
                rotationPolicy: { enabled: true },
            }),
        ).rejects.toThrow(/does not match the provided private key/);
        expect(service.keyChainRepository.save).not.toHaveBeenCalled();
    });

    describe("with type", () => {
        /** A service that runs the internal chain import with a fake leaf. */
        function internalChainService() {
            const service = serviceFor();
            delete service.importInternalChain;
            const adapter = service.kmsRegistry.resolve();
            adapter.generateKey = vi.fn(async ({ kid }) => ({
                ref: { privateJwk: { kid }, publicJwk: { kid } },
            }));
            service.kmsRegistry = { resolve: () => adapter };
            service.certBuilder = {
                createCaSignedCert: vi.fn(async ({ caCertPem }) => ({
                    chain: ["leaf", caCertPem],
                })),
            };
            return service;
        }

        it.each([
            [undefined, false, null, null],
            [{ enabled: false }, false, null, null],
            [{ enabled: true, intervalDays: 30 }, true, 30, 365],
        ])(
            "imports internalChain as a CA key with rotation %o",
            async (rotationPolicy, enabled, intervalDays, certValidityDays) => {
                const service = internalChainService();
                const { key, pem } = await keyWithCertificate({ ca: true });

                await service.importKeyChain("tenant", {
                    id: "key",
                    key,
                    usageType: "attestation",
                    type: "internalChain",
                    crt: [pem],
                    rotationPolicy,
                });

                expect(service.keyChainRepository.save).toHaveBeenCalledWith(
                    expect.objectContaining({
                        rootJwk: expect.objectContaining({ d: key.d }),
                        rootCertificate: pem,
                        activeCertificate: `leaf\n${pem}`,
                        rotationEnabled: enabled,
                        rotationIntervalDays: intervalDays,
                        certValidityDays,
                    }),
                );
            },
        );

        it("gives the leaf of an internal chain without rotation the certificate validity it names", async () => {
            const service = internalChainService();
            const { key, pem } = await keyWithCertificate({ ca: true });
            const day = 24 * 60 * 60 * 1000;
            const start = Date.now();

            await service.importKeyChain("tenant", {
                id: "key",
                key,
                usageType: "attestation",
                type: "internalChain",
                crt: [pem],
                rotationPolicy: { enabled: false, certValidityDays: 30 },
            });

            const { notAfter } =
                service.certBuilder.createCaSignedCert.mock.calls[0][0];
            expect(notAfter.getTime()).toBeGreaterThanOrEqual(start + 30 * day);
            expect(notAfter.getTime()).toBeLessThanOrEqual(
                Date.now() + 30 * day,
            );
            // Only the policy of a rotating key chain is stored.
            expect(service.keyChainRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    rotationEnabled: false,
                    certValidityDays: null,
                }),
            );
        });

        it.each([
            ["attestation", "documentSigner"],
            ["statusList", "default"],
        ])(
            "issues the leaf of a %s CA in the %s profile",
            async (usageType, profile) => {
                const service = internalChainService();
                const { key, pem } = await keyWithCertificate({ ca: true });

                await service.importKeyChain("tenant", {
                    id: "key",
                    key,
                    usageType,
                    type: "internalChain",
                    crt: [pem],
                });

                expect(
                    service.certBuilder.createCaSignedCert.mock.calls[0][0],
                ).toEqual(expect.objectContaining({ profile }));
            },
        );

        it("rejects internalChain with a certificate that is not a CA", async () => {
            const service = internalChainService();
            const { key, pem } = await keyWithCertificate({ ca: false });

            await expect(
                service.importKeyChain("tenant", {
                    id: "key",
                    key,
                    usageType: "attestation",
                    type: "internalChain",
                    crt: [pem],
                }),
            ).rejects.toThrow(/must be a CA/);
            expect(service.keyChainRepository.save).not.toHaveBeenCalled();
        });

        it("keeps a standalone key with a CA certificate as its signing key", async () => {
            const service = serviceFor();
            const { key, pem } = await keyWithCertificate({ ca: true });

            await service.importKeyChain("tenant", {
                id: "key",
                key,
                usageType: "attestation",
                type: "standalone",
                crt: [pem],
                rotationPolicy: { enabled: true, intervalDays: 30 },
            });

            expect(service.importInternalChain).not.toHaveBeenCalled();
            expect(service.keyChainRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    activeJwk: expect.objectContaining({ d: key.d }),
                    activeCertificate: pem,
                    rootJwk: null,
                    rotationEnabled: true,
                    rotationIntervalDays: 30,
                }),
            );
        });
    });

    describe("certificates that are not a standalone one", () => {
        /** Runs the CA path, which rejects a certificate that is not a CA. */
        async function expectCaPathRejects(key: object, crt: string[]) {
            const service = serviceFor();
            delete service.importInternalChain;

            await expect(
                service.importKeyChain("tenant", {
                    id: "key",
                    key,
                    usageType: "attestation",
                    crt,
                    rotationPolicy: { enabled: true },
                }),
            ).rejects.toThrow(/Invalid root CA certificate/);
            expect(service.keyChainRepository.save).not.toHaveBeenCalled();
        }

        // The same name as the subject does not make a certificate self-signed.
        it.each(["CN=Issuer", "CN=Key chain"])(
            "a leaf certificate signed by another key (issuer %s)",
            async (issuerName) => {
                const issuer = (await crypto.subtle.generateKey(
                    algorithm,
                    true,
                    ["sign", "verify"],
                )) as CryptoKeyPair;
                const { key, pem } = await keyWithCertificate({
                    ca: false,
                    issuer,
                    issuerName,
                });

                await expectCaPathRejects(key, [pem]);
            },
        );

        it("a certificate that names another issuer", async () => {
            const { key, pem } = await keyWithCertificate({
                ca: false,
                issuerName: "CN=Issuer",
            });

            await expectCaPathRejects(key, [pem]);
        });

        it("a chain of two certificates", async () => {
            const { key, pem } = await keyWithCertificate({ ca: false });
            const other = await keyWithCertificate({ ca: false });

            await expectCaPathRejects(key, [pem, other.pem]);
        });

        it("a certificate that does not parse", async () => {
            const { key } = await keyWithCertificate({ ca: false });

            await expectCaPathRejects(key, [
                "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
            ]);
        });
    });
});
