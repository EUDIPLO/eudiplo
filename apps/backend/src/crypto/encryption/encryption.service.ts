import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    compactDecrypt,
    decodeProtectedHeader,
    errors,
    exportJWK,
    generateKeyPair,
    importJWK,
    JWK,
    jwtDecrypt,
} from "jose";
import { KeyChainService } from "../key/key-chain.service.js";
import { KeyUsageType } from "../key/types/key-usage-type.js";
import { EncryptedResponseRejectedError } from "./encrypted-response-rejected.error.js";

/**
 * The JWE key management algorithm of every encryption key EUDIPLO publishes
 * (HAIP Section 5): the tenant encryption key and the ephemeral keys of OID4VP
 * requests. Encrypted responses must use it.
 */
export const ENCRYPTION_KEY_MANAGEMENT_ALG = "ECDH-ES";

/**
 * Service for handling encryption and decryption operations.
 */
@Injectable()
export class EncryptionService {
    /**
     * Clock skew in seconds allowed for the `nbf` and `exp` claims of a
     * decrypted JWT (`CRYPTO_TOLERANCE`, as for signed JWTs).
     */
    private readonly clockTolerance: number;

    constructor(
        private readonly keyChainService: KeyChainService,
        configService: ConfigService,
    ) {
        this.clockTolerance =
            configService.getOrThrow<number>("CRYPTO_TOLERANCE");
    }

    /**
     * Initializes the encryption keys for a given tenant.
     * Creates a key chain with an ECDH-ES encryption key.
     * @param tenantId - The ID of the tenant for which to initialize the keys.
     */
    async onTenantInit(tenantId: string): Promise<void> {
        const privateKey = await generateKeyPair(
            ENCRYPTION_KEY_MANAGEMENT_ALG,
            {
                crv: "P-256",
                extractable: true,
            },
        ).then(async (secret) => exportJWK(secret.privateKey));

        privateKey.alg = ENCRYPTION_KEY_MANAGEMENT_ALG;

        await this.keyChainService.createStandalone({
            tenantId,
            description: "Encryption key",
            usageType: KeyUsageType.Encrypt,
            privateKey,
        });
    }

    /**
     * Decrypts a JWE response with a caller-supplied private encryption JWK.
     * Falls back to the tenant-wide encryption key when none is provided.
     * Only what the recipient advertised is accepted: `alg`
     * {@link ENCRYPTION_KEY_MANAGEMENT_ALG}, the `alg` of every published
     * encryption key, and an `enc` of `contentEncryptionAlgorithms`.
     * Time claims in the payload (`nbf`, `exp`) are checked when present,
     * allowing `CRYPTO_TOLERANCE` seconds of clock skew.
     * @throws EncryptedResponseRejectedError when the JWE itself is rejected,
     *   including another `alg` or `enc`; other failures (loading or
     *   importing the key) are thrown unchanged.
     */
    async decryptJweWithPrivateJwk<T>(
        response: string,
        tenantId: string,
        options: {
            privateJwk?: JWK;
            /** The `enc` values the recipient advertised. */
            contentEncryptionAlgorithms: readonly string[];
        },
    ): Promise<T> {
        const jwk =
            options.privateJwk ??
            (await this.getEncryptionPrivateJwk(tenantId));

        const privateEncryptionKey = (await importJWK(
            jwk,
            ENCRYPTION_KEY_MANAGEMENT_ALG,
        )) as CryptoKey;

        // The key is already imported, so a jose error from jwtDecrypt is
        // about the JWE: its header, ciphertext or claims. Anything else is
        // a server-side failure and is thrown unchanged.
        try {
            const res = await jwtDecrypt<T>(response, privateEncryptionKey, {
                clockTolerance: this.clockTolerance,
                keyManagementAlgorithms: [ENCRYPTION_KEY_MANAGEMENT_ALG],
                contentEncryptionAlgorithms: [
                    ...options.contentEncryptionAlgorithms,
                ],
            });
            return res.payload;
        } catch (error) {
            if (error instanceof errors.JOSEError) {
                throw new EncryptedResponseRejectedError(error);
            }
            throw error;
        }
    }

    /**
     * Retrieves the full (private) encryption JWK for a tenant.
     * Used by ISO 18013-7 HPKE decryption — never expose this JWK externally.
     */
    async getEncryptionPrivateJwk(tenantId: string): Promise<JWK> {
        const keyChain = await this.keyChainService.findByUsageType(
            tenantId,
            KeyUsageType.Encrypt,
        );
        return keyChain.activeJwk;
    }

