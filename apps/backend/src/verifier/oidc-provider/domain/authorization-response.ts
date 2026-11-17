/**
 * Redirects of the authorization endpoint (RFC 6749 Section 4.1.2). Both
 * carry `iss` (RFC 9207), so a client talking to several providers can tell
 * which one answered.
 */
export function authorizationCodeRedirect(
    redirectUri: string,
    code: string,
    issuer: string,
    state?: string | null,
): string {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("iss", issuer);
    if (state) url.searchParams.set("state", state);
    return url.toString();
}

export function authorizationErrorRedirect(
    redirectUri: string,
    error: string,
    description: string | undefined,
    issuer: string,
    state?: string | null,
): string {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    if (description) url.searchParams.set("error_description", description);
    url.searchParams.set("iss", issuer);
    if (state) url.searchParams.set("state", state);
    return url.toString();
}
