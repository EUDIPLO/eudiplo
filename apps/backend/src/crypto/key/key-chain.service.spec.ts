import { webcrypto } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as x509 from "@peculiar/x509";
import { describe, expect, it, vi } from "vitest";
import { Role } from "../../auth/roles/role.enum.js";
import { RolesGuard } from "../../auth/roles/roles.guard.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { CertificateBuilderService } from "./cert/certificate-builder.service.js";
import { KeyChainReferences } from "./application/key-chain-references.js";
import {
    KeyChainInUseError,
    type KeyChainReference,
} from "./domain/key-chain-reference.js";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainController } from "./key-chain.controller.js";
import { KeyChainService } from "./key-chain.service.js";
import { KeyChainImportSchema } from "./schemas/key-chain.schema.js";
import { KeyUsageType } from "./types/key-usage-type.js";

const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
    y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
    d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
    kid: "key-active",
    alg: "ES256",
};

const rootJwk = { ...privateJwk, kid: "key-root" };

/** Tenant repository whose tenant names `id` as its default access key chain. */
const tenantWithDefault = (id: string | null) => ({
    findOne: vi.fn(async () => ({
        id: "tenant",
        defaultKeyChains: id ? { access: id } : null,
    })),
});

function keyChain(overrides: Partial<KeyChainEntity>): KeyChainEntity {
    return Object.assign(new KeyChainEntity(), {
        id: "key",
        tenantId: "tenant",
        usageType: KeyUsageType.Attestation,
        kmsProvider: "db",
        activeJwk: privateJwk,
        activeCertificate: "",
        rotationEnabled: false,
        createdAt: new Date(0),
        ...overrides,
    });
}

function serviceFor(entity: KeyChainEntity, providerType: string) {
    const service = Object.create(KeyChainService.prototype) as any;
    service.keyChainRepository = {
        findOne: vi.fn().mockResolvedValue(entity),
    };
    service.kmsRegistry = { resolve: () => ({ type: providerType }) };
    service.certBuilder = { splitPemChain: (pem: string) => [pem] };
    return service as KeyChainService;
}

describe("KeyChainService.export", () => {
    it("exports the private key of a database-held key chain", async () => {
        const service = serviceFor(keyChain({}), "db");

        const exported = await service.export("tenant", "key");

        expect(exported.key.d).toBe(privateJwk.d);
    });

    it("never exports private material of an external KMS key chain", async () => {
        // The entity only stores the public JWK for external providers; a
        // private component must still never be returned if one is present.
        const service = serviceFor(
            keyChain({
                kmsProvider: "vault",
                externalKeyId: "vault-key",
                activeJwk: privateJwk,
            }),
            "vault",
        );

        const exported = await service.export("tenant", "key");

        expect(exported.key).not.toHaveProperty("d");
        expect(exported.key.x).toBe(privateJwk.x);
        expect(exported.kmsProvider).toBe("vault");
    });

    it("strips private material when the provider is not a database provider", async () => {
        const service = serviceFor(
            keyChain({ kmsProvider: "hsm", activeJwk: privateJwk }),
            "pkcs11",
        );

        const exported = await service.export("tenant", "key");

        expect(exported.key).not.toHaveProperty("d");
    });

    it("leaves out unset optional columns so the import accepts the export", async () => {
        // Nullable columns are read back as null, not undefined.
        const service = serviceFor(
            keyChain({
                description: null,
                rotationEnabled: true,
                rotationIntervalDays: null,
                certValidityDays: null,
            } as unknown as Partial<KeyChainEntity>),
            "db",
        );

        const exported = JSON.parse(
            JSON.stringify(await service.export("tenant", "key")),
        );

        expect(exported).not.toHaveProperty("description");
        expect(exported.rotationPolicy).toEqual({ enabled: true });
        expect(KeyChainImportSchema.safeParse(exported).success).toBe(true);
    });

    it("exports the description and rotation intervals that are set", async () => {
        const service = serviceFor(
            keyChain({
                description: "Signing",
                rotationEnabled: true,
                rotationIntervalDays: 90,
                certValidityDays: 365,
            }),
            "db",
        );

        const exported = await service.export("tenant", "key");

        expect(exported).toMatchObject({
            description: "Signing",
            rotationPolicy: {
                enabled: true,
                intervalDays: 90,
                certValidityDays: 365,
            },
        });
    });

    it.each([
        ["a standalone key chain", {}, "standalone", privateJwk, ["leaf"]],
        [
            "the root of an internal chain",
            { rootJwk: rootJwk, rootCertificate: "root" },
            "internalChain",
            rootJwk,
            ["root"],
        ],
    ])("exports the type of %s", async (_, overrides, type, key, crt) => {
        const service = serviceFor(
            keyChain({ activeCertificate: "leaf", ...overrides }),
            "db",
        );

        const exported = await service.export("tenant", "key");

        expect(exported).toMatchObject({ type, key, crt });
        expect(KeyChainImportSchema.safeParse(exported).success).toBe(true);
    });

    it("scopes the lookup to the tenant's signing key chains", async () => {
        const service = serviceFor(keyChain({}), "db") as any;

        await service.export("tenant", "key");

        expect(service.keyChainRepository.findOne).toHaveBeenCalledWith({
            where: { tenantId: "tenant", id: "key", usage: KeyUsage.Sign },
        });
    });
});

