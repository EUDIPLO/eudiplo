import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { SessionTranscript } from "@owf/mdoc";
import { PinoLogger } from "nestjs-pino";
import {
    type MdocSessionData,
    type MdocVerificationResult,
    MdocverifierService,
} from "../credential/mdocverifier/mdocverifier.service.js";
import type { VerificationFailureType } from "../credential/verification-failure.js";
import type {
    CredentialVerificationContext,
    CredentialVerificationFailure,
    CredentialVerificationResult,
    CredentialVerifierFormat,
    PresentationBinding,
    SignedRequestValues,
} from "../domain/credential-verifier-format.js";
import {
    type DcqlClaimQuery,
    evaluateMdocClaimSelection,
    isClaimSelectionSatisfied,
    mdocClaimName,
} from "../domain/dcql-claim-policy.js";

const REASON_BY_FAILURE_TYPE: Record<VerificationFailureType, string> = {
    signature_invalid: "mDOC signature is invalid",
    no_trust_chain_to_root: "no trust chain to a trusted root could be built",
    trust_chain_not_trusted:
        "certificate chain does not match any trusted entity",
    trust_list_unavailable: "the configured trust list could not be loaded",
    certificate_expired: "the issuer certificate is expired or not yet valid",
    x5c_missing: "credential does not include an x5c chain but it is required",
    verification_error: "mDOC verification failed",
};

/**
 * mdoc (ISO 18013-5) verifier format. Requested claims are part of the
 * DeviceRequest the response is verified against, so each `claim_sets`
 * option is verified separately. Claim `values` are checked against the
 * disclosed elements.
 */
@Injectable()
export class MdocCredentialVerifierFormat implements CredentialVerifierFormat {
    readonly format = "mso_mdoc";

    constructor(
        private readonly verifier: MdocverifierService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(MdocCredentialVerifierFormat.name);
    }

    async verify(
        credential: string,
        context: CredentialVerificationContext,
    ): Promise<CredentialVerificationResult> {
        const sessionData = this.sessionData(context.binding);

        if (context.claimSets) {
            return this.verifyClaimSets(credential, context, sessionData);
        }

        const result = await this.verifier.verify(
            credential,
            sessionData,
            context.options,
            context.claims?.map((claim) => claim.path),
        );
        if (!result.verified) {
            return this.failed(context.credentialId, result);
        }

        this.logClaimChecks(context.credentialId, context.claims, result);
        const claimCheck = evaluateMdocClaimSelection(
            result.claims,
            context.claims ?? [],
        );
        return {
            verified: true,
            claims: result.claims,
            docType: result.docType,
            provenance: result.provenance,
            missingClaims: claimCheck.missing,
            mismatchedClaims: claimCheck.mismatched,
        };
    }

    /**
     * The first option that verifies and discloses all its elements with
     * requested values wins. When none does, the last verification failure
     * is reported, else the value mismatches of all verified options.
     */
    private async verifyClaimSets(
        credential: string,
        context: CredentialVerificationContext,
        sessionData: MdocSessionData,
    ): Promise<CredentialVerificationResult> {
        let lastFailure:
            | Pick<MdocVerificationResult, "failureType" | "failureReason">
            | undefined;
        let lastVerified: MdocVerificationResult | undefined;
        const mismatchedClaims = new Set<string>();

        for (const selectedClaims of context.claimSets ?? []) {
            let result: MdocVerificationResult;
            try {
                result = await this.verifier.verify(
                    credential,
                    sessionData,
                    context.options,
                    selectedClaims.map((claim) => claim.path),
                );
            } catch (error) {
                lastFailure = {
                    failureType: "verification_error",
                    failureReason:
                        error instanceof Error ? error.message : undefined,
                };
                continue;
            }

            if (!result.verified) {
                lastFailure = result;
                continue;
            }

            lastVerified = result;
            const claimCheck = evaluateMdocClaimSelection(
                result.claims,
                selectedClaims,
            );
            if (isClaimSelectionSatisfied(claimCheck)) {
                return {
                    verified: true,
                    claims: result.claims,
                    docType: result.docType,
                    provenance: result.provenance,
                    missingClaims: [],
                    mismatchedClaims: [],
                    claimSetSatisfied: true,
                };
            }
            for (const claim of claimCheck.mismatched) {
                mismatchedClaims.add(claim);
            }
        }

        if (lastFailure) {
            return this.failed(context.credentialId, lastFailure);
        }

        return {
            verified: true,
            claims: lastVerified?.claims ?? {},
            docType: lastVerified?.docType,
            provenance: lastVerified?.provenance,
            missingClaims: [],
            mismatchedClaims: [...mismatchedClaims],
            claimSetSatisfied: false,
        };
    }

