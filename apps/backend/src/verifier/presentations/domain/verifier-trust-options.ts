import { revocationModeToPolicy } from "../../../trust/revocation-policy.util.js";
import {
    DEFAULT_VERIFIER_SKEW_SECONDS,
    type RevocationCheckMode,
    ServiceTypeIdentifiers,
    type TrustListRef,
    type VerifierOptions,
} from "../../../trust/types.js";

/** A `trusted_authorities` entry of a DCQL credential query. */
export type DcqlTrustedAuthority =
    | { type: "etsi_tl"; values: TrustListRef[] }
    | { type: "openid_federation"; values: string[] };

/** The `etsi_tl` trust-list references of a credential query, if any. */
export function trustListAuthorities(
    authorities: DcqlTrustedAuthority[] | undefined,
): TrustListRef[] | undefined {
    return authorities?.find(
        (auth): auth is Extract<DcqlTrustedAuthority, { type: "etsi_tl" }> =>
            auth.type === "etsi_tl",
    )?.values;
}

/**
 * Trust options for verifying a presented credential: the resolved trust
 * lists, OpenID Federation trust anchors, revocation policy and clock skew.
 * Issuers must be listed as PID or EAA issuance services.
 *
 * Which `trusted_authorities` entry decides:
 * - an `etsi_tl` trust list: the issuer must be listed in it. An
 *   `openid_federation` entry of the same query does not widen it, because
 *   federation trust is not yet authenticated against the trust anchor.
 * - only `openid_federation`: the issuer must chain to one of its trust
 *   anchors (`federation-only`).
 * - none: the issuer is not checked. Only reachable with
 *   `SKIP_TRUST_AUTHORITY` (see {@link missingTrustedAuthorities}).
 */
export function verifierTrustOptions(input: {
    trustLists: TrustListRef[];
    /** Set for OID4VP, where managed trust-list ids are tenant scoped. */
    tenantId?: string;
    authorities: DcqlTrustedAuthority[] | undefined;
    statusCheckMode?: RevocationCheckMode;
    skewSeconds: number | undefined;
}): VerifierOptions {
    const federationAnchors =
        input.authorities?.find(
            (
                auth,
            ): auth is Extract<
                DcqlTrustedAuthority,
                { type: "openid_federation" }
            > => auth.type === "openid_federation",
        )?.values ?? [];
    const federationDecides =
        federationAnchors.length > 0 && input.trustLists.length === 0;

    return {
        trustListSource: {
            lotes: input.trustLists,
            acceptedServiceTypes: [
                ServiceTypeIdentifiers.EaaIssuance,
                ServiceTypeIdentifiers.PIDIssuance,
            ],
            ...(input.tenantId !== undefined
                ? { tenantId: input.tenantId }
                : {}),
        },
        federationTrustSource: federationDecides
            ? {
                  mode: "federation-only",
                  trustAnchors: federationAnchors.map((value) => ({
                      entityId: value,
                      entityConfigurationUri: `${value.replace(/\/$/, "")}/.well-known/openid-federation`,
                  })),
              }
            : undefined,
        policy: {
            requireX5c: true,
            revocation: revocationModeToPolicy(input.statusCheckMode),
        },
        skewSeconds: input.skewSeconds ?? DEFAULT_VERIFIER_SKEW_SECONDS,
    };
}