describe("KeyChainService.getById public keys", () => {
    const { d: _d, ...publicJwk } = privateJwk;

    it("returns the active and previous public keys as complete public JWKs", async () => {
        const service = serviceFor(
            keyChain({
                previousJwk: { ...privateJwk, kid: "key-previous" },
                // Required with previousJwk; its content does not matter here.
                previousCertificate: "not a certificate",
            }),
            "db",
        );

        const response = await service.getById("tenant", "key");

        expect(response.activePublicKey).toEqual(publicJwk);
        expect(response.previousPublicKey).toEqual({
            ...publicJwk,
            kid: "key-previous",
        });
    });

    it("returns the public parameters of OKP and RSA keys but no private members", async () => {
        const okp = {
            kty: "OKP",
            crv: "Ed25519",
            x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
        };
        const rsa = {
            kty: "RSA",
            alg: "RS256",
            n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
            e: "AQAB",
            d: "X4cTteJY_gn4FYPsXB8rdXix5vwsg1FLN5E3EaG6RJoVH-HLLKD9M7dx5oo7GURknchnrRweUkC7hT5fJLM0WbFAKNLWY2vv7B6NqXSzUvxT0_YSfqijwp3RTzlBaCxWp4doFk5N2o8Gy_nHNKroADIkJ46pRUohsXywbReAdYaMwFs9tv8d_cPVY3i07a3t8MN6TNwm0dSawm9v47UiCl3Sk5ZiG7xojPLu4sbg1U2jx4IBTNBznbJSzFHK66jT8bgkuqsk0GjskDJk19Z4qwjwbsnn4j2WBii3RL-Us2lGVkY8fkFzme1z0HbIkfz0Y6mqnOYtqc0X4jfcKoAC8Q",
            p: "83i-7IvMGXoMXCskv73TKr8637FiO7Z27zv8oj6pbWUQyLPQBQxtPVnwD20R-60eTDmD2ujnMt5PoqMrm8RfmNhVWDtjjMmCMjOpSXicFHj7XOuVIYQyqVWlWEh6dN36GVZYk93N8Bc9vY41xy8B9RzzOGVQzXvNEvn7O0nVbfs",
            q: "3dfOR9cuYq-0S-mkFLzgItgMEfFzB2q3hWehMuG0oCuqnb3vobLyumqjVZQO1dIrdwgTnCdpYzBcOfW5r370AFXjiWft_NGEiovonizhKpo9VVS78TzFgxkIdrecRezsZ-1kYd_s1qDbxtkDEgfAITAG9LUnADun4vIcb6yelxk",
        };

        const okpInfo = await serviceFor(
            keyChain({ kmsProvider: "vault", activeJwk: okp }),
            "vault",
        ).getById("tenant", "key");
        const rsaInfo = await serviceFor(
            keyChain({ activeJwk: rsa }),
            "db",
        ).getById("tenant", "key");

        expect(okpInfo.activePublicKey).toEqual({
            kty: "OKP",
            crv: "Ed25519",
            x: okp.x,
        });
        expect(rsaInfo.activePublicKey).toEqual({
            kty: "RSA",
            alg: "RS256",
            n: rsa.n,
            e: rsa.e,
        });
    });
});

