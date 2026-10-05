/**
 * DCQL presentation policy: which credentials and claims (with which
 * values) a presentation response must contain to satisfy the DCQL query of
 * a presentation config.
 *
 * Pure functions without framework or format-library dependencies. The
 * caller verifies credentials and decides how a violation is reported.
 */

export type VerifierCredentialFormat = "dc+sd-jwt" | "mso_mdoc";

/** A value a DCQL claims query can require (OID4VP 1.0 §6.3). */
type DcqlClaimValue = string | number | boolean;

/** The subset of a DCQL claims query the policy needs. */
export interface DcqlClaimQuery {
    id?: string;
    path: string[];
    /** The disclosed value must equal one of these (same type and value). */
    values?: DcqlClaimValue[];
}

/** The subset of a DCQL credential query the policy needs. */
export interface DcqlCredentialQuery {
    id: string;
    multiple?: boolean;
    claims?: DcqlClaimQuery[];
    claim_sets?: string[][];
}

/** The subset of a DCQL credential set query the policy needs. */
export interface DcqlCredentialSetQuery {
    options: string[][];
    required?: boolean;
}

/** Failure code of a disclosed claim whose value is not one of its `values`. */
export const CLAIM_VALUE_MISMATCH = "claim_value_mismatch";

/** Why a presentation does not satisfy the DCQL query. */
export interface IncompletePresentation {
    /** Stable failure code for the session outcome, when there is one. */
    code?: typeof CLAIM_VALUE_MISMATCH;
    message: string;
    details: {
        missingCredentials?: string[];
        missingClaims?: Record<string, string[]>;
        mismatchedClaims?: Record<string, string[]>;
        unsatisfiedCredentialSets?: number[];
    };
}

/**
 * How disclosed claims fail a claim selection, as dotted claim paths: claims
 * that are not disclosed, and disclosed claims whose value is not one of the
 * requested `values`.
 */
export interface ClaimSelectionResult {
    missing: string[];
    mismatched: string[];
}

/** A `claim_sets` entry references a claim id that is not defined. */
export class UnknownClaimSetReferenceError extends Error {
    constructor(claimId: string, credentialId: string) {
        super(
            `claim_sets references unknown claim id '${claimId}' for credential '${credentialId}'`,
        );
        this.name = "UnknownClaimSetReferenceError";
    }
}

/**
 * Checks that the response contains all required credentials.
 * With `credential_sets`, every required set needs at least one fully
 * present option; without them, every credential in the query is required.
 */
export function findMissingCredentials(
    receivedCredentialIds: string[],
    credentials: DcqlCredentialQuery[],
    credentialSets?: DcqlCredentialSetQuery[],
): IncompletePresentation | undefined {
    const received = new Set(receivedCredentialIds);

    if (credentialSets && credentialSets.length > 0) {
        const unsatisfiedSets: number[] = [];
        credentialSets.forEach((credentialSet, index) => {
            // Default to required if not explicitly set to false
            if (credentialSet.required === false) {
                return;
            }
            const isSatisfied = credentialSet.options.some((option) =>
                option.every((credentialId) => received.has(credentialId)),
            );
            if (!isSatisfied) {
                unsatisfiedSets.push(index);
            }
        });

        if (unsatisfiedSets.length === 0) {
            return undefined;
        }
        return {
            message: `Credential sets not satisfied: ${unsatisfiedSets.map((i) => `set[${i}]`).join(", ")}`,
            details: { unsatisfiedCredentialSets: unsatisfiedSets },
        };
    }

    const missingCredentials = credentials
        .map((credential) => credential.id)
        .filter((id) => !received.has(id));
    if (missingCredentials.length === 0) {
        return undefined;
    }
    return {
        message: `Missing required credentials: ${missingCredentials.join(", ")}`,
        details: { missingCredentials },
    };
}

/**
 * Converts DCQL claim queries to the claim keys the SD-JWT VC verifier checks:
 * paths joined with dots (`["address", "locality"]` → `"address.locality"`).
 */
export function sdJwtRequiredClaimKeys(
    claims: DcqlClaimQuery[] | undefined,
): string[] {
    return (claims ?? []).map((claim) => claim.path.join("."));
}

/**
 * The element name of an mdoc claim path: `[namespace, element]` or `[element]`.
 * The mdoc verifier flattens claims from all namespaces.
 */
export function mdocClaimName(path: string[]): string {
    return path.length > 1 ? path[1] : path[0];
}

/** The violation reported when requested claims (dotted paths) are not disclosed. */
export function missingClaimsViolation(
    credentialId: string,
    missingClaims: string[],
): IncompletePresentation {
    return {
        message: `Missing required claims for credential '${credentialId}': ${missingClaims.join(", ")}`,
        details: { missingClaims: { [credentialId]: missingClaims } },
    };
}

/**
 * The violation reported when disclosed claims (dotted paths) do not have
 * one of the requested values. The values themselves are never included.
 */
export function claimValueMismatchViolation(
    credentialId: string,
    mismatchedClaims: string[],
): IncompletePresentation {
    return {
        code: CLAIM_VALUE_MISMATCH,
        message: `Disclosed claim values do not match the requested values for credential '${credentialId}': ${mismatchedClaims.join(", ")}`,
        details: { mismatchedClaims: { [credentialId]: mismatchedClaims } },
    };
}

