import { Injectable } from "@nestjs/common";
import { hex } from "@owf/identity-common";
import {
    DeviceRequest,
    DeviceResponse,
    DocRequest,
    ItemsRequest,
    type MobileSecurityObject,
    SessionTranscript,
    Verifier,
} from "@owf/mdoc";
import * as x509 from "@peculiar/x509";
import { Span } from "nestjs-otel";
import { PinoLogger } from "nestjs-pino";
import { VerificationProvenance } from "../../../../session/domain/session-outcome.js";
import { MalformedStatusReferenceError } from "../../../../trust/domain/status-list-reference.js";
import {
    RevocationListUnavailableError,
    resolveRevocationPolicy,
} from "../../../../trust/revocation-policy.util.js";
import {
    InvalidStatusListTokenError,
    StatusListVerifierService,
} from "../../../../trust/status-list-verifier.service.js";
import { VerifierOptions } from "../../../../trust/types.js";
import { pidWithoutStatusProblem } from "../../domain/pid-status-requirement.js";
import { mdocContext, withFetch } from "../../mdoc-context.js";
import {
    ChainValidationResult,
    CredentialChainValidationService,
} from "../credential-chain-validation.service.js";
import {
    mapChainErrorToFailureType,
    type VerificationFailureType,
} from "../verification-failure.js";
import { toProvenance } from "../verification-provenance.js";

/**
 * Session data for the standard OID4VP flow (direct_post or direct_post.jwt).
 */
type MdocSessionDataOid4vp = {
    protocol: "openid4vp";
    nonce: string;
    responseMode: string;
    clientId: string;
    responseUri: string;
    /** SHA-256 JWK thumbprint (raw bytes) of the verifier's JAR signing key. */
    jwkThumbprint?: Uint8Array;
};

/**
 * Session data for OID4VP via DC API (openid4vp-v1-unsigned, response_mode=dc_api.jwt).
 * Uses OID4VPDCAPIHandover transcript: SHA256(CBOR([origin, nonce, jwkThumbprint?])).
 */
type MdocSessionDataDcApi = {
    protocol: "dc_api";
    nonce: string;
    origin: string;
    jwkThumbprint?: Uint8Array;
};

/**
 * Session data for ISO 18013-7 Annex C (org-iso-mdoc via DC API).
 * The DCAPIHandover session transcript is pre-built by the caller.
 */
type MdocSessionDataIso18013 = {
    protocol: "iso-18013-7";
    /** Pre-built DCAPIHandover SessionTranscript for verifyDeviceResponse. */
    sessionTranscript: SessionTranscript;
};

export type MdocSessionData =
    | MdocSessionDataOid4vp
    | MdocSessionDataDcApi
    | MdocSessionDataIso18013;

export type RequestedMdocClaimPath = string[];

export type MdocVerificationResult = {
    verified: boolean;
    claims: Record<string, unknown>;
    payload: string;
    docType?: string;
    failureType?: VerificationFailureType;
    failureReason?: string;
    /** Trust provenance for a successful verification. */
    provenance?: VerificationProvenance;
};

/**
 * Error details extracted from an mDOC document for debugging.
 */
interface MdocErrorDetails {
    docType: string;
    issuerCertInfo: string;
    issuerThumbprint: string;
    issuerValidity: string;
    trustedCertsSummary: string;
}

@Injectable()
export class MdocverifierService {
    constructor(
        private readonly chainValidation: CredentialChainValidationService,
        private readonly statusListVerifier: StatusListVerifierService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(MdocverifierService.name);
    }

