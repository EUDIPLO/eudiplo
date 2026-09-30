/**
 * DCQL presentation policy: which credentials and claims a presentation
 * response must contain to satisfy the DCQL query of a presentation config.
 *
 * Pure functions without framework or format-library dependencies. The
 * caller verifies credentials and decides how a violation is reported.
 */

export type VerifierCredentialFormat = "dc+sd-jwt" | "mso_mdoc";

/** The subset of a DCQL claims query the policy needs. */
export interface DcqlClaimQuery {
    id?: string;
    path: string[];
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

/** Why a presentation does not satisfy the DCQL query. */
export interface IncompletePresentation {
    message: string;
    details: {
        missingCredentials?: string[];
        missingClaims?: Record<string, string[]>;
        unsatisfiedCredentialSets?: number[];
    };
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

/**
 * Returns the requested mdoc claims (as dotted full paths) that are absent
 * from the verified claims.
 */
export function missingMdocClaims(
    requestedClaims: DcqlClaimQuery[] | undefined,
    receivedClaims: Record<string, unknown>,
): string[] {
    return (requestedClaims ?? [])
        .filter((claim) => !(mdocClaimName(claim.path) in receivedClaims))
        .map((claim) => claim.path.join("."));
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

/** Whether a disclosed SD-JWT VC payload contains every selected claim path. */
export function matchesClaimSelection(
    payload: Record<string, unknown>,
    allClaims: DcqlClaimQuery[] | undefined,
    selectedClaims: DcqlClaimQuery[],
): boolean {
    if (!allClaims || allClaims.length === 0) {
        return selectedClaims.length === 0;
    }

    return selectedClaims.every((claim) => hasClaimPath(payload, claim.path));
}

/** Whether verified mdoc claims contain every selected element. */
export function matchesMdocClaimSelection(
    claims: Record<string, unknown>,
    selectedClaims: DcqlClaimQuery[],
): boolean {
    return selectedClaims.every((claim) => mdocClaimName(claim.path) in claims);
}

/**
 * Whether `value` has a defined value at `path`. Numeric segments index into
 * arrays.
 */
export function hasClaimPath(value: unknown, path: string[]): boolean {
    let current: unknown = value;

    for (const segment of path) {
        if (current === null || current === undefined) {
            return false;
        }

        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0) {
                return false;
            }

            current = current[index];
            continue;
        }

        if (typeof current !== "object") {
            return false;
        }

        if (!(segment in current)) {
            return false;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current !== undefined;
}
