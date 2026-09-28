import type { FederationResolver } from "../ports/federation-resolver.js";

export interface FederationTrustChainResult {
    trusted: boolean;
    reason: string;
}

export interface EvaluateFederationTrustChainInput {
    entityId: string;
    trustAnchors: string[];
}

/** Bounds on how much remote traversal one evaluation may trigger. */
export interface FederationTraversalLimits {
    /** Maximum authority_hints hops from the leaf entity. */
    maxDepth: number;
    /** Only the first N authority_hints of each entity are followed. */
    maxHintsPerEntity: number;
    /** Maximum entity configurations resolved per evaluation. */
    maxResolutions: number;
}

export const DEFAULT_FEDERATION_TRAVERSAL_LIMITS: FederationTraversalLimits = {
    maxDepth: 8,
    maxHintsPerEntity: 10,
    maxResolutions: 32,
};

export class EvaluateFederationTrustChain {
    constructor(
        private readonly resolver: FederationResolver,
        private readonly limits: FederationTraversalLimits = DEFAULT_FEDERATION_TRAVERSAL_LIMITS,
    ) {}

    async execute(
        input: EvaluateFederationTrustChainInput,
    ): Promise<FederationTrustChainResult> {
        const anchors = new Set(input.trustAnchors.map(normalizeEntityId));
        const trusted = {
            trusted: true,
            reason: "entity authority_hints chain to configured trust anchor",
        };
        const rejected = (
            reason = "entity did not chain to configured trust anchor",
        ) => ({ trusted: false, reason });
        // Revisit an entity only when a shorter path leaves more depth available.
        const exploredDepth = new Map<string, number>();
        const { maxDepth, maxHintsPerEntity, maxResolutions } = this.limits;
        // Entity configurations are attacker-influenced input, so the total
        // number of remote resolutions per evaluation is bounded.
        let resolutions = 0;
        const visit = async (
            current: string,
            depth: number,
            path: Set<string>,
        ): Promise<FederationTrustChainResult> => {
            if (depth > maxDepth)
                return rejected(
                    "federation authority_hints chain exceeded maximum depth",
                );
            if (anchors.has(current)) return trusted;
            if (path.has(current))
                return rejected(
                    "federation authority_hints chain contains a cycle",
                );
            if ((exploredDepth.get(current) ?? Infinity) <= depth)
                return rejected();
            exploredDepth.set(current, depth);
            if (resolutions >= maxResolutions)
                return rejected(
                    "federation authority_hints traversal exceeded resolution limit",
                );
            resolutions++;
            const configuration =
                await this.resolver.resolveEntityConfiguration(current);
            if (
                configuration.sub &&
                normalizeEntityId(configuration.sub) !== current
            ) {
                return rejected(
                    "federation entity subject does not match entity id",
                );
            }
            const hints = (configuration.authority_hints ?? [])
                .slice(0, maxHintsPerEntity)
                .map(normalizeEntityId);
            // A direct anchor must not be hidden by an earlier unrelated hint.
            if (depth < maxDepth && hints.some((hint) => anchors.has(hint)))
                return trusted;
            const nextPath = new Set(path).add(current);
            let failure = rejected();
            let fetchError: unknown;
            let fetchFailed = false;
            for (const hint of hints) {
                try {
                    const result = await visit(hint, depth + 1, nextPath);
                    if (result.trusted) return result;
                    failure = result;
                } catch (error) {
                    // A broken branch must not prevent another branch from succeeding.
                    fetchFailed = true;
                    fetchError = error;
                }
            }
            // Preserve the caller's fetch-error/stale-cache handling if no path succeeds.
            if (fetchFailed) throw fetchError;
            return failure;
        };
        return visit(normalizeEntityId(input.entityId), 0, new Set());
    }
}

function normalizeEntityId(entityId: string): string {
    return entityId.replace(/\/$/, "");
}