    /**
     * Verifies an mDOC credential.
     * @param vp The base64url encoded device response
     * @param sessionData Session data for transcript generation
     * @param options Verification options including trust list
     * @returns Verification result with claims
     */
    @Span("mdoc.verify")
    async verify(
        vp: string,
        sessionData: MdocSessionData,
        options: VerifierOptions,
        requestedClaimPaths?: RequestedMdocClaimPath[],
    ): Promise<MdocVerificationResult> {
        try {
            const revocationPolicy = resolveRevocationPolicy(options);

            // 1) Decode the device response
            const uint8Array = Buffer.from(vp, "base64url");
            const deviceResponse = DeviceResponse.decode(uint8Array);
            const mdocDocument = deviceResponse.documents?.[0];

            if (!mdocDocument) {
                throw new Error("mDOC document not found in device response");
            }

            // 2) Extract claims from the issuer signed data
            const issuerSigned = mdocDocument.issuerSigned;
            const docType = mdocDocument.docType;

            // Collect claims from all available namespaces.
            // getPrettyClaims() requires an exact namespace string, so we iterate
            // the namespaces present in the credential rather than guessing from docType.
            const namespacesMap =
                issuerSigned.issuerNamespaces?.issuerNamespaces ??
                new Map<string, unknown>();
            const claimsByNamespace: Record<
                string,
                Record<string, unknown>
            > = {};
            const claims: Record<string, unknown> = {};
            for (const [ns] of namespacesMap.entries()) {
                const nsClaims = issuerSigned.getPrettyClaims(ns);
                if (nsClaims) {
                    claimsByNamespace[ns] = nsClaims;
                    Object.assign(claims, nsClaims);
                }
            }

            // 3) Build the session transcript for verification
            let sessionTranscript: SessionTranscript | Uint8Array;
            if (sessionData.protocol === "iso-18013-7") {
                // DCAPIHandover: pre-built by Iso18013Service
                sessionTranscript = sessionData.sessionTranscript;
            } else if (sessionData.protocol === "dc_api") {
                // OID4VP DC API: SHA256 hash of CBOR([origin, nonce, jwkThumbprint?])
                sessionTranscript = await SessionTranscript.forOid4VpDcApi(
                    {
                        origin: sessionData.origin,
                        nonce: sessionData.nonce,
                        jwkThumbprint: sessionData.jwkThumbprint,
                    },
                    mdocContext,
                );
            } else {
                // Standard OID4VP: OpenID4VPHandover
                sessionTranscript = await SessionTranscript.forOid4Vp(
                    sessionData,
                    mdocContext,
                );
            }

            // 4) Build a device request (currently requesting all claims that were received)
            const deviceRequest = this.buildDeviceRequest(
                docType,
                requestedClaimPaths,
                claimsByNamespace,
            );

            const issuerX5Chain =
                mdocDocument?.issuerSigned?.issuerAuth?.x5chain;
            const trustedEntries =
                await this.chainValidation.getTrustedCertificateEntries(
                    options.trustListSource,
                );

            const normalizeDer = (certificate: Uint8Array): Uint8Array => {
                try {
                    const parsed = new x509.X509Certificate(certificate as any);
                    return new Uint8Array(parsed.rawData);
                } catch {
                    return certificate;
                }
            };

            // @owf/mdoc checks a status list against the status anchors of
            // the entry whose issuance anchor the credential chain ended at:
            // one entry per trusted issuance service, with the status list
            // signers paired with it. When LoTE issuance anchors are
            // available, pass only those instead of the presented x5chain.
            // Trust-list entries are DER already and share their status
            // arrays, so they are passed on without parsing them again.
            const presentedChain = (issuerX5Chain ?? []).map(normalizeDer);
            const anchorEntries =
                trustedEntries.length > 0 || presentedChain.length === 0
                    ? trustedEntries
                    : [{ issuance: presentedChain, status: presentedChain }];
            const buildTrustedCertificates = (attachStatus: boolean) =>
                anchorEntries.map(({ issuance, status }) => ({
                    issuance,
                    ...(attachStatus && status.length > 0 ? { status } : {}),
                }));

            // 5) Verify the device response (signature, device binding, etc.)
            // Certificate chain validation is disabled here - we do it separately via CredentialChainValidationService
            // @owf/mdoc requires trusted status certificates when status validation data
            // is present in the credential. We attach status anchors unconditionally and
            // use revocation policy only to control fail-open/fail-closed behavior.
            const includeStatusCheck = revocationPolicy.enabled;

            // Status lists and identifier lists named in the presented MSO are
            // fetched under the outbound URL policy, not with the global
            // `fetch`. The message of a failed status check can contain the
            // list's URI (for a revoked identifier list, for example), so an
            // unavailable list is recorded here instead of being recognised by
            // the message.
            let revocationListUnavailable = false;
            // A list uri that is not a URI is not fetched, and a status list
            // that cannot be decompressed within its size limit is refused.
            // The library wraps these errors in one that reads like an
            // unavailable status list, so they are recorded here too.
            let refusedListReason: string | undefined;
            const verificationContext = withFetch(async (input, init) => {
                try {
                    return await this.statusListVerifier.mdocFetch(input, init);
                } catch (error) {
                    if (error instanceof RevocationListUnavailableError) {
                        revocationListUnavailable = true;
                    }
                    if (
                        error instanceof MalformedStatusReferenceError ||
                        error instanceof InvalidStatusListTokenError
                    ) {
                        refusedListReason = error.message;
                    }
                    throw error;
                }
            });
            const attachStatusAnchorsForMdoc = true;
            let trustedCertificates = buildTrustedCertificates(
                attachStatusAnchorsForMdoc,
            );

            if (!revocationPolicy.enabled) {
                this.logger.debug(
                    "Revocation policy is disabled, but status anchors are still attached for mDOC library compatibility",
                );
            }

            try {
                await this.logStatusValidationCertificates(
                    issuerX5Chain,
                    trustedEntries.flatMap((entry) => entry.issuance),
                    // Entries of a service type share one status array.
                    [
                        ...new Set(
                            [
                                ...new Set(
                                    trustedEntries.map((entry) => entry.status),
                                ),
                            ].flat(),
                        ),
                    ],
                    attachStatusAnchorsForMdoc,
                );
            } catch (error: any) {
                this.logger.debug(
                    `Skipping mDOC cert identifier debug logging: ${error?.message ?? error}`,
                );
            }

            try {
                await Verifier.verifyDeviceResponse(
                    {
                        deviceRequest,
                        deviceResponse,
                        sessionTranscript,
                        trustedCertificates,
                        disableStatusValidation: !includeStatusCheck,
                    },
                    verificationContext,
                );
            } catch (error) {
                if (refusedListReason) {
                    this.logger.warn(
                        `mDOC verification failed: ${refusedListReason}`,
                    );
                    return {
                        verified: false,
                        claims: {},
                        payload: vp,
                        docType,
                        failureType: "verification_error",
                        failureReason: refusedListReason,
                    };
                }
                if (
                    !includeStatusCheck ||
                    revocationPolicy.failClosed ||
                    !revocationListUnavailable
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
                    "Status list or identifier list unavailable in best-effort mode, retrying mDOC verification without status check",
                );

                trustedCertificates = buildTrustedCertificates(false);
                await Verifier.verifyDeviceResponse(
                    {
                        deviceRequest,
                        deviceResponse,
                        sessionTranscript,
                        trustedCertificates,
                        disableStatusValidation: true,
                    },
                    verificationContext,
                );
            }

            // 6) Validate certificate chain using shared CredentialChainValidationService
            // This ensures consistent trust validation with SD-JWT-VC and other formats
            const chainResult = await this.validateIssuerCertificateChain(
                mdocDocument,
                options,
            );

            if (!chainResult.verified) {
                if (chainResult.errorDetails) {
                    this.logger.warn(
                        `Certificate chain validation failed: ${chainResult.errorDetails}`,
                    );
                }

                const failureType = this.mapChainErrorToFailureType(
                    chainResult.error,
                );
                const failureReason =
                    chainResult.errorDetails ||
                    chainResult.error ||
                    "Certificate chain validation failed";

                return {
                    verified: false,
                    claims,
                    payload: vp,
                    docType,
                    failureType,
                    failureReason,
                };
            }

            const statusProblem = includeStatusCheck
                ? this.checkStatusMechanism(
                      mdocDocument,
                      revocationPolicy.failClosed,
                      chainResult.pidIssuer ?? false,
                  )
                : undefined;
            if (statusProblem) {
                this.logger.warn(`mDOC verification failed: ${statusProblem}`);
                return {
                    verified: false,
                    claims: {},
                    payload: vp,
                    docType,
                    failureType: "verification_error",
                    failureReason: statusProblem,
                };
            }

            this.logger.debug(
                `MDL device response verified successfully for docType: ${docType}`,
            );

            return {
                verified: true,
                claims,
                payload: vp,
                docType,
                provenance: toProvenance(chainResult.matchedEntity),
            };
        } catch (error: any) {
            return this.handleVerificationError(vp, error, options);
        }
    }

