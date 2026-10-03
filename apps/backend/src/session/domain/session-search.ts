const UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
const PRE_AUTHORIZED_GRANT =
    "urn:ietf:params:oauth:grant-type:pre-authorized_code";

/**
 * The session identifiers a search term can match. A session matches when any
 * of the set fields does.
 */
export interface SessionSearch {
    /** Session id prefix (a full id matches exactly). */
    idPrefix?: string;
    walletNonce?: string;
    /** Pre-authorized code of an issuance offer. */
    authorizationCode?: string;
    reference?: string;
}

/** Whether the value is the beginning of a lowercase or uppercase UUID. */
export function isUuidPrefix(value: string): boolean {
    if (value.length === 0 || value.length > UUID_TEMPLATE.length) return false;
    return [...value.toLowerCase()].every((char, index) =>
        UUID_TEMPLATE[index] === "-" ? char === "-" : /[0-9a-f]/.test(char),
    );
}

/**
 * The smallest and largest UUID starting with the prefix. Comparing against
 * this range finds ids by prefix with an index and without casting the id
 * column to text.
 */
export function uuidPrefixRange(prefix: string): [string, string] {
    const value = prefix.toLowerCase();
    const fill = (digit: string) =>
        value + UUID_TEMPLATE.slice(value.length).replaceAll("x", digit);
    return [fill("0"), fill("f")];
}

/**
 * Interpret a pasted search term. A credential offer link resolves to the
 * session id or pre-authorized code it carries, an OID4VP request link to its
 * wallet nonce, and any other term is matched against all identifiers.
 */
export function parseSessionSearch(input: string): SessionSearch {
    const term = input.trim();
    const fromLink = parseLink(term);
    if (fromLink) return fromLink;
    return {
        ...(isUuidPrefix(term) ? { idPrefix: term.toLowerCase() } : {}),
        walletNonce: term,
        authorizationCode: term,
        reference: term,
    };
}

function parseLink(term: string): SessionSearch | undefined {
    const url = parseUrl(term);
    if (!url) return undefined;
    const offer = url.searchParams.get("credential_offer");
    if (offer) return fromOfferObject(offer);
    const target =
        parseUrl(url.searchParams.get("credential_offer_uri") ?? "") ??
        parseUrl(url.searchParams.get("request_uri") ?? "") ??
        url;
    const segments = target.pathname.split("/").filter(Boolean);
    const offerIndex = segments.lastIndexOf("credential-offers");
    if (offerIndex >= 0 && segments[offerIndex + 1])
        return { idPrefix: exactId(segments[offerIndex + 1]) };
    const presentationIndex = segments.lastIndexOf("presentations");
    if (
        presentationIndex >= 0 &&
        segments[presentationIndex + 2] === "oid4vp" &&
        segments[presentationIndex + 1]
    )
        return { walletNonce: segments[presentationIndex + 1] };
    return undefined;
}

/** A credential offer passed by value carries `issuer_state` or the code. */
function fromOfferObject(value: string): SessionSearch | undefined {
    let offer: unknown;
    try {
        offer = JSON.parse(value);
    } catch {
        return undefined;
    }
    const grants = (offer as { grants?: Record<string, any> } | null)?.grants;
    const issuerState = grants?.authorization_code?.issuer_state;
    if (typeof issuerState === "string")
        return { idPrefix: exactId(issuerState) };
    const code = grants?.[PRE_AUTHORIZED_GRANT]?.["pre-authorized_code"];
    if (typeof code === "string") return { authorizationCode: code };
    return undefined;
}

/** A session id taken from a link must match in full, never as a prefix. */
function exactId(value: string): string | undefined {
    return value.length === UUID_TEMPLATE.length && isUuidPrefix(value)
        ? value.toLowerCase()
        : undefined;
}

function parseUrl(value: string): URL | undefined {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
    try {
        return new URL(value);
    } catch {
        return undefined;
    }
}