describe("KeyChainService.update rotation policy", () => {
    function updateServiceFor(entity: KeyChainEntity) {
        const service = serviceFor(entity, "db") as any;
        service.certBuilder = {
            splitPemChain: CertificateBuilderService.prototype.splitPemChain,
        };
        service.keyChainRepository.update = vi.fn();
        service.logger = { log: vi.fn() };
        return service as KeyChainService & {
            keyChainRepository: { update: ReturnType<typeof vi.fn> };
        };
    }

    it("rejects enabling rotation without an interval", async () => {
        const service = updateServiceFor(
            keyChain({
                rotationIntervalDays: null,
            } as unknown as Partial<KeyChainEntity>),
        );

        await expect(
            service.update("tenant", "key", {
                rotationPolicy: { enabled: true },
            }),
        ).rejects.toThrow(BadRequestException);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });

    it("enables rotation with the interval of the request", async () => {
        const service = updateServiceFor(keyChain({}));

        await service.update("tenant", "key", {
            rotationPolicy: { enabled: true, intervalDays: 30 },
        });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { rotationEnabled: true, rotationIntervalDays: 30 },
        );
    });

    it("enables rotation with the stored interval", async () => {
        const service = updateServiceFor(
            keyChain({ rotationIntervalDays: 90 }),
        );

        await service.update("tenant", "key", {
            rotationPolicy: { enabled: true },
        });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { rotationEnabled: true },
        );
    });

    it("turns off rotation of a key chain without interval", async () => {
        const service = updateServiceFor(
            keyChain({
                rotationEnabled: true,
                rotationIntervalDays: null,
            } as unknown as Partial<KeyChainEntity>),
        );

        await service.update("tenant", "key", {
            rotationPolicy: { enabled: false },
        });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { rotationEnabled: false },
        );
    });

    it("leaves other updates of a key chain without interval alone", async () => {
        const service = updateServiceFor(
            keyChain({
                rotationEnabled: true,
                rotationIntervalDays: null,
            } as unknown as Partial<KeyChainEntity>),
        );

        await service.update("tenant", "key", { description: "Signing" });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { description: "Signing" },
        );
    });

    /** A certificate for the public key, issued by an external CA. */
    async function certificateFor(publicKey: CryptoKey): Promise<string> {
        const algorithm = { name: "ECDSA", namedCurve: "P-256" };
        const ca = (await webcrypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const certificate = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "01",
                subject: "CN=Verifier",
                issuer: "CN=External CA",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: { ...algorithm, hash: "SHA-256" },
                publicKey,
                signingKey: ca.privateKey,
            },
            webcrypto as Crypto,
        );
        return certificate.toString("pem");
    }

    const { d: _d, ...activePublicJwk } = privateJwk;
    const activePublicKey = () =>
        webcrypto.subtle.importKey(
            "jwk",
            activePublicJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["verify"],
        );

    it("keeps the description when only the certificate changes", async () => {
        const service = updateServiceFor(keyChain({}));
        const pem = await certificateFor(await activePublicKey());

        await service.update("tenant", "key", { activeCertificate: pem });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { activeCertificate: pem.trim() },
        );
    });

    it("refuses a certificate issued for another key", async () => {
        const service = updateServiceFor(keyChain({}));
        const other = (await webcrypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        )) as CryptoKeyPair;

        await expect(
            service.update("tenant", "key", {
                activeCertificate: await certificateFor(other.publicKey),
            }),
        ).rejects.toThrow(BadRequestException);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });

    it("refuses a leaf that is not first in the chain", async () => {
        const service = updateServiceFor(keyChain({}));
        const other = (await webcrypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        )) as CryptoKeyPair;
        const chain = `${await certificateFor(other.publicKey)}\n${await certificateFor(await activePublicKey())}`;

        await expect(
            service.update("tenant", "key", { activeCertificate: chain }),
        ).rejects.toThrow(/first certificate is not issued for the active key/);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });

    const ecdsa = { name: "ECDSA", namedCurve: "P-256" };
    const validity = {
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3_600_000),
    };
    const newKeys = async () =>
        (await webcrypto.subtle.generateKey(ecdsa, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;

    /** A self-signed CA certificate. */
    async function rootCa(name = "CN=Root CA") {
        const keys = await newKeys();
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name,
                ...validity,
                signingAlgorithm: { ...ecdsa, hash: "SHA-256" },
                keys,
            },
            webcrypto as Crypto,
        );
        return { keys, cert };
    }

    /** A certificate for the public key, issued by the given CA. */
    async function issue(
        subject: string,
        publicKey: CryptoKey,
        ca: { keys: CryptoKeyPair; cert: x509.X509Certificate },
    ): Promise<x509.X509Certificate> {
        return x509.X509CertificateGenerator.create(
            {
                serialNumber: "02",
                subject,
                issuer: ca.cert.subject,
                ...validity,
                signingAlgorithm: { ...ecdsa, hash: "SHA-256" },
                publicKey,
                signingKey: ca.keys.privateKey,
            },
            webcrypto as Crypto,
        );
    }

    const pem = (...certs: x509.X509Certificate[]) =>
        certs.map((cert) => cert.toString("pem")).join("\n");

    it("stores a chain in which each certificate issued the one before it", async () => {
        const service = updateServiceFor(keyChain({}));
        const root = await rootCa();
        const intermediateKeys = await newKeys();
        const intermediate = {
            keys: intermediateKeys,
            cert: await issue(
                "CN=Intermediate CA",
                intermediateKeys.publicKey,
                root,
            ),
        };
        const leaf = await issue(
            "CN=Verifier",
            await activePublicKey(),
            intermediate,
        );

        await service.update("tenant", "key", {
            activeCertificate: pem(leaf, intermediate.cert, root.cert),
        });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { activeCertificate: pem(leaf, intermediate.cert, root.cert) },
        );
    });

    it("refuses a chain whose CA did not sign the certificate before it", async () => {
        const service = updateServiceFor(keyChain({}));
        const root = await rootCa();
        const intermediateKeys = await newKeys();
        const intermediate = {
            keys: intermediateKeys,
            cert: await issue(
                "CN=Intermediate CA",
                intermediateKeys.publicKey,
                root,
            ),
        };
        const leaf = await issue(
            "CN=Verifier",
            await activePublicKey(),
            intermediate,
        );
        // Same name as the root, other key.
        const impostor = await rootCa();

        await expect(
            service.update("tenant", "key", {
                activeCertificate: pem(leaf, intermediate.cert, impostor.cert),
            }),
        ).rejects.toThrow(/certificate 3 did not issue certificate 2/);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });

    it("refuses a chain whose second certificate names another subject than the leaf's issuer", async () => {
        const service = updateServiceFor(keyChain({}));
        const ca = await rootCa("CN=External CA");
        const leaf = await issue("CN=Verifier", await activePublicKey(), ca);
        // The CA's key under another name: the signature checks out, the names do not.
        const other = {
            cert: await x509.X509CertificateGenerator.createSelfSigned(
                {
                    serialNumber: "03",
                    name: "CN=Other CA",
                    ...validity,
                    signingAlgorithm: { ...ecdsa, hash: "SHA-256" },
                    keys: ca.keys,
                },
                webcrypto as Crypto,
            ),
        };

        await expect(
            service.update("tenant", "key", {
                activeCertificate: pem(leaf, other.cert),
            }),
        ).rejects.toThrow(/certificate 2 did not issue certificate 1/);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });

    it("stores only the certificate blocks of the chain", async () => {
        const service = updateServiceFor(keyChain({}));
        const ca = await rootCa();
        const leaf = await issue("CN=Verifier", await activePublicKey(), ca);
        const pasted = `Bag Attributes\n    friendlyName: verifier\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n${pem(leaf)}\nsubject=CN=Root CA\n${pem(ca.cert)}`;

        await service.update("tenant", "key", { activeCertificate: pasted });

        expect(service.keyChainRepository.update).toHaveBeenCalledWith(
            { tenantId: "tenant", id: "key" },
            { activeCertificate: pem(leaf, ca.cert) },
        );
    });

    it.each([
        ["PEM", /at least one PEM certificate/],
        [
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
            /certificate 1 is not a valid certificate/,
        ],
    ])("refuses %j as a certificate", async (activeCertificate, reason) => {
        const service = updateServiceFor(keyChain({}));

        await expect(
            service.update("tenant", "key", { activeCertificate }),
        ).rejects.toThrow(reason);
        expect(service.keyChainRepository.update).not.toHaveBeenCalled();
    });
});