    /**
     * The session transcript binds the DeviceResponse to the request:
     * OpenID4VPHandover (client id, response URI, nonce) for classic OID4VP,
     * OID4VPDCAPIHandover (origin, nonce) over the DC API, and the pre-built
     * DCAPIHandover for ISO 18013-7. The wrong transcript fails DeviceAuth.
     */
    private sessionData(binding: PresentationBinding): MdocSessionData {
        if (binding.protocol === "iso-18013-7") {
            return {
                protocol: "iso-18013-7",
                sessionTranscript:
                    binding.sessionTranscript as SessionTranscript,
            };
        }

        const request = binding.request;
        const nonce = request?.nonce ?? (binding.sessionNonce as string);
        const jwkThumbprint = request
            ? this.responseEncryptionJwkThumbprint(request)
            : undefined;

        if (binding.useDcApi) {
            return {
                protocol: "dc_api",
                nonce,
                origin: request?.expected_origins?.[0] ?? "",
                jwkThumbprint,
            };
        }
        return {
            protocol: "openid4vp",
            nonce,
            clientId: request?.client_id ?? binding.sessionClientId!,
            responseUri: request?.response_uri ?? binding.sessionResponseUri!,
            responseMode: request?.response_mode ?? "direct_post.jwt",
            jwkThumbprint,
        };
    }

    /**
     * Per ISO 18013-7 / OpenID4VP, OID4VPHandoverInfo carries the SHA-256
     * JWK thumbprint of the verifier's response encryption key (the one in
     * client_metadata.jwks used to encrypt the JARM response). The wallet
     * computes this when constructing DeviceAuthentication, so we must
     * match it here.
     */
    private responseEncryptionJwkThumbprint(
        request: SignedRequestValues,
    ): Uint8Array | undefined {
        try {
            const jwks = request.client_metadata?.jwks?.keys;
            if (!jwks || jwks.length === 0) {
                return undefined;
            }
            // Pick the first encryption key (use=enc) or fall back to first.
            const encJwk = jwks.find((k) => k.use === "enc") ?? jwks[0];
            // RFC 7638 canonical JSON for EC/OKP/RSA keys.
            let canonical: string | undefined;
            if (encJwk.kty === "EC") {
                canonical = JSON.stringify({
                    crv: encJwk.crv,
                    kty: encJwk.kty,
                    x: encJwk.x,
                    y: encJwk.y,
                });
            } else if (encJwk.kty === "OKP") {
                canonical = JSON.stringify({
                    crv: encJwk.crv,
                    kty: encJwk.kty,
                    x: encJwk.x,
                });
            } else if (encJwk.kty === "RSA") {
                canonical = JSON.stringify({
                    e: encJwk.e,
                    kty: encJwk.kty,
                    n: encJwk.n,
                });
            }
            if (!canonical) {
                return undefined;
            }
            return new Uint8Array(
                createHash("sha256")
                    .update(Buffer.from(canonical, "utf8"))
                    .digest(),
            );
        } catch (err: any) {
            this.logger.debug(
                `Could not compute response-encryption JWK thumbprint: ${err?.message ?? err}`,
            );
            return undefined;
        }
    }

    /**
     * Failures are classified at the source (classifyVerificationError /
     * mapChainErrorToFailureType in the mDOC verifier), so the reason maps
     * straight off failureType.
     */
    private failed(
        credentialId: string,
        result: Pick<
            MdocVerificationResult,
            "failureType" | "failureReason" | "docType"
        >,
    ): CredentialVerificationResult {
        const reason =
            (result.failureType
                ? REASON_BY_FAILURE_TYPE[result.failureType]
                : undefined) || "mDOC verification failed";

        this.logger.warn(
            {
                credentialId,
                failureType: result.failureType,
                failureReason: result.failureReason,
            },
            "mDOC verification failed",
        );

        const failure: CredentialVerificationFailure = {
            type: result.failureType,
            reason: result.failureReason,
            message: `mDOC verification failed for credential "${credentialId}": ${reason}`,
        };
        return { verified: false, failure, docType: result.docType };
    }

    private logClaimChecks(
        credentialId: string,
        requestedClaims: DcqlClaimQuery[] | undefined,
        result: MdocVerificationResult,
    ): void {
        for (const claim of requestedClaims ?? []) {
            const claimName = mdocClaimName(claim.path);
            this.logger.debug(
                {
                    credentialId,
                    claimName,
                    receivedClaimKeys: Object.keys(result.claims),
                },
                "Validating mDOC claim presence",
            );
            this.logger.trace(
                { credentialId, claimName, receivedClaims: result.claims },
                "[TRACE] mDOC full received claims payload",
            );
        }
    }
}