    /**
     * @owf/mdoc checks only the status list and identifier list of the MSO's
     * `status` and skips a `status` that names neither, as the SD-JWT VC
     * library does. An empty one is malformed (Token Status List Section
     * 6.3) and is rejected in every mode that checks status.
     *
     * Two cases leave a status the verifier could not check: strict mode
     * rejects them, best-effort mode logs them and accepts the credential.
     * - a `status` that names only another mechanism;
     * - no `status` in the MSO of a PID valid for more than 24 hours (see
     *   {@link pidWithoutStatusProblem}), from `validFrom` to `validUntil`.
     *   Other mDOCs without `status` cannot be revoked and are accepted.
     *
     * @param pid Whether the issuer is listed as a PID provider
     * @returns Why the credential is rejected, or `undefined`
     */
    private checkStatusMechanism(
        mdocDocument: any,
        failClosed: boolean,
        pid: boolean,
    ): string | undefined {
        const mso: MobileSecurityObject | undefined =
            mdocDocument?.issuerSigned?.issuerAuth?.mobileSecurityObject;
        const status = mso?.status;
        if (status?.statusList || status?.identifierList) {
            return undefined;
        }
        if (status?.encodedStructure.size === 0) {
            return "The MSO's status names no status mechanism";
        }
        const reason = status
            ? "The MSO's status contains no supported status mechanism, so its status could not be checked"
            : mso &&
              pidWithoutStatusProblem({
                  pid,
                  validFrom: epochSeconds(mso.validityInfo.validFrom),
                  validUntil: epochSeconds(mso.validityInfo.validUntil),
              });
        if (!reason) {
            return undefined;
        }
        if (failClosed) {
            return reason;
        }
        this.logger.warn(`${reason}; accepting it in best-effort mode`);
        return undefined;
    }

