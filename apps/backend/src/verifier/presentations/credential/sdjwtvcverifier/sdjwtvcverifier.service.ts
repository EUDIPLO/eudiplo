import { BadRequestException, Injectable } from "@nestjs/common";
import { digest } from "@owf/crypto";
import { SDJwtVcInstance, VerificationResult } from "@sd-jwt/sd-jwt-vc";
import { decodeJwt, decodeProtectedHeader, JWK } from "jose";
import { Span } from "nestjs-otel";
import { PinoLogger } from "nestjs-pino";
import { CryptoImplementationService } from "../../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import {
    CREDENTIAL_ISSUER_METADATA_TYPE,
    findFederationProtocolKey,
} from "../../../../trust/domain/federation-protocol-keys.js";
import {
    MalformedStatusReferenceError,
    parseStatusListReference,
} from "../../../../trust/domain/status-list-reference.js";
import { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import {
    type FederationResolution,
    FederationResolutionError,
} from "../../../../trust/ports/federation-resolver.js";
import {
    isStatusListUnavailableError,
    resolveRevocationPolicy,
} from "../../../../trust/revocation-policy.util.js";
import { VerifierOptions } from "../../../../trust/types.js";
import { MatchedTrustedEntity } from "../../../../trust/x509-validation.service.js";
import { ResolverService } from "../../../resolver/resolver.service.js";
import { CredentialChainValidationService } from "../credential-chain-validation.service.js";
import {
    mapChainErrorToFailureType,
    shortVerificationMessage,
    type VerificationFailureType,
} from "../verification-failure.js";

/**
 * SD-JWT-VC verification failure carrying the shared, machine-readable failure
 * type. Extends {@link BadRequestException} so it produces the same structured
 * `{ error, message }` response as the mDOC path when it reaches the exception
 * filter. The verbose reason is kept for logs/audit only.
 */
export class SdJwtVerificationError extends BadRequestException {
    constructor(
        readonly failureType: VerificationFailureType,
        readonly verboseReason?: string,
    ) {
        super({
            error: failureType,
            message: shortVerificationMessage(failureType),
        });
    }
}

@Injectable()
export class SdjwtvcverifierService {
    constructor(
        private readonly resolverService: ResolverService,
        private readonly cryptoService: CryptoImplementationService,
        private readonly chainValidation: CredentialChainValidationService,
        private readonly federationTrust: FederationTrustService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SdjwtvcverifierService.name);
    }

    /**
     * Verifies an SD-JWT-VC credential.
     * Creates a fresh SDJwtVcInstance per verification to safely capture
     * the matched TrustedEntity for status list verification.
     *
     * Transaction data hashes in the KB-JWT are not checked here: an entry
     * may reference several credentials, so they are checked across the
     * whole response (see verifyTransactionDataBinding).
     *
     * @param cred
     * @param options
     * @returns
     */
    @Span("sdjwt.verify")
    async verify(
        cred: string,
        options: VerifierOptions,
    ): Promise<VerificationResult> {
        const revocationPolicy = resolveRevocationPolicy(options);

        // Why the failure lives out here and matchedEntity does not: the
        // best-effort branch may call verifyWithStatusMode twice, and the
        // reason for the first failure must survive into the re-throw below.
        let failure:
            | { failureType: VerificationFailureType; reason?: string }
            | undefined;

        const verifyWithStatusMode = async (
            enableStatusCheck: boolean,
        ): Promise<VerificationResult> => {
            // Closure to capture the matched TrustedEntity during verification
            let matchedEntity: MatchedTrustedEntity | null = null;
            // Or, under OpenID Federation, the resolved issuer entity
            let federationIssuer: FederationResolution | undefined;

            // Create a fresh instance per verification to ensure thread safety
            const sdjwtInstance = new SDJwtVcInstance({
                hasher: digest,
                verifier: async (data: string, signature: string) => {
                    const result = options.federationTrustSource
                        ? await this.verifyFederationCredential(
                              data,
                              signature,
                              options,
                          )
                        : await this.verifyCredential(data, signature, options);
                    matchedEntity = result.matchedEntity;
                    federationIssuer = result.federationIssuer;
                    if (!result.verified) {
                        // The library throws a generic error on failure, so the
                        // structured reason has to be captured here or it is lost.
                        failure = {
                            failureType:
                                result.failureType ?? "verification_error",
                            reason: result.failureReason,
                        };
                    }
                    return result.verified;
                },
                kbVerifier: (data, signature, payload) =>
                    this.verifyKeyBindingJwt(
                        data,
                        signature,
                        payload,
                        options.keyBindingAudience,
                    ),
                ...(enableStatusCheck
                    ? {
                          statusListFetcher: (uri: string) => {
                              // The library fetches the list a status_list
                              // names and reads any idx, a string included.
                              // It calls this once the credential and its key
                              // binding are validated, where Token Status
                              // List Section 8.3 checks the reference.
                              try {
                                  parseStatusListReference(
                                      issuerStatusClaim(cred),
                                  );
                              } catch (error) {
                                  if (
                                      error instanceof
                                      MalformedStatusReferenceError
                                  ) {
                                      failure = {
                                          failureType: "verification_error",
                                          reason: error.message,
                                      };
                                  }
                                  throw error;
                              }
                              return this.chainValidation.fetchStatusListJwt(
                                  uri,
                              );
                          },
                          statusVerifier: (data: string, signature: string) => {
                              // Verify status list JWT with a key of the same
                              // federation entity, or the revocation cert of
                              // the same trusted entity
                              return options.federationTrustSource
                                  ? this.verifyFederationStatusList(
                                        data,
                                        signature,
                                        federationIssuer,
                                    )
                                  : this.verifyStatusList(
                                        data,
                                        signature,
                                        options,
                                        matchedEntity,
                                    );
                          },
                      }
                    : {}),
            });

            return sdjwtInstance.verify(cred, options);
        };

        let result: VerificationResult;
        try {
            if (!revocationPolicy.enabled) {
                result = await verifyWithStatusMode(false);
            } else if (revocationPolicy.failClosed) {
                result = await verifyWithStatusMode(true);
            } else {
                try {
                    result = await verifyWithStatusMode(true);
                } catch (error) {
                    // No malformed reference reads as unavailable today; the
                    // class check keeps a future message from doing so.
                    if (
                        error instanceof MalformedStatusReferenceError ||
                        !isStatusListUnavailableError(error)
                    ) {
                        throw error;
                    }

                    this.logger.warn(
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                        "Status list unavailable in best-effort mode, retrying SD-JWT verification without status check",
                    );
                    result = await verifyWithStatusMode(false);
                }
            }
        } catch (e) {
            // The library throws a generic error when the credential or chain
            // check fails. Re-throw with the captured, machine-readable failure
            // type so callers get the same structured error the mDOC path
            // produces. The verbose reason stays in the log.
            if (failure) {
                if (failure.reason) {
                    this.logger.warn(
                        `SD-JWT-VC verification failed (${failure.failureType}): ${failure.reason}`,
                    );
                }
                throw new SdJwtVerificationError(
                    failure.failureType,
                    failure.reason,
                );
            }
            throw e;
        }

        if (revocationPolicy.enabled) {
            this.checkStatusMechanism(result, revocationPolicy.failClosed);
        }

        return result;
    }

    /**
     * The library only checks a `status.status_list` it can read and passes
     * any other `status` claim unchecked. A credential without a `status`
     * claim cannot be revoked and is accepted. A malformed claim the library
     * passed, such as `status_list: null` or a `status` that is not an
     * object, is rejected like one the status list fetcher refused. A
     * `status` object that names only another mechanism names a status the
     * verifier could not check: strict mode rejects it, best-effort mode logs
     * it and accepts the credential.
     */
    private checkStatusMechanism(
        result: VerificationResult,
        failClosed: boolean,
    ): void {
        const status = (result.payload as Record<string, unknown>).status;
        let reference: ReturnType<typeof parseStatusListReference>;
        try {
            reference = parseStatusListReference(status);
        } catch (error) {
            if (!(error instanceof MalformedStatusReferenceError)) {
                throw error;
            }
            this.logger.warn(
                `SD-JWT-VC verification failed (verification_error): ${error.message}`,
            );
            throw new SdJwtVerificationError(
                "verification_error",
                error.message,
            );
        }
        if (status === undefined || reference) {
            return;
        }

        const reason =
            "The credential's status claim contains no supported status mechanism, so its status could not be checked";
        if (failClosed) {
            throw new BadRequestException(reason);
        }
        this.logger.warn(`${reason}; accepting it in best-effort mode`);
    }

    /**
     * Verifies the SD-JWT-VC credential signature and trust chain.
     * Returns both the verification result and the matched TrustedEntity.
     *
     * data = "<b64url(header)>.<b64url(payload)>"
     * signature = "<b64url(signature)>"
     */
    private async verifyCredential(
        data: string,
        signature: string,
        options: VerifierOptions,
    ): Promise<{
        verified: boolean;
        matchedEntity: MatchedTrustedEntity | null;
        federationIssuer?: FederationResolution;
        failureType?: VerificationFailureType;
        failureReason?: string;
    }> {
        try {
            // 1) Verify SD-JWT signature first (fast fail)
            const [headerB64] = data.split(".");
            const headerJson = Buffer.from(
                headerB64.replaceAll("-", "+").replaceAll("_", "/"),
                "base64",
            ).toString("utf8");
            const header = JSON.parse(headerJson);
            const publicKey =
                await this.resolverService.resolvePublicKey(header);
            const crypto = this.cryptoService.getCryptoFromJwk(publicKey);
            const verifier = await crypto.getVerifier(publicKey);

            const sigOk = await verifier(data, signature).catch((e) => {
                this.logger.debug(
                    `SD-JWT signature invalid: ${e?.message ?? e}`,
                );
                return false;
            });
            if (!sigOk)
                return {
                    verified: false,
                    matchedEntity: null,
                    failureType: "signature_invalid",
                    failureReason: "SD-JWT-VC issuer signature is invalid",
                };

            // 2) Validate certificate chain using shared service
            const x5c: string[] | undefined = header?.x5c;
            const chainResult = await this.chainValidation.validateChain(
                x5c ?? [],
                options.trustListSource,
                {
                    requireX5c: options?.policy.requireX5c,
                    pinnedCertMode: options?.policy.pinnedCertMode ?? "leaf",
                },
            );

            if (!chainResult.verified) {
                if (chainResult.errorDetails) {
                    this.logger.warn(
                        `Certificate chain validation failed: ${chainResult.errorDetails}`,
                    );
                }
                return {
                    verified: false,
                    matchedEntity: null,
                    failureType: mapChainErrorToFailureType(chainResult.error),
                    failureReason:
                        chainResult.errorDetails ?? chainResult.error,
                };
            }

            return { verified: true, matchedEntity: chainResult.matchedEntity };
        } catch (e: any) {
            this.logger.error(`Error in verifier: ${e?.message ?? e}`);
            return {
                verified: false,
                matchedEntity: null,
                failureType: "verification_error",
                failureReason: e?.message ?? String(e),
            };
        }
    }

    /**
     * Verifies an SD-JWT VC issued under OpenID Federation: `iss` names the
     * issuer entity, whose trust chain must lead to a configured trust anchor,
     * and the signature must validate with the key `kid` of its resolved
     * `openid_credential_issuer` metadata. An `x5c` header is not used.
     */
    private async verifyFederationCredential(
        data: string,
        signature: string,
        options: VerifierOptions,
    ): Promise<{
        verified: boolean;
        matchedEntity: null;
        federationIssuer?: FederationResolution;
        failureType?: VerificationFailureType;
        failureReason?: string;
    }> {
        const rejected = (
            failureType: VerificationFailureType,
            failureReason: string,
        ) => ({
            verified: false,
            matchedEntity: null,
            failureType,
            failureReason,
        });
        const parts = decodeJwsParts(data);
        if (!parts) {
            return rejected(
                "verification_error",
                "The SD-JWT VC header or payload cannot be decoded",
            );
        }
        const { header, payload } = parts;
        if (typeof payload.iss !== "string" || !payload.iss) {
            return rejected(
                "verification_error",
                "An SD-JWT VC verified through OpenID Federation needs an iss claim",
            );
        }
        if (typeof header.kid !== "string" || !header.kid) {
            return rejected(
                "verification_error",
                "An SD-JWT VC verified through OpenID Federation needs a kid header",
            );
        }

        let issuerKey: Awaited<
            ReturnType<FederationTrustService["resolveCredentialIssuerKey"]>
        >;
        try {
            issuerKey = await this.federationTrust.resolveCredentialIssuerKey(
                payload.iss,
                header.kid,
                options.federationTrustSource,
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            return rejected(
                error instanceof FederationResolutionError &&
                    error.failure === "unavailable"
                    ? "trust_list_unavailable"
                    : "no_trust_chain_to_root",
                reason,
            );
        }

        const sigOk = await this.verifyWithJwk(
            data,
            signature,
            header.alg,
            issuerKey.jwk,
        );
        if (!sigOk) {
            return rejected(
                "signature_invalid",
                "SD-JWT-VC issuer signature is invalid",
            );
        }
        return {
            verified: true,
            matchedEntity: null,
            federationIssuer: issuerKey.resolution,
        };
    }

    /**
     * Verifies a status list JWT of a credential verified through OpenID
     * Federation: it must be signed with a key `kid` of the same issuer
     * entity's `openid_credential_issuer` metadata. A key of any other
     * entity could serve a list in which a revoked credential is valid.
     */
    private async verifyFederationStatusList(
        data: string,
        signature: string,
        issuer: FederationResolution | undefined,
    ): Promise<boolean> {
        if (!issuer) return false;
        const header = decodeJwsParts(data)?.header;
        if (typeof header?.kid !== "string") {
            this.logger.warn(
                `Status list of federation issuer ${issuer.entityId} has no kid header`,
            );
            return false;
        }
        const jwk = findFederationProtocolKey(
            issuer.metadata,
            CREDENTIAL_ISSUER_METADATA_TYPE,
            header.kid,
        );
        if (!jwk) {
            this.logger.warn(
                `Status list is not signed with a key of federation issuer ${issuer.entityId} (kid '${header.kid}')`,
            );
            return false;
        }
        return this.verifyWithJwk(data, signature, header.alg, jwk);
    }

    /** Signature check with a trusted key; the header must not pick another algorithm. */
    private async verifyWithJwk(
        data: string,
        signature: string,
        alg: unknown,
        jwk: JWK,
    ): Promise<boolean> {
        if (jwk.alg && alg !== jwk.alg) return false;
        try {
            const crypto = this.cryptoService.getCryptoFromJwk(jwk);
            if (alg !== crypto.alg) return false;
            const verifier = await crypto.getVerifier(jwk);
            return await verifier(data, signature);
        } catch (e: any) {
            this.logger.debug(`Signature check failed: ${e?.message ?? e}`);
            return false;
        }
    }

    /**
     * Verifies the status list JWT using the revocation certificate from
     * the same TrustedEntity that issued the credential.
     *
     * This ensures that the status list is signed by the authorized revocation
     * service of the same entity that issued the credential.
     *
     * @param data The JWT data to verify (header.payload)
     * @param signature The JWT signature
     * @param options The verification options
     * @param matchedEntity The TrustedEntity that matched during credential verification
     * @returns true if the status list is validly signed by the entity's revocation cert
     */
    private async verifyStatusList(
        data: string,
        signature: string,
        options: VerifierOptions,
        matchedEntity: MatchedTrustedEntity | null,
    ): Promise<boolean> {
        try {
            // 1) Verify the signature of the status list JWT
            const [headerB64] = data.split(".");
            const headerJson = Buffer.from(
                headerB64.replaceAll("-", "+").replaceAll("_", "/"),
                "base64",
            ).toString("utf8");
            const header = JSON.parse(headerJson);
            const publicKey =
                await this.resolverService.resolvePublicKey(header);
            const crypto = this.cryptoService.getCryptoFromJwk(publicKey);
            const verifier = await crypto.getVerifier(publicKey);

            // The verifier resolves to false on a bad signature; it only
            // rejects when the signature cannot be checked at all.
            const sigOk = await verifier(data, signature).catch((e) => {
                this.logger.debug(
                    `Status list JWT signature check failed: ${e?.message ?? e}`,
                );
                return false;
            });
            if (!sigOk) {
                this.logger.debug("Status list JWT signature invalid");
                return false;
            }

            // 2) Verify status list certificate chain using shared service
            const x5c: string[] | undefined = header?.x5c;
            return await this.chainValidation.verifyStatusListSignature(
                x5c,
                matchedEntity,
                options.trustListSource,
                {
                    pinnedCertMode: options.policy.pinnedCertMode ?? "leaf",
                },
            );
        } catch (e: any) {
            this.logger.error(
                `Error verifying status list: ${e?.message ?? e}`,
            );
            return false;
        }
    }

    private async verifyKeyBindingJwt(
        data: string,
        signature: string,
        payload: Record<string, unknown>,
        expectedAudience?: string,
    ): Promise<boolean> {
        if (!payload.cnf) {
            throw new Error("No cnf found in the payload");
        }

        const MAX_FUTURE_IAT_SKEW_SECONDS = 60;
        const MAX_PAST_IAT_AGE_SECONDS = 300;
        const [, kbPayloadB64] = data.split(".");
        if (!kbPayloadB64) {
            throw new Error("Invalid key binding JWT payload");
        }

        const kbPayloadJson = Buffer.from(kbPayloadB64, "base64url").toString(
            "utf8",
        );
        const kbPayload = JSON.parse(kbPayloadJson) as {
            aud?: unknown;
            iat?: unknown;
        };

        if (
            typeof kbPayload.iat !== "number" ||
            !Number.isFinite(kbPayload.iat)
        ) {
            throw new BadRequestException("Invalid key binding JWT iat");
        }

        const nowInSeconds = Math.floor(Date.now() / 1000);
        if (kbPayload.iat > nowInSeconds + MAX_FUTURE_IAT_SKEW_SECONDS) {
            this.logger.debug(
                {
                    kbJwtIat: kbPayload.iat,
                    nowInSeconds,
                    maxSkewSeconds: MAX_FUTURE_IAT_SKEW_SECONDS,
                },
                "KB-JWT iat is in the future",
            );
            throw new BadRequestException("Invalid key binding JWT iat");
        }

        if (nowInSeconds - kbPayload.iat > MAX_PAST_IAT_AGE_SECONDS) {
            this.logger.debug(
                {
                    kbJwtIat: kbPayload.iat,
                    nowInSeconds,
                    maxAgeSeconds: MAX_PAST_IAT_AGE_SECONDS,
                },
                "KB-JWT iat is too old",
            );
            throw new BadRequestException("Invalid key binding JWT iat");
        }

        if (expectedAudience) {
            if (kbPayload.aud !== expectedAudience) {
                this.logger.debug(
                    {
                        expectedAudience,
                        actualAudience: kbPayload.aud,
                    },
                    "KB-JWT audience mismatch",
                );
                throw new BadRequestException(
                    "Invalid key binding JWT audience",
                );
            }
        }

        const jwk: JWK = (payload.cnf as any).jwk;
        const crypto = this.cryptoService.getCryptoFromJwk(jwk);
        const verifier = await crypto.getVerifier(jwk);
        return verifier(data, signature);
    }
}

/**
 * The `status` claim of the issuer-signed JWT of the SD-JWT VC `cred`. The
 * library rejects a selectively disclosed `status`, so this is the claim it
 * checks.
 */
function issuerStatusClaim(cred: string): unknown {
    return decodeJwt(cred.split("~", 1)[0]).status;
}

/**
 * Header and payload of `<b64url(header)>.<b64url(payload)>`, or `undefined`
 * when they cannot be decoded.
 */
function decodeJwsParts(
    data: string,
):
    | { header: Record<string, unknown>; payload: Record<string, unknown> }
    | undefined {
    try {
        const compact = `${data}.`;
        return {
            header: decodeProtectedHeader(compact),
            payload: decodeJwt(compact),
        };
    } catch {
        return undefined;
    }
}
