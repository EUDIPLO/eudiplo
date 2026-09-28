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
 */
export function verifierTrustOptions(input: {
    trustLists: TrustListRef[];
    /** Set for OID4VP, where managed trust-list ids are tenant scoped. */
    tenantId?: string;
    authorities: DcqlTrustedAuthority[] | undefined;
    statusCheckMode?: RevocationCheckMode;
    skewSeconds: number | undefined;
}): VerifierOptions {
    const federationAuthorities = input.authorities?.find(
        (
            auth,
        ): auth is Extract<
            DcqlTrustedAuthority,
            { type: "openid_federation" }
        > => auth.type === "openid_federation",
    );

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
        federationTrustSource: federationAuthorities?.values.length
            ? {
                  mode: "hybrid",
                  trustAnchors: federationAuthorities.values.map((value) => ({
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
