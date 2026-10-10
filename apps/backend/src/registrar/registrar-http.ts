import type { HttpService } from "@nestjs/axios";
import { outboundFetch } from "../webhook/outbound-fetch.js";
import type { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";

/**
 * Limits for outbound requests of the registrar integration: calls to the
 * registrar API and its OIDC provider, and rulebooks and schemas referenced
 * by URL.
 */
export const REMOTE_FILE_TIMEOUT_MS = 10_000;
export const REMOTE_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `fetch` for the registrar API client and the OAuth2 client of its OIDC
 * provider. Both URLs are configured by the tenant, so every request goes
 * through the outbound URL policy and redirects are not followed.
 */
export function registrarFetch(
    http: HttpService,
    policy: OutboundUrlPolicyService,
): typeof fetch {
    return outboundFetch(http, policy, {
        timeoutMs: REMOTE_FILE_TIMEOUT_MS,
        maxBytes: REMOTE_FILE_MAX_BYTES,
    });
}
