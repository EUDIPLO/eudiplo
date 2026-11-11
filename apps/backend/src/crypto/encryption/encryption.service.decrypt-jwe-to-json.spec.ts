import { ConfigService } from "@nestjs/config";
import { CompactEncrypt, errors, JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { KeyChainService } from "../key/key-chain.service.js";
import { EncryptionService } from "./encryption.service.js";

describe("EncryptionService.decryptJweToJson", () => {
    /** The `enc` values of `credential_request_encryption`. */
    const ADVERTISED_ENC = ["A128GCM", "A256GCM"];

    /** A service whose tenant encryption key is a fresh ECDH-ES key. */
    async function serviceWithTenantKey() {
        const keyChain = { activeJwk: undefined as JWK | undefined };
        const service = new EncryptionService(
            {
                findByUsageType: vi.fn().mockResolvedValue(keyChain),
            } as unknown as KeyChainService,
            { getOrThrow: () => 5 } as unknown as ConfigService,
        );
        const keys = await service.generateEphemeralEncryptionKeyPair();
        keyChain.activeJwk = keys.privateJwk;
        return { service, publicJwk: keys.publicJwk };
    }

    /**
     * An encrypted credential request to `publicJwk`, with `ECDH-ES` and
     * `A128GCM` unless `header` says otherwise.
     */
    function encryptedRequest(
        publicJwk: JWK,
        header: { alg?: string; enc?: string } = {},
        plaintext = JSON.stringify({ credential_configuration_id: "pid" }),
    ): Promise<string> {
        const alg = header.alg ?? "ECDH-ES";
        return (
            new CompactEncrypt(new TextEncoder().encode(plaintext))
                .setProtectedHeader({
                    alg,
                    enc: header.enc ?? "A128GCM",
                    kid: publicJwk.kid,
                })
                // jose refuses a JWK whose alg differs from the header; a wallet
                // ignoring the advertised alg uses the key material all the same.
                .encrypt({ ...publicJwk, alg })
        );
    }

    it.each(ADVERTISED_ENC)("accepts the advertised enc %s", async (enc) => {
        const { service, publicJwk } = await serviceWithTenantKey();
        const jwe = await encryptedRequest(publicJwk, { enc });

        await expect(
            service.decryptJweToJson(jwe, "tenant", {
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).resolves.toEqual({ credential_configuration_id: "pid" });
    });

    // The advertised key has alg ECDH-ES (HAIP Section 5: no key wrapping),
    // the enc values are those of credential_request_encryption.
    it.each<[string, { alg?: string; enc?: string }, string, string[]?]>([
        ["alg ECDH-ES+A128KW", { alg: "ECDH-ES+A128KW" }, '"alg"'],
        ["alg ECDH-ES+A256KW", { alg: "ECDH-ES+A256KW" }, '"alg"'],
        ["enc A128CBC-HS256", { enc: "A128CBC-HS256" }, '"enc"'],
        ["enc A256GCM", { enc: "A256GCM" }, '"enc"', ["A128GCM"]],
        ["enc A128GCM", { enc: "A128GCM" }, '"enc"', []],
    ])(
        "rejects a JWE with %s, which the issuer did not advertise",
        async (_case, header, parameter, advertised = ADVERTISED_ENC) => {
            const { service, publicJwk } = await serviceWithTenantKey();
            const jwe = await encryptedRequest(publicJwk, header);

            const error = await service
                .decryptJweToJson(jwe, "tenant", {
                    contentEncryptionAlgorithms: advertised,
                })
                .catch((error) => error);

            expect(error).toBeInstanceOf(errors.JOSEAlgNotAllowed);
            expect(error.message).toMatch(new RegExp(`^${parameter}`));
        },
    );

    it("rejects a JWE encrypted to another key", async () => {
        const { service } = await serviceWithTenantKey();
        const other = await serviceWithTenantKey();
        const jwe = await encryptedRequest(other.publicJwk);

        await expect(
            service.decryptJweToJson(jwe, "tenant", {
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).rejects.toBeInstanceOf(errors.JWEDecryptionFailed);
    });

    // The deferred credential endpoint tells these apart from a JWE that
    // does not decrypt.
    it("throws a SyntaxError for plaintext that is not JSON", async () => {
        const { service, publicJwk } = await serviceWithTenantKey();
        const jwe = await encryptedRequest(publicJwk, {}, "not json");

        await expect(
            service.decryptJweToJson(jwe, "tenant", {
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).rejects.toBeInstanceOf(SyntaxError);
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
            service.decryptJweToJson("not-a-jwe", "tenant", {
                contentEncryptionAlgorithms: ADVERTISED_ENC,
            }),
        ).rejects.toBe(lookupFailure);
    });
});
