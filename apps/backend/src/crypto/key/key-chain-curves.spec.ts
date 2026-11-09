import { BadRequestException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { importJWK, jwtVerify } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CertificateBuilderService } from "./cert/certificate-builder.service.js";
import { MDL_DOCUMENT_SIGNER_EKU } from "./domain/signing-certificate-profile.js";
import { KeyChainType } from "./dto/key-chain-create.dto.js";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainService } from "./key-chain.service.js";
import { DbKmsAdapter } from "./kms/adapters/db-kms.adapter.js";
import { KmsCryptoProvider } from "./kms/kms-crypto-provider.js";
import { KeyUsageType } from "./types/key-usage-type.js";

/**
 * Key chains on P-384 and P-521: creation picks the curve, certificates are
 * signed with the matching ecdsa-with-SHAxxx and rotation keeps the curve.
 * The same in-memory service also checks which certificate profile creation
 * and rotation choose for a usage type.
 */
function serviceWith(adapter: DbKmsAdapter) {
    const rows = new Map<string, KeyChainEntity>();
    const service = Object.create(KeyChainService.prototype) as any;
    service.logger = { log: vi.fn() };
    service.configService = {
        getOrThrow: () => "https://issuer.example",
    };
    service.tenantRepository = {
        findOneByOrFail: async () => ({ id: "tenant", name: "Tenant" }),
    };
    service.keyChainRepository = {
        save: async (row: KeyChainEntity) => {
            rows.set(row.id, Object.assign(new KeyChainEntity(), row));
            return row;
        },
        findOne: async ({ where }: { where: { id: string } }) =>
            rows.get(where.id) ?? null,
        update: async ({ id }: { id: string }, changes: object) => {
            Object.assign(rows.get(id)!, changes);
        },
    };
    service.kmsRegistry = { resolve: () => adapter };
    service.certBuilder = new CertificateBuilderService();
    return { service: service as KeyChainService, rows };
}

function certificateCurve(pem: string): { curve: string; hash: string } {
    const cert = new x509.X509Certificate(
        pem.split(/(?<=-----END CERTIFICATE-----)/)[0],
    );
    const hash = (cert.signatureAlgorithm as EcdsaParams).hash;
    return {
        curve: (cert.publicKey.algorithm as EcKeyAlgorithm).namedCurve,
        hash: typeof hash === "string" ? hash : hash.name,
    };
}

