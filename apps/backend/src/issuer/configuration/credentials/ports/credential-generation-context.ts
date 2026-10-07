/** Resolves the issuer identity used by credential formats. */
export interface IssuerFederationContext {
    entityIdForTenant(tenantId: string): Promise<string | undefined>;
}
export const ISSUER_FEDERATION_CONTEXT = Symbol("ISSUER_FEDERATION_CONTEXT");
