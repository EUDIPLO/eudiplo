import type { ClientCredentials } from "./application/authenticate-client.js";
import { OidcError } from "./domain/oidc-error.js";

/** Name of the cookie that binds a sign-in to the browser that started it. */
export function signInCookieName(signInId: string): string {
    return `eudiplo_oidc_${signInId.replace(/[^A-Za-z0-9-]/g, "")}`;
}

/** A cookie from a `Cookie` header, or undefined. */
export function readCookie(
    header: string | undefined,
    name: string,
): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() === name) {
            const value = part.slice(separator + 1).trim();
            try {
                return decodeURIComponent(value);
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

function decodeFormComponent(value: string): string {
    return decodeURIComponent(value.replace(/\+/g, " "));
}

/**
 * Client credentials from `Authorization: Basic` (RFC 6749 Section 2.3.1,
 * form-encoded before base64) or the body (`client_secret_post`). A client
 * must not use both at once.
 */
export function clientCredentials(
    authorization: string | undefined,
    body: { client_id?: string; client_secret?: string },
): ClientCredentials & { method?: "basic" | "post" } {
    const basic = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
    if (basic) {
        if (body.client_secret !== undefined) {
            throw new OidcError(
                "invalid_request",
                "Use only one client authentication method",
            );
        }
        const decoded = Buffer.from(basic, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 0) {
            throw new OidcError(
                "invalid_client",
                "Malformed Basic credentials",
                {
                    clientAuthenticationFailed: true,
                },
            );
        }
        try {
            const clientId = decodeFormComponent(decoded.slice(0, separator));
            if (body.client_id !== undefined && body.client_id !== clientId) {
                throw new OidcError(
                    "invalid_request",
                    "client_id does not match the authenticated client",
                );
            }
            return {
                clientId,
                clientSecret: decodeFormComponent(decoded.slice(separator + 1)),
                method: "basic",
            };
        } catch (error) {
            if (error instanceof OidcError) throw error;
            throw new OidcError(
                "invalid_client",
                "Malformed Basic credentials",
                { clientAuthenticationFailed: true },
            );
        }
    }
    return {
        clientId: body.client_id,
        clientSecret: body.client_secret,
        method: body.client_secret !== undefined ? "post" : undefined,
    };
}
