import type { HttpService } from "@nestjs/axios";
import type { AxiosResponse } from "axios";
import { firstValueFrom } from "rxjs";
import { outboundFetch } from "../../../../webhook/outbound-fetch.js";
import type { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";

/** Limits for requests to external and upstream authorization servers. */
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * GET a JSON document (metadata, discovery document, JWKS) from an
 * authorization server under the outbound URL policy. Every redirect hop is
 * checked; non-2xx responses and invalid JSON are rejected.
 *
 * @param options.trustedOrigins origins that skip the policy, such as
 * EUDIPLO's own `PUBLIC_URL`
 */
export async function getAuthorizationServerJson<T>(
    policy: OutboundUrlPolicyService,
    url: string,
    options: { accept?: string; trustedOrigins?: string[] } = {},
): Promise<T> {
    const response = await policy.getFollowingRedirects(url, {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        maxRedirects: MAX_REDIRECTS,
        headers: { accept: options.accept ?? "application/json" },
        trustedOrigins: options.trustedOrigins,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `Request to ${response.url} failed with status code ${response.status}`,
        );
    }
    return JSON.parse(response.body) as T;
}

/**
 * Send a request to an authorization server under the outbound URL policy:
 * the URL is checked, the connection only goes to allowed addresses, and
 * redirects are not followed, because a redirected request would skip the
 * URL check. Any status is returned.
 */
export async function requestAuthorizationServer(
    http: HttpService,
    policy: OutboundUrlPolicyService,
    request: {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: string;
    },
): Promise<AxiosResponse<string>> {
    await policy.assertSafeUrl(request.url);
    return firstValueFrom(
        http.request<string>({
            url: request.url,
            method: request.method,
            headers: request.headers,
            data: request.body,
            lookup: policy.safeLookup as never,
            // No connection pooling, so safeLookup checks every connection
            // instead of a socket opened by an earlier request being reused.
            httpAgent: false,
            httpsAgent: false,
            maxRedirects: 0,
            timeout: TIMEOUT_MS,
            maxContentLength: MAX_BYTES,
            responseType: "text",
            validateStatus: () => true,
        }),
    );
}

/**
 * `fetch` for the requests the `@openid4vc` library sends to authorization
 * servers itself, such as token introspection, under the outbound URL policy.
 */
export function authorizationServerFetch(
    http: HttpService,
    policy: OutboundUrlPolicyService,
): typeof fetch {
    return outboundFetch(http, policy, {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
    });
}