    /**
     * Validates the issuer certificate chain from the mDOC's IssuerAuth.
     * Extracts x5chain from the COSE Sign1 structure and validates it using
     * the shared CredentialChainValidationService.
     */
    private async validateIssuerCertificateChain(
        mdocDocument: any,
        options: VerifierOptions,
    ): Promise<ChainValidationResult> {
        // An mDOC names no issuer entity, so OpenID Federation cannot bind
        // its signing key to trusted federation metadata.
        if (options.federationTrustSource) {
            return {
                verified: false,
                matchedEntity: null,
                error: "federation_not_supported",
                errorDetails:
                    "OpenID Federation trust is only supported for SD-JWT VCs; add an etsi_tl trusted authority for mso_mdoc",
            };
        }

        // Extract x5chain from IssuerAuth (COSE Sign1 unprotected headers)
        const issuerAuth = mdocDocument?.issuerSigned?.issuerAuth;
        const x5chain: Uint8Array[] | undefined = issuerAuth?.x5chain;

        if (!x5chain || x5chain.length === 0) {
            // No x5c in the credential
            if (options.policy?.requireX5c) {
                return {
                    verified: false,
                    matchedEntity: null,
                    error: "x5c_required",
                    errorDetails:
                        "Policy requires x5c but none was found in IssuerAuth",
                };
            }
            // If x5c not required, skip trust validation
            return { verified: true, matchedEntity: null };
        }

        // Convert Uint8Array[] to base64 string[] for CredentialChainValidationService
        const x5cBase64 = x5chain.map((cert) =>
            Buffer.from(cert).toString("base64"),
        );

        return this.chainValidation.validateChain(
            x5cBase64,
            options.trustListSource,
            {
                requireX5c: options.policy?.requireX5c,
                pinnedCertMode: options.policy?.pinnedCertMode ?? "leaf",
            },
        );
    }

