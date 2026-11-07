import { Logger } from "@nestjs/common";
import { z } from "zod";
import { oidcDiscoveryUrl } from "../../shared/domain/oidc-discovery-url.js";
import type { OutboundUrlPolicyService } from "../../webhook/outbound-url-policy.service.js";
import type { OidcIssuerMetadata } from "../ports/oidc-issuer-metadata.js";

/** The values of the discovery document EUDIPLO uses. */
const OidcIssuerMetadataSchema = z.object({
    issuer: z.string().url(),
    jwks_uri: z.string().url(),
    token_endpoint: z.string().url(),
});

/** Limits of one request for the discovery document. */
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

/** How long startup waits for the identity provider, which may start later. */
const DISCOVERY_RETRY_MS = 60_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5_000;

export interface OidcIssuerMetadataLoaderOptions {
    /** Issuer the access tokens name, `OIDC`. */
    issuer: string;
    /** Issuer URL under which the backend reaches the provider. */
    internalIssuer: string;
    /** `OIDC_JWKS_URI`, which replaces the key set the document names. */
    jwksUri?: string;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/**
 * Loads the discovery document of the identity provider once at startup.
 * The issuer is operator configuration, like `PUBLIC_URL`, and usually a
 * private address such as `http://authentik:9000`, so its origin skips the
 * outbound URL policy. Redirects are not followed: the document decides where
 * the signing keys come from, so it must come from the configured URL. An identity provider
 * in the same Compose file often starts after EUDIPLO, so failures are retried
 * for a bounded time before startup fails.
 */
export class OidcIssuerMetadataLoader {
    private readonly logger = new Logger(OidcIssuerMetadataLoader.name);

    constructor(private readonly outboundUrlPolicy: OutboundUrlPolicyService) {}

    async load(
        options: OidcIssuerMetadataLoaderOptions,
    ): Promise<OidcIssuerMetadata> {
        const url = oidcDiscoveryUrl(options.internalIssuer);
        const sleep =
            options.sleep ??
            ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        const now = options.now ?? Date.now;
        const deadline = now() + (options.retryMs ?? DISCOVERY_RETRY_MS);
        const attempt = async (
            count: number,
            delay: number,
        ): Promise<OidcIssuerMetadata> => {
            try {
                return this.validate(await this.fetch(url), options);
            } catch (error) {
                const reason = (error as Error).message;
                if (
                    error instanceof InvalidDiscoveryDocument ||
                    now() >= deadline
                ) {
                    throw new Error(
                        `Could not load the OIDC discovery document from ${url}: ${reason}`,
                    );
                }
                this.logger.warn(
                    `Loading the OIDC discovery document from ${url} failed (attempt ${count}): ${reason}. Retrying in ${delay} ms`,
                );
                await sleep(delay);
                return attempt(count + 1, Math.min(delay * 2, MAX_DELAY_MS));
            }
        };
        return attempt(1, FIRST_DELAY_MS);
    }

    private async fetch(url: string): Promise<unknown> {
        const response = await this.outboundUrlPolicy.get(url, {
            timeoutMs: TIMEOUT_MS,
            maxBytes: MAX_BYTES,
            headers: { accept: "application/json" },
            trustedOrigins: [new URL(url).origin],
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`status code ${response.status}`);
        }
        return JSON.parse(response.body);
    }

    /**
     * The document must name the issuer the tokens carry (OpenID Connect
     * Discovery 1.0, section 4.3); otherwise every token would be refused.
     * Keys over plain HTTP could be replaced on the way, so the key set must
     * be HTTPS or come from the origin the document came from.
     */
    private validate(
        document: unknown,
        { issuer, internalIssuer, jwksUri }: OidcIssuerMetadataLoaderOptions,
    ): OidcIssuerMetadata {
        const parsed = OidcIssuerMetadataSchema.safeParse(document);
        if (!parsed.success) {
            throw new InvalidDiscoveryDocument(
                `the document has no valid ${parsed.error.issues
                    .map((issue) => issue.path.join("."))
                    .join(", ")}`,
            );
        }
        if (parsed.data.issuer !== issuer) {
            throw new InvalidDiscoveryDocument(
                `the document names the issuer '${parsed.data.issuer}', but OIDC is '${issuer}'. Set OIDC to the issuer exactly as the identity provider names it`,
            );
        }
        const keys = new URL(parsed.data.jwks_uri);
        if (
            !jwksUri &&
            keys.protocol !== "https:" &&
            keys.origin !== new URL(internalIssuer).origin
        ) {
            throw new InvalidDiscoveryDocument(
                `the document names the key set '${parsed.data.jwks_uri}', which is neither HTTPS nor at the origin of the discovery document. Set OIDC_JWKS_URI`,
            );
        }
        const internal = new URL(internalIssuer).origin;
        if (
            internal !== new URL(issuer).origin &&
            new URL(parsed.data.token_endpoint).origin === internal
        ) {
            // EUDIPLO advertises it; clients outside cannot reach it.
            this.logger.warn(
                `The discovery document names the token endpoint ${parsed.data.token_endpoint} at the internal address. Check the identity provider's host name settings`,
            );
        }
        return parsed.data;
    }
}

/** Retrying cannot fix a document that lacks a value or names another issuer or key set. */
class InvalidDiscoveryDocument extends Error {}
