import { BadRequestException, Injectable } from "@nestjs/common";
import { digest } from "@owf/crypto";
import { SLException, type StatusListEntry } from "@owf/token-status-list";
import { Jwt, SDJWTException } from "@sd-jwt/core";
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
    RevocationListUnavailableError,
    resolveRevocationPolicy,
} from "../../../../trust/revocation-policy.util.js";
import { StatusListVerifierService } from "../../../../trust/status-list-verifier.service.js";
import { VerifierOptions } from "../../../../trust/types.js";
import { MatchedTrustedEntity } from "../../../../trust/x509-validation.service.js";
import { ResolverService } from "../../../resolver/resolver.service.js";
import { pidWithoutStatusProblem } from "../../domain/pid-status-requirement.js";
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
        private readonly statusListVerifier: StatusListVerifierService,
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

        let failure:
            | { failureType: VerificationFailureType; reason?: string }
            | undefined;
        // The trusted entity the credential matched, or under OpenID
        // Federation the resolved issuer entity: its status list must be
        // signed by the same entity.
        let matchedEntity: MatchedTrustedEntity | null = null;
        let federationIssuer: FederationResolution | undefined;
        // Whether the issuer is listed as a PID provider, for the PID rule
        // of checkStatus.
        let pidIssuer = false;

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
                pidIssuer = result.pidIssuer ?? false;
                if (!result.verified) {
                    // The library throws a generic error on failure, so the
                    // structured reason has to be captured here or it is lost.
                    failure = {
                        failureType: result.failureType ?? "verification_error",
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
        });

        let result: VerificationResult;
        try {
            // The status is checked below, not by the library: it would fetch
            // the list with the global fetch, outside the outbound URL policy,
            // and decompress it without a size limit.
            result = await sdjwtInstance.verify(cred, {
                ...options,
                disableStatusVerification: true,
            });
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
            await this.checkStatus(
                result,
                options,
                revocationPolicy.failClosed,
                pidIssuer,
                // Signed with a key of the same federation entity, or under
                // a revocation certificate of the same trusted entity
                (data, signature) =>
                    options.federationTrustSource
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
                          ),
            );
        }

        return result;
    }

    /**
     * Checks the status of a verified SD-JWT VC (Token Status List Section
     * 8.3). A malformed `status` claim or `status_list` reference names no
     * status the verifier could check and is rejected in every mode.
     *
     * Two cases leave a status the verifier could not check: strict mode
     * rejects them, best-effort mode logs them and accepts the credential.
     * - a `status` object that names only another mechanism;
     * - no `status` claim on a PID valid for more than 24 hours (see
     *   {@link pidWithoutStatusProblem}). Its validity runs from `nbf`, else
     *   `iat`, to `exp`. `iat` may be selectively disclosable: a withheld
     *   one leaves the start unknown, which counts as longer than 24 hours.
     *   Other credentials without a `status` claim are left to the policy
     *   of the relying party (ARF Annex 2 VCR_14) and accepted.
     *
     * Best-effort mode also accepts the credential when the status list
     * cannot be fetched; a list that was fetched but fails its checks,
     * cannot be read or says the credential is not valid rejects it in every
     * mode.
     *
     * @param pid Whether the issuer is listed as a PID provider
     * @param verifyListSignature Checks that the status list JWT is signed
     * by the credential's issuer
     */
    private async checkStatus(
        result: VerificationResult,
        options: VerifierOptions,
        failClosed: boolean,
        pid: boolean,
        verifyListSignature: (
            data: string,
            signature: string,
        ) => Promise<boolean>,
    ): Promise<void> {
        const payload = result.payload as Record<string, unknown>;
        const status = payload.status;
        let reference: StatusListEntry | undefined;
        try {
            reference = parseStatusListReference(status);
        } catch (error) {
            if (!(error instanceof MalformedStatusReferenceError)) {
                throw error;
            }
            this.rejectStatus(error.message);
        }

        if (!reference) {
            const reason =
                status === undefined
                    ? pidWithoutStatusProblem({
                          pid,
                          validFrom:
                              numericDate(payload.nbf) ??
                              numericDate(payload.iat),
                          validUntil: numericDate(payload.exp),
                      })
                    : "The credential's status claim contains no supported status mechanism, so its status could not be checked";
            if (!reason) {
                return;
            }
            if (failClosed) {
                this.rejectStatus(reason);
            }
            this.logger.warn(`${reason}; accepting it in best-effort mode`);
            return;
        }

        try {
            await this.checkStatusListEntry(
                reference,
                options,
                verifyListSignature,
            );
        } catch (error) {
            if (
                failClosed ||
                !(error instanceof RevocationListUnavailableError)
            ) {
                throw error;
            }
            this.logger.warn(
                { error: error.message },
                "Status list unavailable in best-effort mode, accepting the SD-JWT VC without status check",
            );
        }
    }

    /** Reject the credential for a status it could not be checked by. */
    private rejectStatus(reason: string): never {
        this.logger.warn(
            `SD-JWT-VC verification failed (verification_error): ${reason}`,
        );
        throw new SdJwtVerificationError("verification_error", reason);
    }

    /**
     * Checks the status a `status_list` reference names (Token Status List
     * Section 8.3). The status list JWT must be signed by the credential's
     * issuer; its `alg` and time claims are checked with the signature.
     * {@link StatusListVerifierService} then checks `typ`, `sub`, `iat` and
     * `exp` and reads the status: it decompresses the list up to a size
     * limit and reads the status bits in place. @sd-jwt/sd-jwt-vc
     * decompresses it without a limit and turns every status into a number,
     * so a signed list of about a megabyte could take gigabytes.
     *
     * @throws RevocationListUnavailableError if the list cannot be fetched
     */
    private async checkStatusListEntry(
        reference: StatusListEntry,
        options: VerifierOptions,
        verifyListSignature: (
            data: string,
            signature: string,
        ) => Promise<boolean>,
    ): Promise<void> {
        const { uri, idx } = reference;
        const statusListJwt =
            await this.statusListVerifier.getStatusListJwt(uri);

        const skewSeconds = options.skewSeconds ?? 0;
        await Jwt.fromEncode(statusListJwt)
            .verify(verifyListSignature, { skewSeconds })
            .catch((error: unknown) => {
                throw Object.assign(
                    new SLException(
                        `Status List JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
                        { uri },
                    ),
                    { cause: error },
                );
            });

        const { status, isValid } =
            this.statusListVerifier.getStatusFromStatusListJwt(
                statusListJwt,
                reference,
                skewSeconds,
            );
        if (!isValid) {
            throw new SDJWTException("Status is not valid", {
                details: { uri, idx, status },
                code: "STATUS_INVALID",
            });
        }
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
        pidIssuer?: boolean;
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

            return {
                verified: true,
                matchedEntity: chainResult.matchedEntity,
                pidIssuer: chainResult.pidIssuer,
            };
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
        pidIssuer?: boolean;
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

/** A JWT NumericDate claim, or `undefined` if it is missing or not a number. */
function numericDate(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
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