    /**
     * Handle verification errors with detailed logging.
     */
    private async handleVerificationError(
        vp: string,
        error: any,
        options: VerifierOptions,
    ): Promise<MdocVerificationResult> {
        const configuredTrustLists =
            options.trustListSource?.lotes?.map((l) => l.url).join(", ") ||
            "none configured";

        const details = await this.extractErrorDetails(vp, options);

        const errorDetails = [
            `Error: ${error?.message ?? error}`,
            `DocType: ${details.docType}`,
            `Issuer cert: ${details.issuerCertInfo}`,
            `Issuer thumbprint: ${details.issuerThumbprint}`,
            `Issuer validity: ${details.issuerValidity}`,
            `Configured trust lists: ${configuredTrustLists}`,
            `Trusted certs: ${details.trustedCertsSummary}`,
        ].join(" | ");

        this.logger.error(`mDOC verification failed: ${errorDetails}`);

        let failureType = this.classifyVerificationError(error);
        let failureReason = error?.message ?? String(error);

        // In some failing cases the mDOC library throws a signature-related error first,
        // even though the underlying trust chain is also not valid for the configured trust list.
        // Probe chain validation here to return a more actionable trust-specific reason.
        if (failureType === "signature_invalid") {
            try {
                const uint8Array = Buffer.from(vp, "base64url");
                const deviceResponse = DeviceResponse.decode(uint8Array);
                const mdocDocument = deviceResponse.documents?.[0];

                if (mdocDocument) {
                    const chainResult =
                        await this.validateIssuerCertificateChain(
                            mdocDocument,
                            options,
                        );

                    if (!chainResult.verified) {
                        failureType = this.mapChainErrorToFailureType(
                            chainResult.error,
                        );
                        failureReason =
                            chainResult.errorDetails ||
                            chainResult.error ||
                            failureReason;

                        this.logger.warn(
                            `mDOC verification encountered signature error but trust chain check also failed: ${failureReason}`,
                        );
                    }
                }
            } catch (chainProbeError: any) {
                this.logger.debug(
                    `Could not probe chain failure after signature error: ${chainProbeError?.message ?? chainProbeError}`,
                );
            }
        }

        // An issuer listed only in a list discarded as outdated is not
        // trusted; name those lists so the session log tells it apart from an
        // issuer that is not listed at all.
        if (
            failureType === "trust_chain_not_trusted" ||
            failureType === "no_trust_chain_to_root"
        ) {
            const discarded =
                await this.chainValidation.discardedTrustListsDetail(
                    options.trustListSource,
                );
            if (discarded && !failureReason.includes(discarded)) {
                failureReason = `${failureReason} | ${discarded}`;
            }
        }

        return {
            verified: false,
            claims: {},
            payload: vp,
            docType:
                details.docType === "unknown" ? undefined : details.docType,
            failureType,
            failureReason,
        };
    }

    private mapChainErrorToFailureType(
        errorCode?: string,
    ): VerificationFailureType {
        return mapChainErrorToFailureType(errorCode);
    }