    /**
     * Retrieves the public encryption key for a given tenant.
     * @param tenantId - The ID of the tenant for which to retrieve the public key.
     * @returns The public encryption key as a JWK.
     */
    async getEncryptionPublicKey(tenantId: string): Promise<JWK> {
        const keyChain = await this.keyChainService.findByUsageType(
            tenantId,
            KeyUsageType.Encrypt,
        );

        // Return public key (without private key component 'd')
        const publicKey: JWK = { ...keyChain.activeJwk };
        delete publicKey.d;
        publicKey.kid = keyChain.id;
        publicKey.use = "enc";
        // The key is only used with ECDH-ES. The stored alg is not used: a
        // signing key chain with usage type encrypt stores its signing alg
        // (ES256).
        publicKey.alg = ENCRYPTION_KEY_MANAGEMENT_ALG;

        return publicKey;
    }

    /**
     * Generates a per-request ephemeral ECDH-ES keypair for OID4VP response encryption.
     */
    async generateEphemeralEncryptionKeyPair(): Promise<{
        publicJwk: JWK;
        privateJwk: JWK;
    }> {
        const keyPair = await generateKeyPair(ENCRYPTION_KEY_MANAGEMENT_ALG, {
            crv: "P-256",
            extractable: true,
        });

        const privateJwk = await exportJWK(keyPair.privateKey);
        const publicJwk = await exportJWK(keyPair.publicKey);

        const kid = randomUUID();
        privateJwk.alg = ENCRYPTION_KEY_MANAGEMENT_ALG;
        privateJwk.use = "enc";
        privateJwk.kid = kid;
        publicJwk.alg = ENCRYPTION_KEY_MANAGEMENT_ALG;
        publicJwk.use = "enc";
        publicJwk.kid = kid;

        return { publicJwk, privateJwk };
    }

    /**
     * Decrypts a JWE (JSON Web Encryption) compact token with the tenant
     * encryption key and returns the plaintext parsed as JSON. Use this when
     * the JWE payload is raw JSON (not a nested JWT), such as an encrypted
     * OID4VCI credential or deferred credential request.
     * Only what the issuer advertised is accepted: `alg`
     * {@link ENCRYPTION_KEY_MANAGEMENT_ALG}, the `alg` the tenant encryption
     * key is published with, and an `enc` of `contentEncryptionAlgorithms`.
     * @param jwe - The JWE compact serialization string.
     * @param tenantId - The ID of the tenant.
     * @param options.contentEncryptionAlgorithms - The `enc` values the
     *   issuer advertised.
     * @returns The decrypted payload parsed as a JSON object.
     * @throws errors.JOSEAlgNotAllowed for another `alg` or `enc`, before
     *   anything is decrypted; other jose errors when the JWE does not
     *   decrypt, also JWEInvalid for an `epk` that cannot be imported;
     *   SyntaxError when the plaintext is not JSON. Failures of the tenant
     *   key (lookup, import, no private part) are thrown unchanged.
     */
    async decryptJweToJson<T = Record<string, unknown>>(
        jwe: string,
        tenantId: string,
        options: {
            /** The `enc` values the issuer advertised. */
            contentEncryptionAlgorithms: readonly string[];
        },
    ): Promise<T> {
        const keyChain = await this.keyChainService.findByUsageType(
            tenantId,
            KeyUsageType.Encrypt,
        );

        const privateEncryptionKey = (await importJWK(
            keyChain.activeJwk,
            ENCRYPTION_KEY_MANAGEMENT_ALG,
        )) as CryptoKey;

        let plaintext: Uint8Array;
        try {
            ({ plaintext } = await compactDecrypt(jwe, privateEncryptionKey, {
                keyManagementAlgorithms: [ENCRYPTION_KEY_MANAGEMENT_ALG],
                contentEncryptionAlgorithms: [
                    ...options.contentEncryptionAlgorithms,
                ],
            }));
        } catch (error) {
            // jose passes some failures on as a plain TypeError: from
            // importing the wallet's `epk` (for example one without `crv`),
            // which is the JWE's fault, or from the tenant key (for example
            // one without its private part), which is the issuer's.
            if (
                error instanceof errors.JOSEError ||
                (await importsEphemeralKey(jwe))
            ) {
                throw error;
            }
            throw new errors.JWEInvalid(
                'The JWE "epk" (Ephemeral Public Key) cannot be imported',
                { cause: error },
            );
        }
        return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    }
}

/** True when the `epk` in the JWE's protected header imports as an ECDH key. */
async function importsEphemeralKey(jwe: string): Promise<boolean> {
    try {
        const { epk } = decodeProtectedHeader(jwe);
        await importJWK(epk as JWK, ENCRYPTION_KEY_MANAGEMENT_ALG);
        return true;
    } catch {
        return false;
    }
}
