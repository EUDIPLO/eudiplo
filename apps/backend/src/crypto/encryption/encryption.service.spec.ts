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

/** A JWE for `publicJwk` whose payload has the given time claims. */
async function encryptedResponse(
    publicJwk: JWK,
    claims: { nbf?: number; exp?: number } = {},
): Promise<string> {
    const jwt = new EncryptJWT({
        vp_token: { query: ["vp"] },
    }).setProtectedHeader({
        alg: "ECDH-ES",
        enc: "A256GCM",
        kid: publicJwk.kid,
    });
    if (claims.nbf !== undefined) jwt.setNotBefore(claims.nbf);
    if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
    return jwt.encrypt(publicJwk);
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
        return service.decryptJweWithPrivateJwk(jwe, "tenant", privateJwk);
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
            "an unsupported enc",
            () =>
                `${base64url.encode(JSON.stringify({ alg: "ECDH-ES", enc: "XYZ" }))}.` +
                ".iv.ciphertext.tag",
            errors.JOSENotSupported,
        ],
    ])("rejects %s", async (_case, jwe, cause) => {
        const service = serviceWithTolerance(5);
        const { privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();

        const error = await service
            .decryptJweWithPrivateJwk(jwe(), "tenant", privateJwk)
            .catch((error) => error);

        expect(error).toBeInstanceOf(EncryptedResponseRejectedError);
        expect(error.cause).toBeInstanceOf(cause);
        expect(error.message).toBe(error.cause.message);
    });

    it("rejects a JWE encrypted to another key", async () => {
        const service = serviceWithTolerance(5);
        const { privateJwk } =
            await service.generateEphemeralEncryptionKeyPair();
        const other = await service.generateEphemeralEncryptionKeyPair();
        const jwe = await encryptedResponse(other.publicJwk);

        const error = await service
            .decryptJweWithPrivateJwk(jwe, "tenant", privateJwk)
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
            service.decryptJweWithPrivateJwk("not-a-jwe", "tenant"),
        ).rejects.toBe(lookupFailure);
    });
});
