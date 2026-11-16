/**
 * How the last load of a trust list ended for a tenant:
 * - `accepted`: fetched, verified, current and numbered as expected
 * - `outdated`: its `NextUpdate` has passed or it is closed
 * - `superseded`: numbered lower than a list accepted before
 * - `invalidSequenceNumber`: no usable `LoTESequenceNumber`
 * - `tooManyCertificates`: its source went over the certificate limit with it
 * - `failed`: it could not be fetched, verified or parsed
 */
export type TrustListFetchOutcome =
    | "accepted"
    | "outdated"
    | "superseded"
    | "invalidSequenceNumber"
    | "tooManyCertificates"
    | "failed";

/** The result of loading one trust list, as recorded. */
export interface TrustListFetchResult {
    tenantId: string;
    /**
     * The list's URL; for a managed list of this instance, its URL below
     * `PUBLIC_URL`, never `INTERNAL_URL`.
     */
    url: string;
    /** Set for a managed list named by ID. */
    trustListId?: string;
    outcome: TrustListFetchOutcome;
    /**
     * Why the list was not accepted, for the tenant's operators: texts
     * EUDIPLO builds, never network error details or `INTERNAL_URL`.
     */
    reason?: string;
    /** Set when the list was fetched and its signature verified. */
    list?: {
        nextUpdate: string | null | undefined;
        /** Only a whole number; other values are left out. */
        sequenceNumber?: number;
        entities: number;
    };
}

/** A recorded result with the times it is kept with. */
export interface TrustListFetchStatus {
    url: string;
    trustListId: string | null;
    outcome: TrustListFetchOutcome;
    reason: string | null;
    /** When the list was last loaded, whatever the outcome. */
    checkedAt: Date;
    /** When the list was last fetched and verified. */
    verifiedAt: Date | null;
    /** When the list was last accepted. */
    acceptedAt: Date | null;
    /** From the last verified fetch. */
    nextUpdate: string | null;
    sequenceNumber: number | null;
    entities: number | null;
}

/**
 * The last load of each trust list per tenant, so operators can see a list
 * that fails or lapses before a presentation or issuance is refused for it.
 * Shared by all instances of the backend and kept across restarts.
 */
export interface TrustListFetchStatuses {
    /**
     * Record a result. Values from an earlier verified fetch are kept when
     * this one did not verify the list.
     */
    record(result: TrustListFetchResult, at: Date): Promise<void>;
    /** The tenant's recorded lists, most recently checked first. */
    list(tenantId: string): Promise<TrustListFetchStatus[]>;
}

/** For callers that do not record, such as tests. */
export const NO_TRUST_LIST_FETCH_STATUSES: TrustListFetchStatuses = {
    record: async () => undefined,
    list: async () => [],
};

export const TRUST_LIST_FETCH_STATUSES = Symbol("TRUST_LIST_FETCH_STATUSES");
