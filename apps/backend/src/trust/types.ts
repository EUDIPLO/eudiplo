export interface TrustListRef {
    trustListId?: string;
    url: string;
    verifierKey?: Record<string, unknown>;
    verifierKeyPem?: string;
    verifierX509Der?: string;
}

/**
 * Normalize trust-list input to structured references.
 * Enforces structured trust-list references with verifier material.
 */
export function normalizeTrustListRefs(
    refs: TrustListRef[] | null | undefined,
): TrustListRef[] {
    if (!Array.isArray(refs)) {
        return [];
    }

    return refs.flatMap<TrustListRef>((ref) => {
        if (ref.trustListId !== undefined) {
            const trustListId = ref.trustListId.trim();
            if (!trustListId)
                throw new Error("Managed trust-list ID must not be empty");
            return [{ trustListId, url: "" }];
        }
        const url = typeof ref.url === "string" ? ref.url.trim() : "";
        if (url.length === 0) {
            return [];
        }

        const hasVerifierKey =
            !!ref.verifierKey && typeof ref.verifierKey === "object";
        const hasVerifierKeyPem =
            typeof ref.verifierKeyPem === "string" &&
            ref.verifierKeyPem.trim().length > 0;
        const hasVerifierX509Der =
            typeof ref.verifierX509Der === "string" &&
            ref.verifierX509Der.trim().length > 0;

        if (!hasVerifierKey && !hasVerifierKeyPem && !hasVerifierX509Der) {
            throw new Error(
                `Trust list reference '${url}' must define verifierKey, verifierKeyPem or verifierX509Der`,
            );
        }

        return [
            {
                url,
                verifierKey: ref.verifierKey,
                verifierKeyPem: ref.verifierKeyPem?.trim(),
                verifierX509Der: ref.verifierX509Der?.trim(),
            },
        ];
    });
}

export type ServiceTypeIdentifier = string;

export function serviceTypeMatches(
    serviceType: ServiceTypeIdentifier,
    acceptedType: ServiceTypeIdentifier,
): boolean {
    if (serviceType === acceptedType) {
        return true;
    }

    if (acceptedType.startsWith("/")) {
        return serviceType.endsWith(acceptedType);
    }

    const acceptedRoleSuffix = /(\/Issuance|\/Revocation)$/.exec(acceptedType);
    if (acceptedRoleSuffix) {
        return serviceType === acceptedType;
    }

    return (
        serviceType === acceptedType ||
        serviceType.startsWith(`${acceptedType}/`)
    );
}

/**
 * Well-known service type identifiers from ETSI TS 119 602.
 * These are identifier URIs defined by the standard, not endpoints that are
 * fetched; they must stay `http://` to match trust list entries exactly.
 */
export const ServiceTypeIdentifiers = {
    EaaIssuance: "http://uri.etsi.org/19602/SvcType/EAA/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    EaaRevocation: "http://uri.etsi.org/19602/SvcType/EAA/Revocation", // NOSONAR: ETSI identifier URI, not fetched
    PIDIssuance: "http://uri.etsi.org/19602/SvcType/PID/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    PIDRevocation: "http://uri.etsi.org/19602/SvcType/PID/Revocation", // NOSONAR: ETSI identifier URI, not fetched
    PubEaaIssuance: "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    PubEaaRevocation: "http://uri.etsi.org/19602/SvcType/PubEAA/Revocation", // NOSONAR: ETSI identifier URI, not fetched
    WalletSolution: "http://uri.etsi.org/19602/SvcType/WalletSolution", // NOSONAR: ETSI identifier URI, not fetched
    WalletSolutionIssuance:
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    WalletSolutionRevocation:
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation", // NOSONAR: ETSI identifier URI, not fetched
} as const;

/**
 * Services whose certificates identify credential issuers: PID providers
 * (ETSI TS 119 602 Annex D), public sector bodies issuing EAAs (Annex H) and
 * the EAA providers of the lists EUDIPLO publishes.
 */
export const credentialIssuerServiceTypes = [
    ServiceTypeIdentifiers.PIDIssuance,
    ServiceTypeIdentifiers.PubEaaIssuance,
    ServiceTypeIdentifiers.EaaIssuance,
] as const;

export const walletSolutionServiceTypes = [
    ServiceTypeIdentifiers.WalletSolution,
    ServiceTypeIdentifiers.WalletSolutionIssuance,
    ServiceTypeIdentifiers.WalletSolutionRevocation,
] as const;

/**
 * Services whose certificates sign wallet and key attestations, matched
 * exactly. A `WalletSolution/Revocation` service only provides validity
 * status information on a wallet solution (ETSI TS 119 602 Annex E,
 * Table E.3), so a certificate listed there does not sign attestations.
 */
export const walletAttestationSignerServiceTypes = [
    ServiceTypeIdentifiers.WalletSolution,
    ServiceTypeIdentifiers.WalletSolutionIssuance,
] as const;

/**
 * Service statuses saying that a listed service is no longer approved. Such a
 * service is not read from a list: `PubEAAProvidersList/SvcStatus/withdrawn`
 * (ETSI TS 119 602 Annex H, Table H.3) and the profile-independent
 * `commons/schemeApprovalWithdrawn` (draft ETSI EN 319 602 V1.1.3, C.2.5).
 */
export const withdrawnServiceStatuses: readonly string[] = [
    "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn", // NOSONAR: ETSI identifier URI, not fetched
    "http://uri.etsi.org/19602/commons/schemeApprovalWithdrawn", // NOSONAR: ETSI identifier URI, not fetched
];

export type TrustedEntityServiceCert = {
    serviceTypeIdentifier: ServiceTypeIdentifier;
    certValue: string; // PEM or base64 DER
};

