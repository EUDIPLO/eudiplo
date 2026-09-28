export interface FederationEntityConfiguration {
    sub?: string;
    authority_hints?: string[];
    metadata?: Record<string, unknown>;
}

export interface FederationResolver {
    resolveEntityConfiguration(
        entityId: string,
    ): Promise<FederationEntityConfiguration>;
}

export const FEDERATION_RESOLVER = Symbol("FEDERATION_RESOLVER");
