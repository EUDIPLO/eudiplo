import type { HttpService } from "@nestjs/axios";
import type { AxiosResponse } from "axios";
import { firstValueFrom } from "rxjs";
import type { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";

/** Limits for requests to external and upstream authorization servers. */
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Response statuses that the Fetch API does not allow a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

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
 * servers itself, such as token introspection, through
 * {@link requestAuthorizationServer}.
 */
export function authorizationServerFetch(
    http: HttpService,
    policy: OutboundUrlPolicyService,
): typeof fetch {
    return async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        const body = init?.body ?? undefined;
        if (body !== undefined && typeof body !== "string") {
            throw new TypeError("Only string request bodies are supported");
        }
        const response = await requestAuthorizationServer(http, policy, {
            url,
            method: init?.method ?? "GET",
            headers: Object.fromEntries(new Headers(init?.headers)),
            body,
        });
        const contentType = response.headers["content-type"];
        return new Response(
            NULL_BODY_STATUSES.has(response.status) ? null : response.data,
            {
                status: response.status,
                headers: contentType
                    ? { "content-type": String(contentType) }
                    : undefined,
            },
        );
    };
}