describe("KeyChainService curves", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
    });

    it.each([
        ["ES384", "P-384", "SHA-384"],
        ["ES512", "P-521", "SHA-512"],
    ] as const)(
        "creates an internal chain with %s and keeps it on rotation",
        async (alg, crv, hash) => {
            const { service, rows } = serviceWith(new DbKmsAdapter("db"));

            const id = await service.create("tenant", {
                usageType: KeyUsageType.Attestation,
                type: KeyChainType.InternalChain,
                alg,
            });
            const row = rows.get(id)!;
            expect(row.usage).toBe(KeyUsage.Sign);
            expect(row.activeJwk.crv).toBe(crv);
            expect(row.rootJwk?.crv).toBe(crv);
            expect(certificateCurve(row.rootCertificate!)).toEqual({
                curve: crv,
                hash,
            });
            expect(certificateCurve(row.activeCertificate)).toEqual({
                curve: crv,
                hash,
            });
            expect((await service.getById("tenant", id)).alg).toBe(alg);

            // The certificates really are signed with the declared algorithm.
            const root = new x509.X509Certificate(row.rootCertificate!);
            const leaf = new x509.X509Certificate(
                row.activeCertificate.split(
                    /(?<=-----END CERTIFICATE-----)/,
                )[0],
            );
            await expect(
                root.verify({ publicKey: root.publicKey }),
            ).resolves.toBe(true);
            await expect(
                leaf.verify({ publicKey: root.publicKey }),
            ).resolves.toBe(true);

            await service.rotate("tenant", id);

            expect(rows.get(id)!.activeJwk.crv).toBe(crv);
            expect(rows.get(id)!.previousJwk?.crv).toBe(crv);
            expect(
                certificateCurve(rows.get(id)!.activeCertificate).curve,
            ).toBe(crv);
        },
    );

    it("signs JWTs with the alg of the key, not the caller's", async () => {
        const { service, rows } = serviceWith(new DbKmsAdapter("db"));
        const id = await service.create("tenant", {
            usageType: KeyUsageType.Access,
            type: KeyChainType.Standalone,
            alg: "ES384",
        });
        expect(certificateCurve(rows.get(id)!.activeCertificate)).toEqual({
            curve: "P-384",
            hash: "SHA-384",
        });

        const signing = Object.create(
            (await import("./key-chain-signing.service.js"))
                .KeyChainSigningService.prototype,
        ) as any;
        signing.keyChainRepository = {
            findOne: async () => rows.get(id),
        };
        signing.kmsRegistry = { resolve: () => new DbKmsAdapter("db") };

        const jwt: string = await signing.signJWT(
            { sub: "x" },
            { alg: "ES256" },
            "tenant",
            id,
        );
        const header = JSON.parse(
            Buffer.from(jwt.split(".")[0], "base64url").toString(),
        );
        expect(header.alg).toBe("ES384");
        const { d: _d, ...publicJwk } = rows.get(id)!.activeJwk;
        await expect(
            jwtVerify(jwt, await importJWK(publicJwk, "ES384")),
        ).resolves.toMatchObject({ payload: { sub: "x" } });
        await expect(signing.getSigningAlg("tenant", id)).resolves.toBe(
            "ES384",
        );
    });

    it("builds a key reference for the encryption key chain without a signing alg", () => {
        const { service } = serviceWith(new DbKmsAdapter("db"));
        const ref = (service as any).refForStoredKey(new DbKmsAdapter("db"), {
            kty: "EC",
            crv: "P-256",
            alg: "ECDH-ES",
            x: "x",
            y: "y",
            d: "d",
        });
        expect(ref.alg).toBe("ES256");
    });

    it("refuses an algorithm the provider does not offer", async () => {
        const { service } = serviceWith(
            new DbKmsAdapter("db", { algorithms: ["ES256", "ES384"] }),
        );

        await expect(
            service.create("tenant", {
                usageType: KeyUsageType.Attestation,
                type: KeyChainType.Standalone,
                alg: "ES512",
            }),
        ).rejects.toThrow(BadRequestException);
    });

    it("uses the provider's default without an alg", async () => {
        const { service, rows } = serviceWith(
            new DbKmsAdapter("db", { defaultAlgorithm: "ES384" }),
        );

        const id = await service.create("tenant", {
            usageType: KeyUsageType.Attestation,
            type: KeyChainType.Standalone,
        });

        expect(rows.get(id)!.activeJwk.crv).toBe("P-384");
    });
});

describe("KeyChainService certificate profile", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
    });

    function leafEku(pem: string): x509.ExtendedKeyUsageExtension | null {
        return new x509.X509Certificate(
            pem.split(/(?<=-----END CERTIFICATE-----)/)[0],
        ).getExtension(x509.ExtendedKeyUsageExtension);
    }

    it.each([KeyChainType.InternalChain, KeyChainType.Standalone])(
        "gives the %s signing certificate of an attestation key chain the document signer EKU on creation and rotation",
        async (type) => {
            const { service, rows } = serviceWith(new DbKmsAdapter("db"));
            const id = await service.create("tenant", {
                usageType: KeyUsageType.Attestation,
                type,
            });

            const created = leafEku(rows.get(id)!.activeCertificate);
            expect(created?.usages).toEqual([MDL_DOCUMENT_SIGNER_EKU]);
            expect(created?.critical).toBe(true);

            await service.rotate("tenant", id);
            expect(leafEku(rows.get(id)!.activeCertificate)?.usages).toEqual([
                MDL_DOCUMENT_SIGNER_EKU,
            ]);
        },
    );

    it.each([
        KeyUsageType.StatusList,
        KeyUsageType.Access,
        KeyUsageType.TrustList,
    ])(
        "leaves the signing certificate of a %s key chain without EKU on creation and rotation",
        async (usageType) => {
            const { service, rows } = serviceWith(new DbKmsAdapter("db"));
            const id = await service.create("tenant", {
                usageType,
                type: KeyChainType.InternalChain,
            });
            expect(leafEku(rows.get(id)!.activeCertificate)).toBeNull();

            await service.rotate("tenant", id);
            expect(leafEku(rows.get(id)!.activeCertificate)).toBeNull();
        },
    );
});