describe("KeyChainService.findByUsageType", () => {
    /** A repository whose `findOne` returns the first row matching `where`. */
    function serviceWith(rows: KeyChainEntity[]) {
        const service = Object.create(KeyChainService.prototype) as any;
        service.keyChainRepository = {
            findOne: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) =>
                    Object.entries(where).every(
                        ([key, value]) =>
                            row[key as keyof KeyChainEntity] === value,
                    ),
                ) ?? null,
        };
        return service as KeyChainService;
    }

    const encryptionKeyChain = keyChain({
        id: "system",
        usageType: KeyUsageType.Encrypt,
        usage: KeyUsage.Encrypt,
    });
    const signingKeyChain = (id: string) =>
        keyChain({
            id,
            usageType: KeyUsageType.Encrypt,
            usage: KeyUsage.Sign,
        });

    it("prefers the encryption key chain over signing key chains with usage type encrypt", async () => {
        const service = serviceWith([
            signingKeyChain("user"),
            encryptionKeyChain,
        ]);

        const found = await service.findByUsageType(
            "tenant",
            KeyUsageType.Encrypt,
        );

        expect(found.id).toBe("system");
    });

    it("still finds an encryption key chain that an import turned into a signing key chain", async () => {
        const service = serviceWith([signingKeyChain("converted")]);

        const found = await service.findByUsageType(
            "tenant",
            KeyUsageType.Encrypt,
        );

        expect(found.id).toBe("converted");
    });
});

