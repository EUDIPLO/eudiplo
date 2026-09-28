import { createHash } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
} from "@nestjs/common";
import { base64url, decodeJwt } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { PinoLogger } from "nestjs-pino";
import { ServiceTypeIdentifier } from "../../issuer/trust-list/trustlist.service.js";
import type { SessionData as Session } from "../../session/domain/session-data.js";
import { revocationModeToPolicy } from "../../trust/revocation-policy.util.js";
import {
    DEFAULT_VERIFIER_SKEW_SECONDS,
    VerifierOptions,
} from "../../trust/types.js";
import { CredentialVerifierFormatRegistry } from "./credential/credential-verifier-format-registry.js";
import {
    MdocSessionDataDcApi,
    MdocSessionDataOid4vp,
} from "./credential/mdocverifier/mdocverifier.service.js";
import type { VerificationFailureType } from "./credential/verification-failure.js";
import {
    claimSelections,
    claimSetNotSatisfied,
    findMissingCredentials,
    findMissingMdocClaims,
    type IncompletePresentation,
    matchesClaimSelection,
    matchesMdocClaimSelection,
    mdocClaimName,
    requiredClaimKeys,
    UnknownClaimSetReferenceError,
    type VerifierCredentialFormat,
} from "./domain/dcql-claim-policy.js";
import { AuthResponse } from "./dto/auth-response.dto.js";
import {
    ClaimsQuery,
    CredentialQueryValue,
    PresentationConfig,
    TrustedAuthorityQueryEtsiTl,
    TrustedAuthorityQueryOpenIdFederation,
    TrustedAuthorityType,
} from "./entities/presentation-config.entity.js";
import { IncompletePresentationException } from "./exceptions/incomplete-presentation.exception.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "./presentation-settings.js";
import {
    InvalidTrustedAuthoritiesError,
    TrustedAuthoritiesService,
} from "./trusted-authorities.service.js";

/** Values of the signed request object that bind the wallet response. */
type RequestObjectSessionData = {
    nonce?: string;
    client_id?: string;
    response_uri?: string;
    response_mode?: string;
    expected_origins?: string[];
};

type CredentialValueOptions = {
    cred: string;
    attId: string;
    session: Session;
    requestObjectSessionData: RequestObjectSessionData | undefined;
    requestObjectJwkThumbprint: Uint8Array | undefined;
    verifyOptions: VerifierOptions;
    dcqlCredential: CredentialQueryValue;
    claimSelections: ClaimsQuery[][];
    hasClaimSets: boolean;
    requiredClaimKeys: string[];
};

/**
 * Verifies the credentials of an OID4VP presentation response against the
 * presentation config's DCQL query.
 *
 * Presentation configuration CRUD lives in `PresentationConfigService`,
 * registration certificates in `RegistrationCertificateService`, and the
 * DCQL claim rules in `domain/dcql-claim-policy.ts`.
 */
@Injectable()
export class PresentationsService {
    constructor(
        private readonly credentialVerifierFormats: CredentialVerifierFormatRegistry,
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
        private readonly trustedAuthorities: TrustedAuthoritiesService,
        private readonly logger: PinoLogger,
        private readonly traceService: TraceService,
    ) {
        this.logger.setContext(PresentationsService.name);
    }