/**
 * A TrustedEntity from a LoTE, containing its services grouped together.
 * This preserves the relationship between issuance and revocation certificates
 * from the same entity.
 */
export type TrustedEntity = {
    /** Entity identifier, if available */
    entityId?: string;
    /** All services for this entity */
    services: TrustedEntityServiceCert[];
};

/**
 * Helper to find a specific service type within a TrustedEntity.
 */
function findServiceByType(
    entity: TrustedEntity,
    serviceType: ServiceTypeIdentifier,
): TrustedEntityServiceCert | undefined {
    return entity.services.find((s) => s.serviceTypeIdentifier === serviceType);
}

/**
 * Get the issuance certificate from a TrustedEntity.
 */
function _getIssuanceCert(
    entity: TrustedEntity,
): TrustedEntityServiceCert | undefined {
    return findServiceByType(entity, ServiceTypeIdentifiers.EaaIssuance);
}

/**
 * The revocation service type that belongs to a matched issuance service:
 * `PID/Issuance` pairs with `PID/Revocation`, `PubEAA/Issuance` with
 * `PubEAA/Revocation`, and a wallet solution service with
 * `WalletSolution/Revocation`, as in the profiles of ETSI TS 119 602.
 */
function pairedRevocationServiceType(
    matchedServiceType: string | undefined,
): string | undefined {
    if (matchedServiceType === ServiceTypeIdentifiers.WalletSolution) {
        return ServiceTypeIdentifiers.WalletSolutionRevocation;
    }
    return matchedServiceType?.endsWith("/Issuance")
        ? `${matchedServiceType.slice(0, -"/Issuance".length)}/Revocation`
        : undefined;
}

/**
 * The revocation services of a TrustedEntity paired with its matched service:
 * every service of the paired revocation type, or, when the entity has none,
 * its `EAA/Revocation` services, the only ones read before. All returned
 * services have the same type. Wallet attestation status lists must be signed
 * under one of them; the status lists of presented credentials may be signed
 * under any `/Revocation` service of the entity.
 */
export function getRevocationServices(
    entity: TrustedEntity,
    matchedServiceType?: string,
): TrustedEntityServiceCert[] {
    const ofType = (type: string) =>
        entity.services.filter((s) => s.serviceTypeIdentifier === type);
    const pairedType = pairedRevocationServiceType(matchedServiceType);
    const paired = pairedType ? ofType(pairedType) : [];
    return paired.length > 0
        ? paired
        : ofType(ServiceTypeIdentifiers.EaaRevocation);
}

/**
 * The first revocation certificate of a TrustedEntity for a matched service,
 * see {@link getRevocationServices}. It names the revocation certificate in
 * the verification result; no trust decision depends on it.
 */
export function getRevocationCert(
    entity: TrustedEntity,
    matchedServiceType?: string,
): TrustedEntityServiceCert | undefined {
    return getRevocationServices(entity, matchedServiceType)[0];
}

export type FederationTrustMode = "federation-only" | "lote-only" | "hybrid";

type FederationTrustAnchorRef = {
    entityId: string;
    entityConfigurationUri: string;
};

export type FederationTrustSource = {
    /**
     * Tenant whose registered federation trust anchors provide the pinned
     * keys. Without it, no trust anchor is trusted.
     */
    tenantId?: string;
    mode?: FederationTrustMode;
    entityId?: string;
    trustAnchors: FederationTrustAnchorRef[];
    cacheTtlSeconds?: number;
    enforceSigningPolicy?: boolean;
};

export enum RevocationCheckMode {
    Strict = "strict",
    BestEffort = "best_effort",
    Disabled = "disabled",
}

export const DEFAULT_VERIFIER_SKEW_SECONDS = 60;

export type VerifierOptions = {
    trustListSource?: TrustListSource;
    federationTrustSource?: FederationTrustSource;
    policy: VerifyPolicy;
    /**
     * Transaction data from the OID4VP request.
     * When provided, the verifier will validate that the KB-JWT contains
     * transaction_data_hashes that match SHA-256 hashes of each transaction data string.
     * See OID4VP spec Appendix B.3.3.1 for details.
     */
    transactionData?: string[];
    /** Enforce TS12 SCA key-binding claims for this credential. */
    ts12TransactionData?: boolean;
    /** OID4VP response_mode from the signed authorization request. */
    keyBindingResponseMode?: string;
    /**
     * Expected KB-JWT audience for SD-JWT VC key binding validation.
     * Usually the verifier client_id from the presentation request.
     */
    keyBindingAudience?: string;
    /**
     * SD-JWT required disclosed claim keys.
     */
    requiredClaimKeys?: string[];
    /**
     * SD-JWT key binding nonce.
     */
    keyBindingNonce?: string;
    /**
     * Allow for clock skew when validating JWTs and SD-JWTs.
     * Default is 60 seconds.
     */
    skewSeconds?: number;
};

export type TrustListSource = {
    /** Required when resolving managed trust-list IDs. */
    tenantId?: string;
    lotes: TrustListRef[];
    // which service types from LoTE you want to accept as issuer identities
    acceptedServiceTypes?: ServiceTypeIdentifier[];
};

type VerifyPolicy = {
    requireX5c: boolean;
    revocation?: {
        enabled: boolean;
        failClosed?: boolean;
        fetchTimeoutMs?: number;
        cacheTtlMs?: number;
    };
    // If LoTE cert is CA=FALSE, treat it as pin:
    // - "leaf": require leaf cert to equal pinned cert
    // - "pathEnd": require chain to terminate at pinned cert (rare)
    pinnedCertMode?: "leaf" | "pathEnd";
};

export type { VerifyPolicy };