describe("KeyChainService default access key chain", () => {
    const issuedCertificate = async () => {
        const algorithm = {
            name: "ECDSA",
            namedCurve: "P-256",
            hash: "SHA-256",
        };
        const keys = (await webcrypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "01",
                subject: "CN=Relying party",
                issuer: "CN=Registrar CA",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: keys.publicKey,
                signingKey: keys.privateKey,
            },
            webcrypto as Crypto,
        );
        return cert.toString("pem");
    };

    it("uses the registrar-issued access key chain when none is named, not the first row", async () => {
        const selfSigned = keyChain({
            id: "self-signed",
            usageType: KeyUsageType.Access,
            createdAt: new Date(0),
            activeCertificate: "unreadable, so ranked as self-signed",
        });
        const enrolled = keyChain({
            id: "enrolled",
            usageType: KeyUsageType.Access,
            createdAt: new Date(1000),
            activeCertificate: await issuedCertificate(),
        });
        const rows = [selfSigned, enrolled];
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault(null);
        service.keyChainRepository = {
            find: vi.fn(async () => rows),
            findOne: vi.fn(
                async ({ where }) =>
                    rows.find((row) => row.id === where.id) ?? rows[0],
            ),
        };

        const found = await (service as KeyChainService).findByUsageType(
            "tenant",
            KeyUsageType.Access,
        );

        expect(found.id).toBe("enrolled");
        expect(service.keyChainRepository.find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: "tenant", usageType: KeyUsageType.Access },
            }),
        );
    });

    it("throws not found without an access key chain", async () => {
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault(null);
        service.keyChainRepository = { find: vi.fn(async () => []) };

        await expect(
            (service as KeyChainService).findByUsageType(
                "tenant",
                KeyUsageType.Access,
            ),
        ).rejects.toThrow("No key chain found with usage type 'access'");
    });

    /** Access key chains of the tenant, found by id and usage type. */
    const accessRows = (rows: ReturnType<typeof keyChain>[]) => ({
        find: vi.fn(async () => rows),
        findOne: vi.fn(
            async ({ where }) =>
                rows.find(
                    (row) =>
                        row.id === where.id &&
                        (where.usageType === undefined ||
                            row.usageType === where.usageType),
                ) ?? null,
        ),
    });

    it("uses the tenant's default access key chain over the ranking", async () => {
        const enrolled = keyChain({
            id: "enrolled",
            usageType: KeyUsageType.Access,
            activeCertificate: await issuedCertificate(),
        });
        const chosen = keyChain({
            id: "chosen",
            usageType: KeyUsageType.Access,
            activeCertificate: "self-signed",
        });
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault("chosen");
        service.keyChainRepository = accessRows([enrolled, chosen]);

        const found = await (service as KeyChainService).findByUsageType(
            "tenant",
            KeyUsageType.Access,
        );

        expect(found.id).toBe("chosen");
        expect(service.keyChainRepository.find).not.toHaveBeenCalled();
    });

    it("keeps a named key chain over the tenant's default", async () => {
        const named = keyChain({ id: "named", usageType: KeyUsageType.Access });
        const chosen = keyChain({
            id: "chosen",
            usageType: KeyUsageType.Access,
        });
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault("chosen");
        service.keyChainRepository = accessRows([named, chosen]);

        const found = await (service as KeyChainService).findByUsageType(
            "tenant",
            KeyUsageType.Access,
            "named",
        );

        expect(found.id).toBe("named");
        expect(service.tenantRepository.findOne).not.toHaveBeenCalled();
    });

    it("fails when the tenant's default names a key chain of another usage type", async () => {
        const chosen = keyChain({
            id: "chosen",
            usageType: KeyUsageType.Attestation,
        });
        const other = keyChain({ id: "other", usageType: KeyUsageType.Access });
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault("chosen");
        service.keyChainRepository = accessRows([chosen, other]);
        service.logger = { warn: vi.fn() };

        await expect(
            (service as KeyChainService).findByUsageType(
                "tenant",
                KeyUsageType.Access,
            ),
        ).rejects.toThrow(
            "The tenant's default access key chain is not available.",
        );
    });

    it("fails instead of falling back when the tenant's default access key chain is gone", async () => {
        const other = keyChain({ id: "other", usageType: KeyUsageType.Access });
        const service = Object.create(KeyChainService.prototype) as any;
        service.tenantRepository = tenantWithDefault("gone");
        service.keyChainRepository = accessRows([other]);
        service.logger = { warn: vi.fn() };

        await expect(
            (service as KeyChainService).findByUsageType(
                "tenant",
                KeyUsageType.Access,
            ),
        ).rejects.toThrow(
            "The tenant's default access key chain is not available.",
        );
        expect(service.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('default access key chain "gone"'),
        );
    });

    it("reports the setting and the key chain it resolves to", async () => {
        const enrolled = keyChain({
            id: "enrolled",
            usageType: KeyUsageType.Access,
            activeCertificate: await issuedCertificate(),
        });
        const chosen = keyChain({
            id: "chosen",
            usageType: KeyUsageType.Access,
        });
        const service = Object.create(KeyChainService.prototype) as any;
        service.keyChainRepository = accessRows([enrolled, chosen]);

        service.tenantRepository = tenantWithDefault(null);
        await expect(
            (service as KeyChainService).getDefaultAccessKeyChain("tenant"),
        ).resolves.toEqual({ keyChainId: "enrolled" });

        service.tenantRepository = tenantWithDefault("chosen");
        await expect(
            (service as KeyChainService).getDefaultAccessKeyChain("tenant"),
        ).resolves.toEqual({
            defaultAccessKeyChainId: "chosen",
            keyChainId: "chosen",
        });

        service.tenantRepository = tenantWithDefault("gone");
        await expect(
            (service as KeyChainService).getDefaultAccessKeyChain("tenant"),
        ).resolves.toEqual({ defaultAccessKeyChainId: "gone" });
    });

    it("accepts only access key chains of the tenant as the default", async () => {
        const service = Object.create(KeyChainService.prototype) as any;
        service.keyChainRepository = accessRows([
            keyChain({ id: "access", usageType: KeyUsageType.Access }),
            keyChain({
                id: "attestation",
                usageType: KeyUsageType.Attestation,
            }),
        ]);

        await expect(
            (service as KeyChainService).assertAccessKeyChain(
                "tenant",
                "access",
            ),
        ).resolves.toBeUndefined();
        await expect(
            (service as KeyChainService).assertAccessKeyChain(
                "tenant",
                "attestation",
            ),
        ).rejects.toThrow('has usage type "attestation"');
        await expect(
            (service as KeyChainService).assertAccessKeyChain("tenant", "gone"),
        ).rejects.toThrow('Key chain "gone" does not exist in this tenant.');
    });
});