    /**
     * Parse the response from the wallet. It verifies every credential in the
     * vp_token and returns the disclosed claims per DCQL credential id.
     */
    @Span("presentations.parseResponse")
    async parseResponse(
        res: AuthResponse,
        presentationConfig: PresentationConfig,
        session: Session,
    ) {
        // Add session context to logs (Loki) and span attributes (Tempo)
        // assign() requires nestjs-pino request scope; the @Span decorator may
        // run the method in a separate AsyncLocalStorage context, so guard it.
        try {
            this.logger.assign({ sessionId: session.id });
        } catch {
            // Outside HTTP request scope — sessionId won't appear in logs,
            // but span attributes below still carry it for Tempo.
        }
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        const attestationIds = Object.keys(res.vp_token);
        const host = this.settings.publicUrl;
        const tenantHost = `${host}/issuers/${presentationConfig.tenantId}`;

        // Validate credential completeness - ensure all required credentials are present
        const missingCredentials = findMissingCredentials(
            attestationIds,
            presentationConfig.dcql_query.credentials,
            presentationConfig.dcql_query.credential_sets,
        );
        if (missingCredentials) {
            throw incompletePresentation(missingCredentials);
        }

        // Get transaction_data from the request object JWT payload
        // This ensures we use the exact same encoded strings that were sent to the wallet
        let transactionDataStrings: string[] | undefined;
        let requestObjectSessionData: RequestObjectSessionData | undefined;
        let requestObjectJwkThumbprint: Uint8Array | undefined;
        if (session.requestObject) {
            const requestPayload = decodeJwt(session.requestObject) as {
                transaction_data?: string[];
                nonce?: string;
                client_id?: string;
                response_uri?: string;
                response_mode?: string;
                client_metadata?: {
                    jwks?: { keys?: Array<Record<string, any>> };
                };
            };
            transactionDataStrings = requestPayload.transaction_data;
            requestObjectSessionData = requestPayload;
            requestObjectJwkThumbprint =
                this.responseEncryptionJwkThumbprint(requestPayload);
        }

        const results = await Promise.all(
            attestationIds.map(async (attId) => {
                const credentials = res.vp_token[attId] as unknown as string[];
                const dcqlCredential =
                    presentationConfig.dcql_query.credentials.find(
                        (c) => c.id === attId,
                    );

                if (!dcqlCredential) {
                    throw new ConflictException(
                        `${attId} not found in the presentation config`,
                    );
                }

                // Find transaction data entries that reference this credential
                // The strings are already base64url-encoded from the request object
                // We need to decode them to check credential_ids, then use the original encoded string for hash validation
                const relevantTransactionData = transactionDataStrings?.filter(
                    (tdStr) => {
                        try {
                            const td = JSON.parse(
                                Buffer.from(base64url.decode(tdStr)).toString(),
                            ) as { credential_ids?: string[] };
                            return td.credential_ids?.includes(attId);
                        } catch {
                            return false;
                        }
                    },
                );

                const loteAuthorities =
                    dcqlCredential.trusted_authorities?.find(
                        (auth): auth is TrustedAuthorityQueryEtsiTl =>
                            auth.type === TrustedAuthorityType.ETSI_TL,
                    );

                const federationAuthorities =
                    dcqlCredential.trusted_authorities?.find(
                        (auth): auth is TrustedAuthorityQueryOpenIdFederation =>
                            auth.type ===
                            TrustedAuthorityType.OPENID_FEDERATION,
                    );

                const resolvedLoteAuthorities = await this.trustedAuthorities
                    .resolveTrustListRefsForTenant(
                        loteAuthorities?.values,
                        session.tenantId,
                        tenantHost,
                    )
                    .catch((error: unknown) => {
                        if (error instanceof InvalidTrustedAuthoritiesError) {
                            throw new BadRequestException(error.message);
                        }
                        throw error;
                    });

                const verifyOptions: VerifierOptions = {
                    trustListSource: {
                        lotes: resolvedLoteAuthorities,
                        acceptedServiceTypes: [
                            ServiceTypeIdentifier.EaaIssuance,
                            ServiceTypeIdentifier.PIDIssuance,
                        ],
                        tenantId: session.tenantId,
                    },
                    federationTrustSource: federationAuthorities?.values.length
                        ? {
                              mode: "hybrid",
                              trustAnchors: federationAuthorities.values.map(
                                  (value) => ({
                                      entityId: value,
                                      entityConfigurationUri: `${value.replace(/\/$/, "")}/.well-known/openid-federation`,
                                  }),
                              ),
                          }
                        : undefined,
                    policy: {
                        requireX5c: true,
                        revocation: revocationModeToPolicy(
                            presentationConfig.statusCheckMode,
                        ),
                    },
                    skewSeconds:
                        session.skewSeconds ??
                        presentationConfig.skewSeconds ??
                        DEFAULT_VERIFIER_SKEW_SECONDS,
                    // Pass transaction data for hash validation (only for credentials that have it)
                    transactionData: relevantTransactionData,
                    ts12TransactionData: relevantTransactionData?.some(
                        (tdStr) => {
                            try {
                                const transactionData = JSON.parse(
                                    Buffer.from(
                                        base64url.decode(tdStr),
                                    ).toString(),
                                ) as { type?: string };
                                return (
                                    transactionData.type?.startsWith(
                                        "urn:eudi:sca:",
                                    ) ?? false
                                );
                            } catch {
                                return false;
                            }
                        },
                    ),
                    keyBindingResponseMode:
                        requestObjectSessionData?.response_mode,
                };

                const type = this.getType(session.requestObject!, attId);

                const options: CredentialValueOptions = {
                    cred: "",
                    attId,
                    session,
                    requestObjectSessionData,
                    requestObjectJwkThumbprint,
                    verifyOptions,
                    dcqlCredential,
                    // Extract required claim keys from DCQL claims
                    requiredClaimKeys: requiredClaimKeys(
                        dcqlCredential.claims,
                        type,
                    ),
                    claimSelections: resolveClaimSelections(dcqlCredential),
                    hasClaimSets:
                        !!dcqlCredential.claim_sets &&
                        dcqlCredential.claim_sets.length > 0,
                };

                const values = await Promise.all(
                    credentials.map((cred) =>
                        this.verifyCredentialValue(type, { ...options, cred }),
                    ),
                );

                return { id: attId, values };
            }),
        );

        return results;
    }

