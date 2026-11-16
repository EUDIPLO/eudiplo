import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    type CallbackContext,
    clientAuthenticationNone,
} from "@openid4vc/oauth2";
import {
    calculateJwkThumbprint,
    type Jwk,
    type SignJwsCallback,
    type VerifyJwsCallback,
} from "@owf/jose";
import {
    CompactEncrypt,
    compactVerify,
    exportJWK,
    importJWK,
    importX509,
    type JWK,
} from "jose";
import { PinoLogger } from "nestjs-pino";
import { KeyChainService } from "./key/key-chain.service.js";

/**
 * Service for cryptographic operations, including key management and certificate handling.
 */
@Injectable()
export class CryptoService {
    /**
     * Folder where the keys are stored.
     */
    folder!: string;

    /**
     * Clock tolerance in seconds for JWT verification.
     * Configured via CRYPTO_TOLERANCE env var, defaults to 5s.
     */
    private readonly clockTolerance: number;

    /**
     * Constructor for CryptoService.
     * @param keyService
     * @param configService
     */
    constructor(
        public readonly keyChainService: KeyChainService,
        private readonly configService: ConfigService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext("CryptoService");
        this.clockTolerance =
            this.configService.getOrThrow<number>("CRYPTO_TOLERANCE");
    }

    /**
     * Get the callback context for the key service.
     * @param tenantId
     * @param sessionId Optional session ID for log correlation
     * @param keyChainIds Key chain to sign with per signer `kid`, for signers
     * whose `kid` is the published key id rather than the key chain ID.
     * @returns
     */
    getCallbackContext(
        tenantId: string,
        sessionId?: string,
        keyChainIds?: Readonly<Record<string, string>>,
    ): Omit<CallbackContext, "decryptJwe"> {
        const logContext = { tenantId, ...(sessionId && { sessionId }) };
        return {
            hash: (data, alg) =>
                createHash(alg.replace("-", "").toLowerCase())
                    .update(
                        typeof data === "string" ? data : new Uint8Array(data),
                    )
                    .digest(),
            generateRandom: (bytes) => randomBytes(bytes),
            clientAuthentication: clientAuthenticationNone({
                clientId: "some-random",
            }),
            encryptJwe: async (encryptor, payload) => {
                const josePublicKey = await importJWK(
                    encryptor.publicJwk as JWK,
                    encryptor.alg,
                );
                const jwe = await new CompactEncrypt(
                    new TextEncoder().encode(payload),
                )
                    .setProtectedHeader({
                        alg: encryptor.alg,
                        enc: encryptor.enc,
                        // OpenID4VCI 1.0 Section 10: the JWE names the
                        // wallet's key when that key has a kid.
                        ...(typeof encryptor.publicJwk.kid === "string" && {
                            kid: encryptor.publicJwk.kid,
                        }),
                    })
                    .encrypt(josePublicKey);
                return { jwe, encryptionJwk: encryptor.publicJwk };
            },
            signJws: this.getSignJwsCallback(tenantId, keyChainIds),
            verifyJws: this.getVerifyJwsCallback(logContext),
        };
    }

    /**
     * Clock skew the `@openid4vc` libraries allow for `exp`, `nbf` and `iat`
     * (`CRYPTO_TOLERANCE`). They check the claims; the callbacks below only
     * check signatures.
     */
    get allowedSkewInSeconds(): number {
        return this.clockTolerance;
    }

    /**
     * Verifies a JWS signature with the key of a `jwk` or `x5c` signer. The
     * libraries check the claims, and whether an `x5c` chain is trusted is
     * checked by the callers that accept one.
     */
    private getVerifyJwsCallback(
        logContext: Record<string, string>,
    ): VerifyJwsCallback {
        return async (signer, { signingInput, signature }) => {
            if (signer.method !== "jwk" && signer.method !== "x5c") {
                throw new Error(
                    `Signer method '${signer.method}' not supported`,
                );
            }
            if (signer.method === "x5c" && signer.x5c.length === 0) {
                return { verified: false };
            }
            try {
                const publicKey =
                    signer.method === "jwk"
                        ? await importJWK(signer.publicJwk as JWK, signer.alg)
                        : await importX509(
                              `-----BEGIN CERTIFICATE-----\n${signer.x5c[0]}\n-----END CERTIFICATE-----`,
                              signer.alg,
                          );
                await compactVerify(`${signingInput}.${signature}`, publicKey, {
                    algorithms: [signer.alg],
                });
                const signerJwk =
                    signer.method === "jwk"
                        ? signer.publicJwk
                        : ({
                              ...(await exportJWK(publicKey)),
                              alg: signer.alg,
                          } as Jwk);
                return { verified: true, signerJwk };
            } catch (e) {
                this.logger.warn(
                    { ...logContext, err: e },
                    `JWS verification failed (${signer.method})`,
                );
                return { verified: false };
            }
        };
    }

    /**
     * Signs with a key chain of the tenant. The signer's `kid` names the key
     * chain, or maps to it through `keyChainIds`. A `jwk` signer must carry
     * the key chain's active public key.
     */
    getSignJwsCallback(
        tenantId: string,
        keyChainIds?: Readonly<Record<string, string>>,
    ): SignJwsCallback {
        return async (signer, { signingInputBytes }) => {
            if (signer.method !== "jwk" && signer.method !== "custom") {
                throw new Error("Signer method not supported");
            }
            if (!signer.kid) {
                throw new Error("Signer has no key id");
            }
            const keyChainId = keyChainIds?.[signer.kid] ?? signer.kid;
            const publicJwk = (await this.keyChainService.getPublicKey(
                "jwk",
                tenantId,
                keyChainId,
            )) as Jwk;

            if (signer.method === "jwk") {
                const hashCallback = this.getCallbackContext(tenantId).hash;
                const [signerThumbprint, keyThumbprint] = await Promise.all(
                    [signer.publicJwk, publicJwk].map((jwk) =>
                        calculateJwkThumbprint({
                            jwk,
                            hashAlgorithm: "sha-256",
                            hashCallback,
                        }),
                    ),
                );
                if (signerThumbprint !== keyThumbprint) {
                    throw new Error(
                        `No private key available for public jwk \n${JSON.stringify(signer.publicJwk, null, 2)}`,
                    );
                }
            }

            // The header is signed as the library built it, so its alg must
            // be the key's.
            const keyAlg = await this.keyChainService.getSigningAlg(
                tenantId,
                keyChainId,
            );
            if (signer.alg !== keyAlg) {
                throw new Error(
                    `Signer alg '${signer.alg}' does not match the key's alg '${keyAlg}'`,
                );
            }

            const signature = await this.keyChainService.signBytes(
                signingInputBytes,
                tenantId,
                keyChainId,
            );
            return {
                signature: Buffer.from(signature).toString("base64url"),
                signerJwk:
                    signer.method === "jwk" ? signer.publicJwk : publicJwk,
            };
        };
    }
}