describe("KeyChainController authorization", () => {
    const guard = new RolesGuard(new Reflector());
    const context = (handler: (...args: never[]) => unknown, roles: Role[]) =>
        ({
            getHandler: () => handler,
            getClass: () => KeyChainController,
            switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
        }) as unknown as ExecutionContext;

    // Endpoints returning private keys or KMS provider credentials.
    const privileged = {
        export: KeyChainController.prototype.export,
        getTenantKmsConfig: KeyChainController.prototype.getTenantKmsConfig,
        updateTenantKmsConfig:
            KeyChainController.prototype.updateTenantKmsConfig,
        deleteTenantKmsConfig:
            KeyChainController.prototype.deleteTenantKmsConfig,
    };

    describe.each(Object.entries(privileged))("%s", (_, handler) => {
        it.each([
            [Role.Issuances],
            [Role.Presentations],
            [Role.Issuances, Role.Presentations, Role.Clients],
        ])(
            "rejects callers with only key chain management roles (%s)",
            (...roles) => {
                expect(guard.canActivate(context(handler, roles))).toBe(false);
            },
        );

        it.each([Role.TenantAdmin, Role.Tenants])(
            "allows callers with %s",
            (role) => {
                expect(guard.canActivate(context(handler, [role]))).toBe(true);
            },
        );
    });

    it.each([
        KeyChainController.prototype.getById,
        KeyChainController.prototype.createCsr,
        KeyChainController.prototype.getProviders,
        KeyChainController.prototype.getProvidersHealth,
    ])("keeps the management roles for %o", (handler) => {
        expect(guard.canActivate(context(handler, [Role.Issuances]))).toBe(
            true,
        );
    });

    it("requires a tenant context", () => {
        const service = { export: vi.fn() };
        const kms = {
            getTenantConfig: vi.fn(),
            saveTenantConfig: vi.fn(),
            deleteTenantConfig: vi.fn(),
        };
        const controller = new KeyChainController(
            service as unknown as KeyChainService,
            kms as never,
        );
        const token = { roles: [Role.Tenants] } as TokenPayload;

        expect(() => controller.export(token, "key")).toThrow(
            ForbiddenException,
        );
        expect(() => controller.getTenantKmsConfig(token)).toThrow(
            ForbiddenException,
        );
        expect(() =>
            controller.updateTenantKmsConfig(token, { providers: [] } as never),
        ).toThrow(ForbiddenException);
        expect(() => controller.deleteTenantKmsConfig(token)).toThrow(
            ForbiddenException,
        );
        expect(service.export).not.toHaveBeenCalled();
        expect(kms.saveTenantConfig).not.toHaveBeenCalled();
        expect(kms.deleteTenantConfig).not.toHaveBeenCalled();
    });
});

