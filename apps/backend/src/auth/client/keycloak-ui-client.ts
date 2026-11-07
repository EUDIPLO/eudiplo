/** The redirect URI and web origin with which Keycloak accepts any address. */
const ANY = "*";
/** The web origin with which Keycloak allows the origins of the client's redirect URIs. */
const REDIRECT_URI_ORIGINS = "+";

/** The redirect URIs and web origins of the public client the web client signs in with. */
export interface UiClientAddresses {
    redirectUris: string[];
    webOrigins: string[];
}

/**
 * The addresses Keycloak sends authorization codes to and allows token
 * requests from: every page under each web client URL, and the origins of
 * these URLs.
 */
export function webClientAddresses(urls: string[]): UiClientAddresses {
    const redirectUris = new Set<string>();
    const webOrigins = new Set<string>();
    for (const value of urls) {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, "");
        redirectUris.add(`${url.origin}${path}/*`);
        webOrigins.add(url.origin);
    }
    return { redirectUris: [...redirectUris], webOrigins: [...webOrigins] };
}

/**
 * The addresses of an existing client without the `*` that earlier versions
 * set: codes then go only to the redirect URIs set in Keycloak, and only
 * their origins may request tokens in a browser.
 */
export function withoutAnyAddress(
    existing: Partial<UiClientAddresses> | undefined,
): UiClientAddresses {
    const redirectUris = (existing?.redirectUris ?? []).filter(
        (uri) => uri !== ANY,
    );
    const webOrigins = (existing?.webOrigins ?? []).map((origin) =>
        origin === ANY ? REDIRECT_URI_ORIGINS : origin,
    );
    return {
        redirectUris,
        webOrigins: webOrigins.length
            ? [...new Set(webOrigins)]
            : [REDIRECT_URI_ORIGINS],
    };
}
