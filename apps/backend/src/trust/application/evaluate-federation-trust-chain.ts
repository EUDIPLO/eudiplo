import type { FederationResolver } from "../ports/federation-resolver.js";

export interface FederationTrustChainResult {
    trusted: boolean;
    reason: string;
}

export interface EvaluateFederationTrustChainInput {
    entityId: string;
    trustAnchors: string[];
}

export class EvaluateFederationTrustChain {
    private readonly maxDepth = 8;

    constructor(private readonly resolver: FederationResolver) {}

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
        const visit = async (
            current: string,
            depth: number,
            path: Set<string>,
        ): Promise<FederationTrustChainResult> => {
            if (depth > this.maxDepth)
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
            const hints = (configuration.authority_hints ?? []).map(
                normalizeEntityId,
            );
            // A direct anchor must not be hidden by an earlier unrelated hint.
            if (
                depth < this.maxDepth &&
                hints.some((hint) => anchors.has(hint))
            )
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
