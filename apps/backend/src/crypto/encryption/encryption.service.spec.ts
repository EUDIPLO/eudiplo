import { ConfigService } from "@nestjs/config";
import { base64url, EncryptJWT, errors, JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyChainService } from "../key/key-chain.service.js";
import { EncryptedResponseRejectedError } from "./encrypted-response-rejected.error.js";
import { EncryptionService } from "./encryption.service.js";

const NOW = 1_800_000_000;

function serviceWithTolerance(seconds: number): EncryptionService {
    return new EncryptionService(
        {} as KeyChainService,
        { getOrThrow: () => seconds } as unknown as ConfigService,
    );
}

/** The `enc` values a request advertises (`encrypted_response_enc_values_supported`). */
const ADVERTISED_ENC = ["A128GCM", "A256GCM"];

/**
 * A JWE for `publicJwk` whose payload has the given time claims, with
 * `ECDH-ES` and `A256GCM` unless `header` says otherwise.
 */
async function encryptedResponse(
    publicJwk: JWK,
    claims: { nbf?: number; exp?: number } = {},
    header: { alg?: string; enc?: string } = {},
): Promise<string> {
    const alg = header.alg ?? "ECDH-ES";
    const jwt = new EncryptJWT({
        vp_token: { query: ["vp"] },
    }).setProtectedHeader({
        alg,
        enc: header.enc ?? "A256GCM",
        kid: publicJwk.kid,
    });
    if (claims.nbf !== undefined) jwt.setNotBefore(claims.nbf);
    if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
    // jose refuses a JWK whose alg differs from the header; a wallet
    // ignoring the advertised alg uses the key material all the same.
    return jwt.encrypt({ ...publicJwk, alg });
}

