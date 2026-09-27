import type { CommandContext } from "../types.js";

/**
 * Minimal client-credentials token fetch for the checks that need an
 * authenticated API call. The CLI has no shared auth helper yet; when one
 * lands, only this module should need replacing.
 */
export type TokenResult =
    | { kind: "token"; accessToken: string }
    | { kind: "unavailable"; reason: string }
    | { kind: "error"; reason: string };

export async function requestAccessToken(
    baseUrl: URL,
    context: CommandContext,
): Promise<TokenResult> {
    const clientId = context.env.EUDIPLO_CLIENT_ID;
    const clientSecret = context.env.EUDIPLO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return {
            kind: "unavailable",
            reason: "EUDIPLO_CLIENT_ID and EUDIPLO_CLIENT_SECRET are not set",
        };
    }

    const tokenUrl = new URL("api/oauth2/token", withTrailingSlash(baseUrl));
    try {
        const response = await context.fetch(tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }).toString(),
        });
        if (!response.ok) {
            // Never echo the response body: it can contain credentials.
            return {
                kind: "error",
                reason: `the token endpoint returned HTTP ${response.status}`,
            };
        }
        const payload: unknown = await response.json();
        const accessToken =
            typeof payload === "object" &&
            payload !== null &&
            "access_token" in payload
                ? String((payload as { access_token: unknown }).access_token)
                : "";
        if (!accessToken) {
            return {
                kind: "error",
                reason: "the token response did not contain an access token",
            };
        }
        return { kind: "token", accessToken };
    } catch (error) {
        return {
            kind: "error",
            reason: `the token endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Fetches an authenticated endpoint. Returns the status code and parsed
 * body; error bodies are never returned, so nothing sensitive is printed.
 */
export async function fetchAuthenticated(
    url: URL,
    accessToken: string,
    context: CommandContext,
): Promise<
    { ok: true; body: unknown } | { ok: false; status?: number; reason: string }
> {
    try {
        const response = await context.fetch(url, {
            method: "GET",
            headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                reason: `${url.pathname} returned HTTP ${response.status}`,
            };
        }
        return { ok: true, body: await response.json() };
    } catch (error) {
        return {
            ok: false,
            reason: `${url.pathname} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export function withTrailingSlash(url: URL): URL {
    return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}