    /**
     * Per ISO 18013-7 / OpenID4VP, OID4VPHandoverInfo carries the SHA-256
     * JWK thumbprint of the verifier's response encryption key (the one in
     * client_metadata.jwks used to encrypt the JARM response). The wallet
     * computes this when constructing DeviceAuthentication, so we must
     * match it here.
     */
    private responseEncryptionJwkThumbprint(requestPayload: {
        client_metadata?: { jwks?: { keys?: Array<Record<string, any>> } };
    }): Uint8Array | undefined {
        try {
            const jwks = requestPayload.client_metadata?.jwks?.keys;
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

    private resolveSdJwtKeyBindingAudience(
        session: Session,
        requestObjectSessionData: RequestObjectSessionData | undefined,
    ): string | undefined {
        const defaultAudience =
            requestObjectSessionData?.client_id ?? session.clientId;

        if (!session.useDcApi) {
            return defaultAudience;
        }

        const expectedOrigin = requestObjectSessionData?.expected_origins?.[0];
        const normalizedOrigin = normalizeDcApiOrigin(expectedOrigin);
        if (normalizedOrigin) {
            return `origin:${normalizedOrigin}`;
        }

        this.logger.warn(
            {
                sessionId: session.id,
                expectedOrigin,
                defaultAudience,
            },
            "Missing or invalid expected_origin for DC API; falling back to client_id for SD-JWT key binding audience",
        );
        return defaultAudience;
    }

    /**
     * Get the credential format of a DCQL credential id from the request object.
     */
    private getType(jwt: string, att: string): VerifierCredentialFormat {
        const payload = decodeJwt<any>(jwt);
        return payload.dcql_query.credentials.find(
            (credential: { id: string; format: VerifierCredentialFormat }) =>
                credential.id === att,
        ).format;
    }

    private async verifyCredentialValue(
        type: VerifierCredentialFormat,
        options: CredentialValueOptions,
    ): Promise<Record<string, unknown>> {
        if (type === "mso_mdoc") {
            return this.verifyMdocCredentialValue(options);
        }

        if (type === "dc+sd-jwt") {
            return this.verifySdJwtCredentialValue(options);
        }

        throw new ConflictException(`Unsupported credential type: ${type}`);
    }

    private async verifyMdocCredentialValue(
        options: CredentialValueOptions,
    ): Promise<Record<string, unknown>> {
        // DC API flows use the OID4VPDCAPIHandover transcript (origin + nonce),
        // while classic OID4VP uses OpenID4VPHandover (clientId + responseUri + nonce).
        // Passing the wrong protocol makes DeviceAuth verification fail.
        const sessionData: MdocSessionDataOid4vp | MdocSessionDataDcApi =
            options.session.useDcApi
                ? {
                      protocol: "dc_api" as const,
                      nonce:
                          options.requestObjectSessionData?.nonce ??
                          (options.session.vp_nonce as string),
                      origin:
                          options.requestObjectSessionData
                              ?.expected_origins?.[0] ?? "",
                      jwkThumbprint: options.requestObjectJwkThumbprint,
                  }
                : {
                      protocol: "openid4vp" as const,
                      nonce:
                          options.requestObjectSessionData?.nonce ??
                          (options.session.vp_nonce as string),
                      clientId:
                          options.requestObjectSessionData?.client_id ??
                          options.session.clientId!,
                      responseUri:
                          options.requestObjectSessionData?.response_uri ??
                          options.session.responseUri!,
                      responseMode:
                          options.requestObjectSessionData?.response_mode ??
                          "direct_post.jwt",
                      jwkThumbprint: options.requestObjectJwkThumbprint,
                  };
        if (options.hasClaimSets) {
            return this.verifyMdocCredentialWithClaimSets(options, sessionData);
        }

        const result = await this.credentialVerifierFormats
            .resolve("mso_mdoc")
            .verify(
                options.cred,
                sessionData,
                options.verifyOptions,
                options.dcqlCredential.claims?.map((claim) => claim.path),
            );

        if (!result.verified) {
            this.throwMdocVerificationFailure(options.attId, result);
        }

        this.logMdocClaimChecks(
            options.attId,
            options.dcqlCredential.claims,
            result.claims,
        );
        const missingClaims = findMissingMdocClaims(
            options.attId,
            options.dcqlCredential.claims,
            result.claims,
        );
        if (missingClaims) {
            throw incompletePresentation(missingClaims);
        }

        return result.claims;
    }

    private async verifyMdocCredentialWithClaimSets(
        options: CredentialValueOptions,
        sessionData: MdocSessionDataOid4vp | MdocSessionDataDcApi,
    ): Promise<Record<string, unknown>> {
        let lastVerificationFailure:
            | {
                  failureType?: VerificationFailureType;
                  failureReason?: string;
              }
            | undefined;

        for (const selectedClaims of options.claimSelections) {
            let result;

            try {
                result = await this.credentialVerifierFormats
                    .resolve("mso_mdoc")
                    .verify(
                        options.cred,
                        sessionData,
                        options.verifyOptions,
                        selectedClaims.map((claim) => claim.path),
                    );
            } catch (error) {
                lastVerificationFailure = {
                    failureType: "verification_error",
                    failureReason:
                        error instanceof Error ? error.message : undefined,
                };

                continue;
            }

            if (!result.verified) {
                lastVerificationFailure = result;
                continue;
            }

            if (matchesMdocClaimSelection(result.claims, selectedClaims)) {
                return result.claims;
            }
        }

        if (lastVerificationFailure) {
            this.throwMdocVerificationFailure(
                options.attId,
                lastVerificationFailure,
            );
        }

        throw incompletePresentation(
            claimSetNotSatisfied(options.dcqlCredential),
        );
    }

    private async verifySdJwtCredentialValue(
        options: CredentialValueOptions,
    ): Promise<Record<string, unknown>> {
        const checkedClaimKeys = options.hasClaimSets
            ? []
            : options.requiredClaimKeys;
        const result = await this.credentialVerifierFormats
            .resolve("dc+sd-jwt")
            .verify(options.cred, {
                requiredClaimKeys: checkedClaimKeys,
                keyBindingNonce: options.session.vp_nonce!,
                keyBindingAudience: this.resolveSdJwtKeyBindingAudience(
                    options.session,
                    options.requestObjectSessionData,
                ),
                ...options.verifyOptions,
            });

        if (options.hasClaimSets) {
            const matchingSelection = options.claimSelections.find(
                (selectedClaims) =>
                    matchesClaimSelection(
                        (result.payload ?? {}) as Record<string, unknown>,
                        options.dcqlCredential.claims,
                        selectedClaims,
                    ),
            );

            if (!matchingSelection) {
                throw incompletePresentation(
                    claimSetNotSatisfied(options.dcqlCredential),
                );
            }
        }

        this.logger.debug(
            {
                credentialId: options.attId,
                requiredClaimKeys: checkedClaimKeys,
                disclosedClaimKeys: Object.keys(result.payload ?? {}),
            },
            "SD-JWT-VC disclosed claims after verification",
        );
        this.logger.trace(
            {
                credentialId: options.attId,
                requiredClaimKeys: checkedClaimKeys,
                disclosedClaims: result.payload,
            },
            "[TRACE] SD-JWT-VC full disclosed claims payload",
        );

        return {
            ...result.payload,
            cnf: undefined,
            status: undefined,
        };
    }

    private logMdocClaimChecks(
        credentialId: string,
        requestedClaims: ClaimsQuery[] | undefined,
        receivedClaims: Record<string, unknown>,
    ): void {
        for (const claim of requestedClaims ?? []) {
            const claimName = mdocClaimName(claim.path);
            this.logger.debug(
                {
                    credentialId,
                    claimName,
                    receivedClaimKeys: Object.keys(receivedClaims),
                },
                "Validating mDOC claim presence",
            );
            this.logger.trace(
                { credentialId, claimName, receivedClaims },
                "[TRACE] mDOC full received claims payload",
            );
        }
    }

    private throwMdocVerificationFailure(
        attId: string,
        result: {
            failureType?: VerificationFailureType;
            failureReason?: string;
        },
    ): never {
        const reasonByType: Record<VerificationFailureType, string> = {
            signature_invalid: "mDOC signature is invalid",
            no_trust_chain_to_root:
                "no trust chain to a trusted root could be built",
            trust_chain_not_trusted:
                "certificate chain does not match any trusted entity",
            trust_list_unavailable:
                "the configured trust list could not be loaded",
            certificate_expired:
                "the issuer certificate is expired or not yet valid",
            x5c_missing:
                "credential does not include an x5c chain but it is required",
            verification_error: "mDOC verification failed",
        };

        // Failures are classified at the source (classifyVerificationError /
        // mapChainErrorToFailureType in the mDOC verifier), so the reason maps
        // straight off failureType.
        const reason =
            (result.failureType
                ? reasonByType[result.failureType]
                : undefined) || "mDOC verification failed";

        this.logger.warn(
            {
                credentialId: attId,
                failureType: result.failureType,
                failureReason: result.failureReason,
            },
            "mDOC verification failed",
        );

        throw new BadRequestException(
            `mDOC verification failed for credential "${attId}": ${reason}`,
        );
    }
}

function incompletePresentation(
    violation: IncompletePresentation,
): IncompletePresentationException {
    return new IncompletePresentationException(
        violation.message,
        violation.details,
    );
}

function resolveClaimSelections(
    credential: CredentialQueryValue,
): ClaimsQuery[][] {
    try {
        return claimSelections(credential);
    } catch (error) {
        if (error instanceof UnknownClaimSetReferenceError) {
            throw new BadRequestException(error.message);
        }
        throw error;
    }
}

function normalizeDcApiOrigin(origin: string | undefined): string | undefined {
    if (!origin) {
        return undefined;
    }

    const trimmed = origin.trim();
    if (!trimmed) {
        return undefined;
    }

    const withoutPrefix = trimmed.startsWith("origin:")
        ? trimmed.slice("origin:".length)
        : trimmed;
    const withProtocol = /^https?:\/\//i.test(withoutPrefix)
        ? withoutPrefix
        : `http://${withoutPrefix}`;

    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return undefined;
        }

        return parsed.origin;
    } catch {
        return undefined;
    }
}
