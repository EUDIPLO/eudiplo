import { decodeJwt } from "jose";
import type { SessionData } from "../../../session/domain/session-data.js";
import type {
    RevocationCheckMode,
    VerifierOptions,
} from "../../../trust/types.js";
import type { AuthResponseData } from "../domain/auth-response.js";
import type {
    CredentialVerificationFailure,
    Oid4vpPresentationBinding,
    SignedRequestValues,
} from "../domain/credential-verifier-format.js";
import {
    claimSelections,
    claimSetNotSatisfied,
    claimValueMismatchViolation,
    type DcqlCredentialQuery,
    type DcqlCredentialSetQuery,
    findMissingCredentials,
    type IncompletePresentation,
    missingClaimsViolation,
    type VerifierCredentialFormat,
} from "../domain/dcql-claim-policy.js";
import { verifyTransactionDataBinding } from "../domain/transaction-data-binding.js";
import { missingTrustedAuthorities } from "../domain/trusted-authority-requirement.js";
import {
    type DcqlTrustedAuthority,
    trustListAuthorities,
    verifierTrustOptions,
} from "../domain/verifier-trust-options.js";
import {
    InvalidTrustedAuthoritiesError,
    type TrustListRefResolver,
} from "../ports/trust-list-ref-resolver.js";
import type { PresentationSettings } from "../presentation-settings.js";
import type { CredentialVerifierFormatRegistry } from "./credential-verifier-format-registry.js";

/** The parts of a presentation config the verification needs. */
export interface PresentationQuery {
    tenantId: string;
    statusCheckMode?: RevocationCheckMode;
    skewSeconds?: number;
    dcql_query: {
        credentials: Array<
            DcqlCredentialQuery & {
                trusted_authorities?: DcqlTrustedAuthority[];
            }
        >;
        credential_sets?: DcqlCredentialSetQuery[];
    };
}

/** Disclosed claims of every presented credential, per DCQL credential id. */
export type VerifiedPresentation = Array<{
    id: string;
    values: Record<string, unknown>[];
}>;

/**
 * The response does not satisfy the DCQL query: missing credentials or
 * claims, or claims without a requested value.
 */
export class IncompletePresentationError extends Error {
    readonly code: IncompletePresentation["code"];
    readonly details: IncompletePresentation["details"];

    constructor(violation: IncompletePresentation) {
        super(violation.message);
        this.name = "IncompletePresentationError";
        this.code = violation.code;
        this.details = violation.details;
    }
}

/** The `vp_token` contains a credential id that the DCQL query does not define. */
export class UnknownPresentedCredentialError extends Error {
    constructor(readonly credentialId: string) {
        super(`${credentialId} not found in the presentation config`);
        this.name = "UnknownPresentedCredentialError";
    }
}

/**
 * The `vp_token` contains several presentations for a credential query that
 * does not set `multiple: true` (DCQL defaults `multiple` to false).
 */
export class MultiplePresentationsNotAllowedError extends Error {
    constructor(
        readonly credentialId: string,
        readonly count: number,
    ) {
        super(
            `${credentialId} allows a single presentation, but ${count} were presented`,
        );
        this.name = "MultiplePresentationsNotAllowedError";
    }
}

/** A presented credential failed signature, holder-binding or trust checks. */
export class CredentialVerificationFailedError extends Error {
    constructor(
        readonly credentialId: string,
        readonly failure: CredentialVerificationFailure,
        /** Format and, when known, mdoc docType of the failed credential. */
        readonly credential: { format?: string; docType?: string } = {},
    ) {
        super(failure.message);
        this.name = "CredentialVerificationFailedError";
    }
}

/**
 * Verifies every credential in the `vp_token` of an OID4VP response against
 * the presentation config's DCQL query and returns the disclosed claims.
 *
 * Checks, in order: every credential query names a trusted authority (unless
 * `SKIP_TRUST_AUTHORITY`), so a config stored before 9.0 without one does
 * not verify without an issuer check; all required credentials are present
 * with at least one presentation; per credential id, it is part of the query,
 * it has a single presentation unless the query allows `multiple`, its
 * trusted authorities resolve, its claim sets are well formed; then every
 * presented value is verified by its format and must disclose the requested
 * claims (or one claim set) with one of their requested `values`. A value
 * mismatch is reported before missing claims. Once every credential is
 * verified, the request's transaction data must be authorized by the
 * presentations it references (see `verifyTransactionDataBinding`).
 *
 * Throws the errors above, `UnknownClaimSetReferenceError`,
 * `TransactionDataBindingError`,
 * `UnsupportedCredentialVerifierFormat`, `InvalidTrustedAuthoritiesError`, or
 * whatever a format throws (for example SD-JWT VC verification errors).
 */
export class VerifyPresentationResponse {
    constructor(
        private readonly formats: CredentialVerifierFormatRegistry,
        private readonly trustLists: TrustListRefResolver,
        private readonly settings: PresentationSettings,
    ) {}

