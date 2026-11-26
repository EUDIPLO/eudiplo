import type { FederationTrustAnchorData } from "../domain/federation-trust-anchor-data.js";

export const FEDERATION_TRUST_ANCHOR_REPOSITORY = Symbol(
    "FEDERATION_TRUST_ANCHOR_REPOSITORY",
);

export interface FederationTrustAnchorRepository {
    listForTenant(tenantId: string): Promise<FederationTrustAnchorData[]>;
    findForTenant(
        tenantId: string,
        id: string,
    ): Promise<FederationTrustAnchorData | null>;
    findByEntityIds(
        tenantId: string,
        entityIds: string[],
    ): Promise<FederationTrustAnchorData[]>;
    /** Whether the tenant has one with this ID, without loading it. */
    existsForTenant(tenantId: string, id: string): Promise<boolean>;
    /**
     * Stores a new one; never replaces a stored one, also not under
     * concurrent creates of the same ID.
     * @throws ResourceIdTaken when the tenant already has one with this ID.
     */
    create(
        anchor: FederationTrustAnchorData,
    ): Promise<FederationTrustAnchorData>;
    /** Stores it, replacing a stored one with the same ID. */
    save(anchor: FederationTrustAnchorData): Promise<FederationTrustAnchorData>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
