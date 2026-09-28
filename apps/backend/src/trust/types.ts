export interface TrustListRef {
    trustListId?: string;
    url: string;
    verifierKey?: Record<string, unknown>;
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
        const hasVerifierX509Der =
            typeof ref.verifierX509Der === "string" &&
            ref.verifierX509Der.trim().length > 0;

        if (!hasVerifierKey && !hasVerifierX509Der) {
            throw new Error(
                `Trust list reference '${url}' must define verifierKey or verifierX509Der`,
            );
        }

        return [
            {
                url,
                verifierKey: ref.verifierKey,
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

/** Well-known service type identifiers from ETSI TS 119 602 */
export const ServiceTypeIdentifiers = {
    EaaIssuance: "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
    EaaRevocation: "http://uri.etsi.org/19602/SvcType/EAA/Revocation",
    WalletSolution: "http://uri.etsi.org/19602/SvcType/WalletSolution",
    WalletSolutionIssuance:
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
    WalletSolutionRevocation:
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
} as const;

export const walletSolutionServiceTypes = [
    ServiceTypeIdentifiers.WalletSolution,
    ServiceTypeIdentifiers.WalletSolutionIssuance,
    ServiceTypeIdentifiers.WalletSolutionRevocation,
] as const;

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
 * Get the revocation certificate from a TrustedEntity.
 */
export function getRevocationCert(
    entity: TrustedEntity,
): TrustedEntityServiceCert | undefined {
    return findServiceByType(entity, ServiceTypeIdentifiers.EaaRevocation);
}

export type FederationTrustMode = "federation-only" | "lote-only" | "hybrid";

type FederationTrustAnchorRef = {
    entityId: string;
    entityConfigurationUri: string;
};

export type FederationTrustSource = {
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
