/**
 * The origin a Digital Credentials API request is bound to.
 *
 * A DC API request carries the origin of the calling page: in OID4VP as the
 * signed `expected_origins` claim, in ISO 18013-7 Annex C in the session
 * transcript. The wallet compares it with the origin the browser reports, so
 * whoever chooses that value decides which websites may relay the request.
 * The caller of the management API names it explicitly (`expected_origin`),
 * never through a header of its request, and must take it from its own
 * configuration, not from end-user input. `allowedOrigins` of the
 * presentation configuration, when set, limits what callers may name.
 */

/**
 * Origin of a page as a caller passes it: an origin or a URL of a page on it.
 * Returns `undefined` for anything that is not an `http` or `https` URL.
 */
function originOf(value: string): string | undefined {
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" || url.protocol === "http:"
            ? url.origin
            : undefined;
    } catch {
        return undefined;
    }
}

export type ExpectedOriginResult =
    | { origin: string; problem?: undefined }
    | { origin?: undefined; problem: string };

/**
 * Chooses the origin a DC API request is bound to.
 *
 * @param requested `expected_origin` of the offer request; may be empty
 * @param allowed `allowedOrigins` of the presentation configuration; empty
 *   or unset means any origin the caller names
 * @returns the origin to sign, or why the request is refused: no origin
 *   while the configuration does not name exactly one, a value that is not
 *   a web origin, or an origin the configuration does not allow
 */
export function resolveExpectedOrigin(
    requested: string | undefined,
    allowed: readonly string[] | null | undefined,
): ExpectedOriginResult {
    const restricted = !!allowed?.length;
    if (!requested?.trim()) {
        if (allowed?.length === 1) return { origin: allowed[0] };
        return {
            problem: restricted
                ? "lists several allowedOrigins; set expected_origin to the origin of the page that calls the Digital Credentials API"
                : "needs expected_origin for dc-api and iso-18013-7 requests: the origin of the page that calls the Digital Credentials API",
        };
    }
    const origin = originOf(requested);
    if (!origin) {
        return {
            // The value is not echoed: it is caller input of any length.
            problem:
                "cannot be requested for this expected_origin: it is not an http or https origin",
        };
    }
    if (allowed?.length && !allowed.includes(origin)) {
        return {
            problem: `does not allow the origin ${origin}; add it to allowedOrigins`,
        };
    }
    return { origin };
}