    private classifyVerificationError(error: any): VerificationFailureType {
        const message = String(error?.message ?? error).toLowerCase();

        if (message.includes("signature")) {
            return "signature_invalid";
        }

        // @owf/mdoc reports an untrusted issuer from inside verifyDeviceResponse
        // as "No trusted certificate was found while validating the X.509
        // chain", which never reaches mapChainErrorToFailureType. Left
        // unclassified it surfaces as a generic verification error, which erases
        // the distinction a relying party most needs — a malformed or expired
        // credential versus an issuer that is simply not trusted. For age
        // verification those call for opposite actions.
        if (
            /no trusted certificate|trust\s*chain|trusted\s*root|trusted\s*entity/.test(
                message,
            )
        ) {
            return "trust_chain_not_trusted";
        }

        if (message.includes("status list") || message.includes("trust list")) {
            return "trust_list_unavailable";
        }

        return "verification_error";
    }

    /**
     * Extract error details from the mDOC document for debugging.
     */
    private async extractErrorDetails(
        vp: string,
        options: VerifierOptions,
    ): Promise<MdocErrorDetails> {
        const details: MdocErrorDetails = {
            docType: "unknown",
            issuerCertInfo: "unknown",
            issuerThumbprint: "unknown",
            issuerValidity: "unknown",
            trustedCertsSummary: "unknown",
        };

        try {
            const uint8Array = Buffer.from(vp, "base64url");
            const deviceResponse = DeviceResponse.decode(uint8Array);
            const mdocDoc = deviceResponse.documents?.[0];

            if (mdocDoc?.docType) {
                details.docType = mdocDoc.docType;
            }

            // Extract issuer certificate info from the MSO
            await this.extractIssuerCertInfo(mdocDoc, details);

            // Summarize trusted certificates
            details.trustedCertsSummary = await this.summarizeTrustedCerts(
                options.trustListSource,
            );
        } catch (parseError: any) {
            this.logger.debug(
                `Could not extract additional debug info: ${parseError?.message ?? parseError}`,
            );
        }

        return details;
    }

    /**
     * Extract issuer certificate information from the mDOC document.
     */
    private async extractIssuerCertInfo(
        mdocDoc: any,
        details: MdocErrorDetails,
    ): Promise<void> {
        const issuerAuth = mdocDoc?.issuerSigned?.issuerAuth;
        if (!issuerAuth) return;

        const x5chain = issuerAuth?.x5chain;
        if (!x5chain?.length) return;

        try {
            const leafCertBytes = x5chain[0];
            const leafCert = new x509.X509Certificate(leafCertBytes);
            const thumbprint = await leafCert.getThumbprint("SHA-256");

            details.issuerThumbprint = hex.encode(new Uint8Array(thumbprint));
            details.issuerValidity = `${leafCert.notBefore.toISOString()} - ${leafCert.notAfter.toISOString()}`;
            details.issuerCertInfo = `subject="${leafCert.subject}", issuer="${leafCert.issuer}"`;
        } catch {
            // Ignore certificate parsing errors
        }
    }

    /**
     * Summarize trusted certificates for error logging.
     */
    private async summarizeTrustedCerts(
        trustListSource: VerifierOptions["trustListSource"],
    ): Promise<string> {
        const trustedCerts = (
            await this.chainValidation.getTrustedCertificateEntries(
                trustListSource,
            )
        ).flatMap((entry) => entry.issuance);

        if (trustedCerts.length === 0) {
            return "none loaded";
        }

        const certSummaries: string[] = [];
        for (const certBuf of trustedCerts.slice(0, 5)) {
            try {
                const cert = new x509.X509Certificate(new Uint8Array(certBuf));
                const thumb = hex.encode(
                    new Uint8Array(await cert.getThumbprint("SHA-256")),
                );
                certSummaries.push(
                    `${cert.subject} (${thumb.substring(0, 16)}...)`,
                );
            } catch {
                // Skip invalid certs
            }
        }

        let summary =
            certSummaries.length > 0 ? certSummaries.join("; ") : "none valid";
        if (trustedCerts.length > 5) {
            summary += ` ...and ${trustedCerts.length - 5} more`;
        }

        return summary;
    }

