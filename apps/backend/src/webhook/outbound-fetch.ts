import type { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import type { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

/** Limits of an {@link outboundFetch}. */
export interface OutboundFetchLimits {
    timeoutMs: number;
    maxBytes: number;
}

/** Response statuses that the Fetch API does not allow a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch` under the outbound URL policy, for HTTP clients that take a fetch
 * implementation: the URL is checked, the connection only goes to allowed
 * addresses, and time and response size are bounded. Redirects are not
 * followed, because a redirected request would skip the URL check; a redirect
 * response is rejected with its target in the error.
 */
export function outboundFetch(
    http: HttpService,
    policy: OutboundUrlPolicyService,
    limits: OutboundFetchLimits,
): typeof fetch {
    return async (input, init) => {
        // Normalise both call styles, fetch(url, init) and fetch(request), so
        // method, headers and body (including multipart) are taken over.
        const request = new Request(input, init);
        await policy.assertSafeUrl(request.url);
        const body = request.body
            ? Buffer.from(await request.arrayBuffer())
            : undefined;
        const response = await firstValueFrom(
            http.request<Buffer>({
                url: request.url,
                method: request.method,
                headers: Object.fromEntries(request.headers),
                data: body,
                lookup: policy.safeLookup as never,
                // No connection pooling, so safeLookup checks every connection
                // instead of a socket opened by an earlier request being reused.
                httpAgent: false,
                httpsAgent: false,
                maxRedirects: 0,
                timeout: limits.timeoutMs,
                maxContentLength: limits.maxBytes,
                responseType: "arraybuffer",
                validateStatus: () => true,
            }),
        );

        // 304 Not Modified is not a redirect.
        if (
            response.status >= 300 &&
            response.status < 400 &&
            response.status !== 304
        ) {
            const location = response.headers.location;
            throw new Error(
                location
                    ? `Request to ${request.url} was redirected to ${new URL(String(location), request.url).toString()}; redirects are not followed`
                    : `Request to ${request.url} returned redirect status ${response.status}; redirects are not followed`,
            );
        }

        const contentType = response.headers["content-type"];
        return new Response(
            NULL_BODY_STATUSES.has(response.status)
                ? null
                : new Uint8Array(response.data),
            {
                status: response.status,
                statusText: response.statusText,
                headers: contentType
                    ? { "content-type": String(contentType) }
                    : undefined,
            },
        );
    };
}
