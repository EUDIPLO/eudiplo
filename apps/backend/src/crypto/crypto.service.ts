import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    type CallbackContext,
    calculateJwkThumbprint,
    clientAuthenticationNone,
    HashAlgorithm,
    type Jwk,
    SignJwtCallback,
} from "@openid4vc/oauth2";
import {
    CompactEncrypt,
    exportJWK,
    importJWK,
    importX509,
    type JWK,
    jwtVerify,
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
     * @returns
     */
    getCallbackContext(
        tenantId: string,
        sessionId?: string,
    ): Omit<CallbackContext, "decryptJwe"> {
        const logContext = { tenantId, ...(sessionId && { sessionId }) };
        return {
            hash: (data, alg) =>
                createHash(alg.replace("-", "").toLowerCase())
                    .update(data)
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
            signJwt: this.getSignJwtCallback(tenantId),
            verifyJwt: async (signer, { compact }) => {
                if (signer.method === "jwk") {
                    const josePublicKey = await importJWK(
                        signer.publicJwk as JWK,
                        signer.alg,
                    );
                    try {
                        await jwtVerify(compact, josePublicKey, {
                            clockTolerance: this.clockTolerance,
                        });
                        return { verified: true, signerJwk: signer.publicJwk };
                    } catch (e) {
                        this.logger.warn(
                            { ...logContext, err: e },
                            "JWT verification failed (jwk)",
                        );
                        return { verified: false };
                    }
                } else if (signer.method === "x5c") {
                    // x5c contains an array of base64-encoded X.509 certificates
                    // The first certificate (leaf) contains the public key
                    if (!signer.x5c || signer.x5c.length === 0) {
                        return { verified: false };
                    }
                    try {
                        const leafCertPem = `-----BEGIN CERTIFICATE-----\n${signer.x5c[0]}\n-----END CERTIFICATE-----`;
                        const josePublicKey = await importX509(
                            leafCertPem,
                            signer.alg,
                        );
                        await jwtVerify(compact, josePublicKey, {
                            clockTolerance: this.clockTolerance,
                        });
                        // Extract the public JWK from the certificate for the return value
                        const signerJwk = await exportJWK(josePublicKey);
                        signerJwk.alg = signer.alg;
                        return { verified: true, signerJwk: signerJwk as Jwk };
                    } catch (e) {
                        this.logger.warn(
                            { ...logContext, err: e },
                            "JWT verification failed (x5c)",
                        );
                        return { verified: false };
                    }
                }
                throw new Error(
                    `Signer method '${signer.method}' not supported`,
                );
            },
        };
    }

    // Helper to generate signJwt callback
    getSignJwtCallback(tenantId: string): SignJwtCallback {
        return async (signer, { header, payload }) => {
            if (signer.method !== "jwk") {
                throw new Error("Signer method not supported");
            }
            const hashCallback = this.getCallbackContext(tenantId).hash;
            const jwkThumbprint = await calculateJwkThumbprint({
                jwk: signer.publicJwk,
                hashAlgorithm: HashAlgorithm.Sha256,
                hashCallback,
            });

            const privateThumbprint = await calculateJwkThumbprint({
                jwk: (await this.keyChainService.getPublicKey(
                    "jwk",
                    tenantId,
                    signer.kid!,
                )) as Jwk,
                hashAlgorithm: HashAlgorithm.Sha256,
                hashCallback,
            });

            if (jwkThumbprint !== privateThumbprint) {
                throw new Error(
                    `No private key available for public jwk \n${JSON.stringify(signer.publicJwk, null, 2)}`,
                );
            }

            const jwt = await this.keyChainService.signJWT(
                payload,
                header,
                tenantId,
                signer.kid!,
            );

            return {
                jwt,
                signerJwk: signer.publicJwk,
            };
        };
    }
}