/** The violation reported when no `claim_sets` option is satisfied. */
export function claimSetNotSatisfied(
    credential: DcqlCredentialQuery,
): IncompletePresentation {
    return {
        message: `Credential "${credential.id}" does not satisfy any claim_set`,
        details: {
            missingClaims: {
                [credential.id]:
                    credential.claims?.map((claim) => claim.path.join(".")) ??
                    [],
            },
        },
    };
}

/**
 * The alternative claim selections of a credential query: one selection per
 * `claim_sets` option, or all claims when there are no claim sets.
 *
 * @throws UnknownClaimSetReferenceError for an undefined claim id.
 */
export function claimSelections<Claim extends DcqlClaimQuery>(credential: {
    id: string;
    claims?: Claim[];
    claim_sets?: string[][];
}): Claim[][] {
    const claims = credential.claims ?? [];

    if (!credential.claim_sets || credential.claim_sets.length === 0) {
        return [claims];
    }

    const claimsById = new Map(
        claims
            .filter(
                (claim) =>
                    typeof claim.id === "string" && claim.id.trim() !== "",
            )
            .map((claim) => [claim.id as string, claim] as const),
    );

    return credential.claim_sets.map((claimSet) =>
        claimSet.map((claimId) => {
            const claim = claimsById.get(claimId);
            if (!claim) {
                throw new UnknownClaimSetReferenceError(claimId, credential.id);
            }
            return claim;
        }),
    );
}

/**
 * Checks the selected claims against a disclosed SD-JWT VC payload: each
 * path must select at least one value, and with `values` one of the selected
 * values must be requested.
 */
export function evaluateClaimSelection(
    payload: Record<string, unknown>,
    selectedClaims: DcqlClaimQuery[],
): ClaimSelectionResult {
    return evaluate(selectedClaims, (claim) =>
        selectClaimValues(payload, claim.path),
    );
}

/**
 * Checks the selected claims against verified mdoc claims, matched by
 * element name (see {@link mdocClaimName}).
 */
export function evaluateMdocClaimSelection(
    claims: Record<string, unknown>,
    selectedClaims: DcqlClaimQuery[],
): ClaimSelectionResult {
    return evaluate(selectedClaims, (claim) => {
        const name = mdocClaimName(claim.path);
        return Object.hasOwn(claims, name) ? [claims[name]] : [];
    });
}

/** Whether a claim selection is disclosed with requested values only. */
export function isClaimSelectionSatisfied(
    result: ClaimSelectionResult,
): boolean {
    return result.missing.length === 0 && result.mismatched.length === 0;
}

function evaluate(
    selectedClaims: DcqlClaimQuery[],
    disclosedValues: (claim: DcqlClaimQuery) => unknown[],
): ClaimSelectionResult {
    const result: ClaimSelectionResult = { missing: [], mismatched: [] };
    for (const claim of selectedClaims) {
        const disclosed = disclosedValues(claim);
        const requested = claim.values;
        if (disclosed.length === 0) {
            result.missing.push(claim.path.join("."));
        } else if (
            requested &&
            !disclosed.some((value) => isRequestedValue(value, requested))
        ) {
            result.mismatched.push(claim.path.join("."));
        }
    }
    return result;
}

/**
 * Whether a disclosed value equals one of the requested values in type and
 * value: `"true"` does not match `true`, nor `"18"` match `18`.
 */
function isRequestedValue(
    disclosed: unknown,
    values: readonly DcqlClaimValue[],
): boolean {
    return values.some((value) => value === disclosed);
}

/**
 * A DCQL claims path pointer. Config paths are strings; numbers and `null`
 * come from the OID4VP JSON form.
 */
type ClaimPath = ReadonlyArray<string | number | null>;

/**
 * The values a claims path pointer selects in `value` (OID4VP 1.0 §7.1): a
 * string selects an object key, a non-negative integer (or numeric string)
 * an array element, and `null` every array element. Undefined values count
 * as not selected; an empty result means the claim is not disclosed.
 */
export function selectClaimValues(value: unknown, path: ClaimPath): unknown[] {
    let selected: unknown[] = [value];
    for (const segment of path) {
        selected = selected.flatMap((current) =>
            selectPathSegment(current, segment),
        );
    }
    return selected.filter((current) => current !== undefined);
}

function selectPathSegment(
    current: unknown,
    segment: string | number | null,
): unknown[] {
    if (Array.isArray(current)) {
        if (segment === null) {
            return current;
        }
        const index = arrayIndex(segment);
        return index !== undefined && index < current.length
            ? [current[index]]
            : [];
    }

    if (
        segment === null ||
        current === null ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
    ) {
        return [];
    }
    return [(current as Record<string | number, unknown>)[segment]];
}

function arrayIndex(segment: string | number): number | undefined {
    const index =
        typeof segment === "number"
            ? segment
            : /^\d+$/.test(segment)
              ? Number(segment)
              : Number.NaN;
    return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}
