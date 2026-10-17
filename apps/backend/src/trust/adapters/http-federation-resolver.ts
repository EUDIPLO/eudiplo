import { z } from "zod";
import type { FederationResolverSettings } from "../federation-resolver-settings.js";
import {
    type FederationResolution,
    FederationResolutionError,
    type FederationResolutionRequest,
    type FederationResolver,
} from "../ports/federation-resolver.js";

/** A trust engine that does not answer in time must not stall trust evaluation. */
export const TRUST_ENGINE_TIMEOUT_MS = 10_000;

/** Upper bound for one resolution response, trust chain included. */
export const TRUST_ENGINE_MAX_BYTES = 1024 * 1024;

const ResolutionSchema = z.object({
    entityId: z.string(),
    trustAnchor: z.string(),
    trustChain: z.array(z.string()),
    metadata: z.record(z.string(), z.record(z.string(), z.unknown())),
    expiresAt: z.iso.datetime({ offset: true }),
});

/**
 * Delegates trust chain resolution to an external trust engine:
 * `POST {url}/resolve` with the request as JSON, answered with a
 * {@link FederationResolution}. A 4xx answer other than 401, 403, 408 and
 * 429 means the entity is not trusted; those, 5xx answers and failed
 * requests mean trust could not be decided.
 * `fetch` must apply the outbound URL policy.
 */
export class HttpFederationResolver implements FederationResolver {
    constructor(
        private readonly settings: Omit<
            Extract<FederationResolverSettings, { type: "http" }>,
            "type"
        >,
        private readonly fetch: typeof globalThis.fetch,
    ) {}

    async resolveEntity(
        request: FederationResolutionRequest,
    ): Promise<FederationResolution> {
        const url = `${this.settings.url.replace(/\/+$/, "")}/resolve`;
        let response: Response;
        try {
            response = await this.fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json",
                    ...(this.settings.token
                        ? { authorization: `Bearer ${this.settings.token}` }
                        : {}),
                },
                body: JSON.stringify({
                    entityId: request.entityId,
                    trustAnchors: request.trustAnchors.map(
                        (anchor) => anchor.entityId,
                    ),
                    metadataTypes: request.metadataTypes,
                }),
            });
        } catch (error) {
            throw new FederationResolutionError(
                `trust engine request failed: ${error instanceof Error ? error.message : String(error)}`,
                "unavailable",
            );
        }

        // A rejected token or rate limit is no trust decision.
        if ([401, 403, 408, 429].includes(response.status)) {
            throw new FederationResolutionError(
                `trust engine did not decide (status ${response.status})${response.status === 401 || response.status === 403 ? "; check FEDERATION_RESOLVER_TOKEN" : ""}`,
                "unavailable",
            );
        }
        if (response.status >= 400 && response.status < 500) {
            throw new FederationResolutionError(
                `trust engine did not resolve ${request.entityId} (status ${response.status})`,
                "untrusted",
            );
        }
        if (!response.ok) {
            throw new FederationResolutionError(
                `trust engine answered with status ${response.status}`,
                "unavailable",
            );
        }

        const parsed = ResolutionSchema.safeParse(
            await response.json().catch(() => undefined),
        );
        if (!parsed.success) {
            throw new FederationResolutionError(
                "trust engine answered with an invalid resolution",
                "unavailable",
            );
        }
        return checkResolution(parsed.data, request);
    }
}

/** The answer must be about the requested entity and anchors, and current. */
function checkResolution(
    resolution: FederationResolution,
    request: FederationResolutionRequest,
): FederationResolution {
    if (resolution.entityId !== request.entityId) {
        throw new FederationResolutionError(
            `trust engine resolved ${resolution.entityId} instead of ${request.entityId}`,
            "untrusted",
        );
    }
    if (
        !request.trustAnchors.some(
            (anchor) => anchor.entityId === resolution.trustAnchor,
        )
    ) {
        throw new FederationResolutionError(
            `trust engine resolved ${request.entityId} to trust anchor ${resolution.trustAnchor}, which is not configured`,
            "untrusted",
        );
    }
    if (Date.parse(resolution.expiresAt) <= Date.now()) {
        throw new FederationResolutionError(
            `trust engine returned an expired resolution for ${request.entityId}`,
            "untrusted",
        );
    }
    if (
        request.metadataTypes?.length &&
        !request.metadataTypes.some((type) => resolution.metadata[type])
    ) {
        throw new FederationResolutionError(
            `federation entity ${request.entityId} has no ${request.metadataTypes.join(" or ")} metadata`,
            "untrusted",
        );
    }
    return resolution;
}