describe("KeyChainService.deleteUnreferenced", () => {
    function serviceWith(found: KeyChainReference[], entity?: KeyChainEntity) {
        const service = Object.create(KeyChainService.prototype) as any;
        service.keyChainRepository = {
            findOne: vi.fn().mockResolvedValue(entity ?? keyChain({})),
            delete: vi.fn().mockResolvedValue(undefined),
        };
        const deleteKey = vi.fn();
        service.kmsRegistry = {
            resolve: () => ({ capabilities: { canDelete: true }, deleteKey }),
        };
        service.logger = { log: vi.fn(), warn: vi.fn() };
        const references = new KeyChainReferences();
        const findReferences = vi.fn(async () => found);
        references.register({
            kind: "CredentialConfig",
            findReferences,
            namesKeyChain: () => false,
        });
        service.references = references;
        return {
            service: service as KeyChainService,
            repository: service.keyChainRepository,
            deleteKey,
            findReferences,
        };
    }

    it("deletes a key chain that no configuration names", async () => {
        const { service, repository, deleteKey, findReferences } = serviceWith(
            [],
        );

        await service.deleteUnreferenced("tenant", "key");

        expect(findReferences).toHaveBeenCalledWith({
            tenantId: "tenant",
            id: "key",
        });
        expect(deleteKey).toHaveBeenCalled();
        expect(repository.delete).toHaveBeenCalledWith({
            tenantId: "tenant",
            id: "key",
        });
    });

    it("keeps a named key chain and its key material", async () => {
        const found: KeyChainReference[] = [
            { kind: "CredentialConfig", id: "pid", description: "PID" },
        ];
        const { service, repository, deleteKey } = serviceWith(found);

        const error = await service
            .deleteUnreferenced("tenant", "key")
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(KeyChainInUseError);
        expect((error as KeyChainInUseError).references).toEqual(found);
        expect(deleteKey).not.toHaveBeenCalled();
        expect(repository.delete).not.toHaveBeenCalled();
    });

    it("answers not found before looking for references", async () => {
        const { service, repository, findReferences } = serviceWith([]);
        repository.findOne.mockResolvedValue(null);

        await expect(
            service.deleteUnreferenced("tenant", "missing"),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(findReferences).not.toHaveBeenCalled();
    });
});