    async execute(
        response: AuthResponseData,
        query: PresentationQuery,
        session: SessionData,
    ): Promise<VerifiedPresentation> {
        // Only credential ids with at least one presentation count as
        // received; an empty array would otherwise satisfy the query unverified.
        const credentialIds = Object.keys(response.vp_token).filter(
            (credentialId) => response.vp_token[credentialId].length > 0,
        );
        const tenantHost = `${this.settings.publicUrl}/issuers/${query.tenantId}`;

        const missingAuthorities = missingTrustedAuthorities(
            query.dcql_query.credentials,
            this.settings.skipTrustAuthority,
        );
        if (missingAuthorities) {
            throw new InvalidTrustedAuthoritiesError(missingAuthorities);
        }

        const missingCredentials = findMissingCredentials(
            credentialIds,
            query.dcql_query.credentials,
            query.dcql_query.credential_sets,
        );
        if (missingCredentials) {
            throw new IncompletePresentationError(missingCredentials);
        }

        // Use the request object the wallet received, so transaction_data
        // strings hash exactly as sent and the holder binding matches.
        let transactionDataStrings: string[] | undefined;
        let request: SignedRequestValues | undefined;
        if (session.requestObject) {
            const requestPayload = decodeJwt(
                session.requestObject,
            ) as SignedRequestValues & { transaction_data?: string[] };
            transactionDataStrings = requestPayload.transaction_data;
            request = requestPayload;
        }

        const binding: Oid4vpPresentationBinding = {
            protocol: "openid4vp",
            sessionId: session.id,
            useDcApi: !!session.useDcApi,
            sessionNonce: session.vp_nonce,
            sessionClientId: session.clientId,
            sessionResponseUri: session.responseUri,
            request,
        };

        const verified = await Promise.all(
            credentialIds.map(async (credentialId) => {
                const presented = response.vp_token[credentialId];
                const credentialQuery = query.dcql_query.credentials.find(
                    (c) => c.id === credentialId,
                );
                if (!credentialQuery) {
                    throw new UnknownPresentedCredentialError(credentialId);
                }
                if (!credentialQuery.multiple && presented.length > 1) {
                    throw new MultiplePresentationsNotAllowedError(
                        credentialId,
                        presented.length,
                    );
                }

                const trustLists =
                    await this.trustLists.resolveTrustListRefsForTenant(
                        trustListAuthorities(
                            credentialQuery.trusted_authorities,
                        ),
                        session.tenantId,
                        tenantHost,
                    );
                const options: VerifierOptions = verifierTrustOptions({
                    trustLists,
                    tenantId: session.tenantId,
                    authorities: credentialQuery.trusted_authorities,
                    statusCheckMode: query.statusCheckMode,
                    skewSeconds: session.skewSeconds ?? query.skewSeconds,
                });

                const format = requestedFormat(
                    session.requestObject!,
                    credentialId,
                );
                // Throws UnknownClaimSetReferenceError for a malformed query.
                const selections = claimSelections(credentialQuery);
                const hasClaimSets =
                    !!credentialQuery.claim_sets &&
                    credentialQuery.claim_sets.length > 0;

                const results = await Promise.all(
                    presented.map(async (credential, index) => {
                        const result = await this.formats
                            .resolve(format)
                            .verify(credential, {
                                credentialId,
                                binding,
                                options,
                                claims: credentialQuery.claims,
                                claimSets: hasClaimSets
                                    ? selections
                                    : undefined,
                            });

                        if (!result.verified) {
                            throw new CredentialVerificationFailedError(
                                credentialId,
                                result.failure,
                                { format, docType: result.docType },
                            );
                        }
                        if (result.mismatchedClaims.length > 0) {
                            throw new IncompletePresentationError(
                                claimValueMismatchViolation(
                                    credentialId,
                                    result.mismatchedClaims,
                                ),
                            );
                        }
                        if (result.claimSetSatisfied === false) {
                            throw new IncompletePresentationError(
                                claimSetNotSatisfied(credentialQuery),
                            );
                        }
                        if (result.missingClaims.length > 0) {
                            throw new IncompletePresentationError(
                                missingClaimsViolation(
                                    credentialId,
                                    result.missingClaims,
                                ),
                            );
                        }
                        return {
                            claims: result.claims,
                            presentation: result.keyBinding && {
                                credentialId,
                                index,
                                keyBinding: result.keyBinding,
                            },
                        };
                    }),
                );

                return {
                    id: credentialId,
                    values: results.map(({ claims }) => claims),
                    presentations: results.flatMap(({ presentation }) =>
                        presentation ? [presentation] : [],
                    ),
                };
            }),
        );

        // An entry may reference several credentials, of which the wallet
        // uses one to authorize it (OID4VP 1.0 §5.1), so the hashes are
        // checked across all presentations.
        await verifyTransactionDataBinding({
            transactionData: transactionDataStrings,
            presentations: verified.flatMap(
                ({ presentations }) => presentations,
            ),
            responseMode: request?.response_mode,
        });

        return verified.map(({ id, values }) => ({ id, values }));
    }
}

/** The credential format of a DCQL credential id as sent in the request object. */
function requestedFormat(
    requestObject: string,
    credentialId: string,
): VerifierCredentialFormat {
    const payload = decodeJwt<any>(requestObject);
    return payload.dcql_query.credentials.find(
        (credential: { id: string; format: VerifierCredentialFormat }) =>
            credential.id === credentialId,
    ).format;
}