    /**
     * Logs certificate identifiers used by mDOC status verification to help diagnose
     * trust-anchor / status-anchor mismatches.
     */
    private async logStatusValidationCertificates(
        issuerX5Chain: Uint8Array[] | undefined,
        trustedIssuanceAnchors: Uint8Array[],
        trustedStatusAnchors: Uint8Array[],
        statusAnchorsAttached: boolean,
    ): Promise<void> {
        const toDebug = async (certBytes: Uint8Array) => {
            try {
                const cert = new x509.X509Certificate(certBytes as any);
                const thumbprint = hex.encode(
                    new Uint8Array(await cert.getThumbprint("SHA-256")),
                );
                const ski = this.extractExtensionKeyId(
                    cert.getExtension("2.5.29.14") as any,
                );
                const aki = this.extractExtensionKeyId(
                    cert.getExtension("2.5.29.35") as any,
                );

                return {
                    subject: cert.subject,
                    issuer: cert.issuer,
                    thumbprint,
                    ski,
                    aki,
                };
            } catch (error: any) {
                return {
                    parseError: error?.message ?? String(error),
                };
            }
        };

        const [issuerChain, issuanceAnchors, statusAnchors] = await Promise.all(
            [
                Promise.all((issuerX5Chain ?? []).map((cert) => toDebug(cert))),
                Promise.all(
                    trustedIssuanceAnchors.map((cert) => toDebug(cert)),
                ),
                Promise.all(trustedStatusAnchors.map((cert) => toDebug(cert))),
            ],
        );

        this.logger.debug(
            {
                statusAnchorsAttached,
                issuerChain,
                trustedIssuanceAnchors: issuanceAnchors,
                trustedStatusAnchors: statusAnchors,
            },
            "mDOC status validation certificate identifiers (SKI/AKI)",
        );
    }

    private extractExtensionKeyId(
        extension: { keyId?: string } | undefined,
    ): string | undefined {
        const keyId = extension?.keyId;
        return typeof keyId === "string" && keyId.length > 0
            ? keyId.toLowerCase()
            : undefined;
    }

    /**
     * Build a device request based on the docType and received claims.
     * This creates a request that matches what was received for verification.
     */
    private buildDeviceRequest(
        docType: string,
        requestedClaimPaths: RequestedMdocClaimPath[] | undefined,
        claimsByNamespace: Record<string, Record<string, unknown>>,
    ): DeviceRequest {
        // Prefer original DCQL claim paths because deviceAuth is bound to the
        // request semantics, not just the disclosed claims returned by the wallet.
        const namespaces: Record<string, Record<string, boolean>> = {};

        if (requestedClaimPaths && requestedClaimPaths.length > 0) {
            for (const path of requestedClaimPaths) {
                if (path.length === 0) {
                    continue;
                }

                const namespace = path.length > 1 ? path[0] : docType;
                const claimName =
                    path.length > 1 ? path.slice(1).join(".") : path[0];

                if (!namespaces[namespace]) {
                    namespaces[namespace] = {};
                }
                namespaces[namespace][claimName] = true;
            }
        }

        if (Object.keys(namespaces).length === 0) {
            // Fallback: build namespace map from disclosed claims.
            // This is less strict than using original DCQL but keeps compatibility
            // for flows where no explicit mDOC claims were requested.
            for (const [ns, nsClaims] of Object.entries(claimsByNamespace)) {
                if (Object.keys(nsClaims).length > 0) {
                    namespaces[ns] = {};
                    for (const claimKey of Object.keys(nsClaims)) {
                        namespaces[ns][claimKey] = true;
                    }
                }
            }
        }

        return DeviceRequest.create({
            docRequests: [
                DocRequest.create({
                    itemsRequest: ItemsRequest.create({
                        docType,
                        namespaces,
                    }),
                }),
            ],
        });
    }
}

/** A date as epoch seconds. */
function epochSeconds(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}
