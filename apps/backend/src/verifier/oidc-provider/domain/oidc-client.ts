import {
    generateOpaqueSecret,
    hashOpaqueSecret,
    matchesOpaqueSecret,
} from "./opaque-secret.js";

/**
 * How strictly a client's authorization requests are made:
 *
 * - `secure`: the request must be pushed first (RFC 9126); the authorization
 *   endpoint reads only `client_id` and `request_uri`.
 * - `basic`: the parameters may also be sent to the authorization endpoint
 *   directly, for libraries that cannot push a request.
 */
type OidcClientProfile = "secure" | "basic";

/** A client secret, stored only as its hash. */
export interface OidcClientSecret {
    id: string;
    /** SHA-256 of the secret, base64url. */
    hash: string;
    createdAt: Date;
    /** The secret is refused from this moment on. */
    expiresAt?: Date | null;
    /** Last successful use, updated at most every five minutes. */
    lastUsedAt?: Date | null;
}

/** A scope the client may request, verified with one presentation config. */
export interface OidcClientScope {
    scope: string;
    presentationConfigId: string;
}

/** A relying party that signs users in through EUDIPLO's OpenID Provider. */
export interface OidcClient {
    /** The `client_id`. */
    id: string;
    tenantId: string;
    name: string;
    redirectUris: string[];
    profile: OidcClientProfile;
    scopes: OidcClientScope[];
    secrets: OidcClientSecret[];
    createdAt?: Date;
    updatedAt?: Date;
}

/** A client holds at most two secrets, so a secret can be rotated. */
export const MAX_CLIENT_SECRETS = 2;

/** A client grants at most this many scopes. */
export const MAX_CLIENT_SCOPES = 20;

/** `lastUsedAt` is written at most this often per secret. */
const SECRET_LAST_USED_GRANULARITY_MS = 5 * 60 * 1000;

/** Scope token (RFC 6749 Section 3.3), restricted to a safe subset. */
const SCOPE_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Scope every request carries; it cannot be assigned to a configuration. */
export const OPENID_SCOPE = "openid";

/** A new client secret. */
export const generateClientSecret = generateOpaqueSecret;

/** Hash of a client secret, as stored. */
export const hashClientSecret = hashOpaqueSecret;

/**
 * The client's secret that matches the presented one and has not expired.
 * Every stored secret is compared in constant time.
 */
export function matchClientSecret(
    client: Pick<OidcClient, "secrets">,
    presented: string,
    now: Date,
): OidcClientSecret | undefined {
    let match: OidcClientSecret | undefined;
    for (const secret of client.secrets) {
        // Every secret is compared, so the timing does not tell which matched.
        const equal = matchesOpaqueSecret(secret.hash, presented);
        const expired =
            !!secret.expiresAt && secret.expiresAt.getTime() <= now.getTime();
        if (equal && !expired) match = secret;
    }
    return match;
}

/** Whether `lastUsedAt` of a secret is due to be written again. */
export function secretUseIsStale(secret: OidcClientSecret, now: Date): boolean {
    return (
        !secret.lastUsedAt ||
        now.getTime() - secret.lastUsedAt.getTime() >=
            SECRET_LAST_USED_GRANULARITY_MS
    );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why a redirect URI cannot be registered, or undefined when it can: an
 * absolute HTTPS URI without fragment (RFC 6749 Section 3.1.2), or HTTP on a
 * loopback host for local development (RFC 8252 Section 7.3).
 */
export function redirectUriProblem(uri: string): string | undefined {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return `'${uri}' is not an absolute URI`;
    }
    if (url.hash || uri.includes("#")) {
        return `'${uri}' must not contain a fragment`;
    }
    if (url.username || url.password) {
        return `'${uri}' must not contain user information`;
    }
    if (url.protocol === "https:") return undefined;
    if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
        return undefined;
    }
    return `'${uri}' must use HTTPS (HTTP only for localhost)`;
}

/** Why a client's scopes cannot be stored, or undefined when they can. */
export function scopesProblem(scopes: OidcClientScope[]): string | undefined {
    if (scopes.length > MAX_CLIENT_SCOPES) {
        return `A client has at most ${MAX_CLIENT_SCOPES} scopes`;
    }
    const names = new Set<string>();
    const configs = new Set<string>();
    for (const { scope, presentationConfigId } of scopes) {
        if (scope === OPENID_SCOPE) {
            return `'${OPENID_SCOPE}' is reserved and cannot be assigned`;
        }
        if (!SCOPE_NAME_PATTERN.test(scope)) {
            return `Scope '${scope}' must match ${SCOPE_NAME_PATTERN.source}`;
        }
        if (names.has(scope)) return `Scope '${scope}' is assigned twice`;
        if (configs.has(presentationConfigId)) {
            return `Presentation config '${presentationConfigId}' is assigned to more than one scope`;
        }
        names.add(scope);
        configs.add(presentationConfigId);
    }
    return undefined;
}