describe("EncryptionService.decryptJweWithPrivateJwk", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function decrypt(claims: { nbf?: number; exp?: number }) {
        const service = serviceWithTolerance(5);
        const { publicJwk, privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();
        const jwe = await encryptedResponse(publicJwk, claims);
        return service.decryptJweWithPrivateJwk(jwe, "tenant", {
            privateJwk,
            contentEncryptionAlgorithms: ADVERTISED_ENC,
        });
    }

    it.each([
        ["an nbf ahead within CRYPTO_TOLERANCE", { nbf: NOW + 5 }],
        ["an exp behind within CRYPTO_TOLERANCE", { exp: NOW - 4 }],
    ])("accepts %s", async (_case, claims) => {
        await expect(decrypt(claims)).resolves.toMatchObject({
            vp_token: { query: ["vp"] },
        });
    });

    it.each([
        [
            "an nbf further ahead than CRYPTO_TOLERANCE",
            { nbf: NOW + 6 },
            errors.JWTClaimValidationFailed,
        ],
        [
            "an exp further behind than CRYPTO_TOLERANCE",
            { exp: NOW - 6 },
            errors.JWTExpired,
        ],
    ])("rejects %s", async (_case, claims, cause) => {
        const error = await decrypt(claims).catch((error) => error);

        expect(error).toBeInstanceOf(EncryptedResponseRejectedError);
        expect(error.cause).toBeInstanceOf(cause);
    });

    it.each([
        ["a malformed JWE", () => "not-a-jwe", errors.JWEInvalid],
        [
            "an unknown enc",
            () =>
                `${base64url.encode(JSON.stringify({ alg: "ECDH-ES", enc: "XYZ" }))}.` +
                ".iv.ciphertext.tag",
            errors.JOSEAlgNotAllowed,
        ],
    ])("rejects %s", async (_case, jwe, cause) => {
        const service = serviceWithTolerance(5);
        const { privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();

        const error = await service
            .decryptJweWithPrivateJwk(jwe(), "tenant", {
                privateJwk,
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            })
            .catch((error) => error);

        expect(error).toBeInstanceOf(EncryptedResponseRejectedError);
        expect(error.cause).toBeInstanceOf(cause);
        expect(error.message).toBe(error.cause.message);
    });

    it.each(ADVERTISED_ENC)("accepts the advertised enc %s", async (enc) => {
        const service = serviceWithTolerance(5);
        const { publicJwk, privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();
        const jwe = await encryptedResponse(publicJwk, {}, { enc });

        await expect(
            service.decryptJweWithPrivateJwk(jwe, "tenant", {
                privateJwk,
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).resolves.toMatchObject({ vp_token: { query: ["vp"] } });
    });

    // HAIP Section 5 and the key's alg ECDH-ES: no key wrapping. The enc
    // values are those of encrypted_response_enc_values_supported.
    it.each([
        ["alg ECDH-ES+A128KW", { alg: "ECDH-ES+A128KW" }, '"alg"'],
        ["alg ECDH-ES+A256KW", { alg: "ECDH-ES+A256KW" }, '"alg"'],
        ["enc A128CBC-HS256", { enc: "A128CBC-HS256" }, '"enc"'],
        ["enc A256GCM", { enc: "A256GCM" }, '"enc"', ["A128GCM"]],
    ])(
        "rejects a JWE with %s, which the recipient did not advertise",
        async (_case, header, parameter, advertised = ADVERTISED_ENC) => {
            const service = serviceWithTolerance(5);
            const { publicJwk, privateJwk } =
                await service.generateEphemeralEncryptionKeyPair();
            const jwe = await encryptedResponse(publicJwk, {}, header);

            const error = await service
                .decryptJweWithPrivateJwk(jwe, "tenant", {
                    privateJwk,
                    contentEncryptionAlgorithms: advertised,
                })
                .catch((error) => error);

            expect(error).toBeInstanceOf(EncryptedResponseRejectedError);
            expect(error.cause).toBeInstanceOf(errors.JOSEAlgNotAllowed);
            expect(error.message).toMatch(new RegExp(`^${parameter}`));
        },
    );

    it("rejects a JWE encrypted to another key", async () => {
        const service = serviceWithTolerance(5);
        const { privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();
        const other = await service.generateEphemeralEncryptionKeyPair();
        const jwe = await encryptedResponse(other.publicJwk);

        const error = await service
            .decryptJweWithPrivateJwk(jwe, "tenant", {
                privateJwk,
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            })
            .catch((error) => error);

        expect(error).toBeInstanceOf(EncryptedResponseRejectedError);
        expect(error.cause).toBeInstanceOf(errors.JWEDecryptionFailed);
    });

    it("throws key lookup failures unchanged", async () => {
        const lookupFailure = new Error("database unavailable");
        const service = new EncryptionService(
            {
                findByUsageType: vi.fn().mockRejectedValue(lookupFailure),
            } as unknown as KeyChainService,
            { getOrThrow: () => 5 } as unknown as ConfigService,
        );

        await expect(
            service.decryptJweWithPrivateJwk("not-a-jwe", "tenant", {
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).rejects.toBe(lookupFailure);
    });
});

describe("EncryptionService.getEncryptionPublicKey", () => {
    it.each([
        ["ECDH-ES", "ECDH-ES"],
        [
            "the signing alg of a signing key chain with usage type encrypt",
            "ES256",
        ],
        ["no alg", undefined],
    ])(
        "publishes alg ECDH-ES for a stored key with %s",
        async (_case, storedAlg) => {
            const service = new EncryptionService(
                {
                    findByUsageType: vi.fn().mockResolvedValue({
                        id: "key-chain",
                        activeJwk: {
                            kty: "EC",
                            crv: "P-256",
                            x: "x",
                            y: "y",
                            d: "d",
                            ...(storedAlg && { alg: storedAlg }),
                        },
                    }),
                } as unknown as KeyChainService,
                { getOrThrow: () => 5 } as unknown as ConfigService,
            );

            await expect(
                service.getEncryptionPublicKey("tenant"),
            ).resolves.toEqual({
                kty: "EC",
                crv: "P-256",
                x: "x",
                y: "y",
                kid: "key-chain",
                use: "enc",
                alg: "ECDH-ES",
            });
        },
    );
});
