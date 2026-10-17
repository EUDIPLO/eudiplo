import {
    type FetchCallback,
    resolveTrustChainsWithFailures,
    type TrustChain,
    type VerifyCallback,
} from "@openid-federation/core";
import { compactVerify, importJWK, type JWK } from "jose";
import {
    type FederationResolution,
    FederationResolutionError,
    type FederationResolutionRequest,
    type FederationResolver,
} from "../ports/federation-resolver.js";
import {
    type TrustFetchService,
    TrustFetchStatusError,
} from "../trust-fetch.service.js";

/** A slow or unresponsive federation entity must not stall trust evaluation. */
const FEDERATION_FETCH_TIMEOUT_MS = 5000;

/** Upper bound for one entity configuration or subordinate statement. */
const FEDERATION_MAX_BYTES = 256 * 1024;

const ENTITY_STATEMENT_CONTENT_TYPE = "application/entity-statement+jwt";

/** Signature algorithms accepted for federation entity statements. */
const FEDERATION_ALGORITHMS = [
    "ES256",
    "ES384",
    "ES512",
    "PS256",
    "PS384",
    "PS512",
    "RS256",
    "RS384",
    "RS512",
    "EdDSA",
];

/** Bounds on how much remote traversal one resolution may trigger. */
export interface FederationTraversalLimits {
    /** Maximum superiors followed from the entity, the trust anchor included. */
    maxDepth: number;
    /** Only the first N distinct authority_hints of each entity are followed. */
    maxAuthorityHints: number;
    /** Maximum requests (and entity visits) per resolution. */
    maxRequests: number;
}

const DEFAULT_LIMITS: FederationTraversalLimits = {
    maxDepth: 8,
    maxAuthorityHints: 10,
    maxRequests: 32,
};

/** Marks a failed request, so it is not mistaken for a verification failure. */
class FederationFetchFailed extends Error {}

/**
 * Resolves trust chains with `@openid-federation/core`. Every request goes
 * through {@link TrustFetchService}, so the outbound URL policy applies to
 * the URLs entity configurations name, and TLS certificates are verified.
 */
export class LocalFederationResolver implements FederationResolver {
    constructor(
        private readonly trustFetch: Pick<TrustFetchService, "get">,
        private readonly clockToleranceSeconds: number,
        private readonly limits: FederationTraversalLimits = DEFAULT_LIMITS,
    ) {}

    async resolveEntity(
        request: FederationResolutionRequest,
    ): Promise<FederationResolution> {
        const { trustChains, failures } = await resolveTrustChainsWithFailures({
            entityId: request.entityId,
            trustAnchors: request.trustAnchors.map((anchor) => ({
                entityId: anchor.entityId,
            })),
            verifyJwtCallback: this.verify,
            fetchCallback: this.fetch,
            clockSkewSeconds: this.clockToleranceSeconds,
            ...this.limits,
        });

        const usable = trustChains.filter((chain) =>
            hasMetadataType(chain, request.metadataTypes),
        );
        if (usable.length === 0) {
            if (
                failures.length > 0 &&
                failures.every((f) => f.cause instanceof FederationFetchFailed)
            ) {
                throw new FederationResolutionError(
                    `could not fetch federation statements for ${request.entityId}: ${failures[0].reason}`,
                    "unavailable",
                );
            }
            throw new FederationResolutionError(
                untrustedReason(request, trustChains.length, failures),
                "untrusted",
            );
        }

        // Prefer the shortest chain, then the one valid longest.
        const [chain] = usable.sort(
            (a, b) =>
                a.jwtChain.length - b.jwtChain.length ||
                b.expiresAt.getTime() - a.expiresAt.getTime(),
        );
        return {
            entityId: chain.rawLeafEntityConfiguration.sub,
            trustAnchor: chain.trustAnchorEntityConfiguration.sub,
            trustChain: chain.jwtChain,
            metadata: (chain.resolvedLeafMetadata ?? {}) as Record<
                string,
                Record<string, unknown>
            >,
            expiresAt: chain.expiresAt.toISOString(),
        };
    }

    private readonly verify: VerifyCallback = async ({ jwt, header, jwk }) => {
        const alg = header.alg;
        if (typeof alg !== "string" || !FEDERATION_ALGORITHMS.includes(alg)) {
            return false;
        }
        try {
            const key = await importJWK(jwk as JWK, alg);
            await compactVerify(jwt, key, { algorithms: [alg] });
            return true;
        } catch {
            return false;
        }
    };

    private readonly fetch: FetchCallback = async (input) => {
        const url =
            input instanceof Request
                ? input.url
                : input instanceof URL
                  ? input.toString()
                  : input;
        try {
            const response = await this.trustFetch.get(url, {
                timeoutMs: FEDERATION_FETCH_TIMEOUT_MS,
                maxBytes: FEDERATION_MAX_BYTES,
                accept: ENTITY_STATEMENT_CONTENT_TYPE,
                verifyTls: true,
            });
            return new Response(response.body, {
                status: response.status,
                headers: response.contentType
                    ? { "content-type": response.contentType }
                    : undefined,
            });
        } catch (error) {
            // 400 and 404 are the federation's answer (Section 8.9): for
            // example, a superior no longer lists the subject. They must not
            // count as unreachable; other statuses, such as 429, do.
            if (
                error instanceof TrustFetchStatusError &&
                (error.status === 400 || error.status === 404)
            ) {
                return new Response(null, { status: error.status });
            }
            throw new FederationFetchFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    };
}

function hasMetadataType(chain: TrustChain, types: string[] | undefined) {
    if (!types?.length) return true;
    const metadata = (chain.resolvedLeafMetadata ?? {}) as Record<
        string,
        unknown
    >;
    return types.some((type) => metadata[type] !== undefined);
}

function untrustedReason(
    request: FederationResolutionRequest,
    validChains: number,
    failures: { entityIds: string[]; reason: string }[],
): string {
    if (validChains > 0) {
        return `federation entity ${request.entityId} has no ${request.metadataTypes?.join(" or ")} metadata`;
    }
    if (failures.length > 0) {
        return `no valid trust chain from ${request.entityId} to a configured trust anchor: ${failures[0].reason}`;
    }
    return `${request.entityId} does not chain to a configured trust anchor`;
}
