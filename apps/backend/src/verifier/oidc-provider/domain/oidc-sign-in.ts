import { createHash, timingSafeEqual } from "node:crypto";
import { assertS256CodeChallenge } from "../../../issuer/issuance/oid4vci/authorization/domain/pkce.js";
import { type OidcClient, OPENID_SCOPE } from "./oidc-client.js";
import { OidcError } from "./oidc-error.js";

/**
 * Lifecycle of a sign-in:
 *
 * `pushed` (PAR stored) → `pending` (browser at the sign-in page, presentation
 * requested) → `authorized` (code issued) → `redeemed` (ID token issued).
 * `failed` ends a sign-in whose presentation failed or expired.
 */
export enum OidcSignInStatus {
    Pushed = "pushed",
    Pending = "pending",
    Authorized = "authorized",
    Redeemed = "redeemed",
    Failed = "failed",
}

/** The wallet returned the holder to the browser that started the sign-in. */
export const ACR_SAME_DEVICE = "urn:eudiplo:acr:oidc:same-device";
/** Only the browser that started the sign-in proved itself. */
export const ACR_CROSS_DEVICE = "urn:eudiplo:acr:oidc:cross-device";

/** A pushed request can be used at the authorization endpoint this long. */
export const PUSHED_REQUEST_LIFETIME_SECONDS = 300;
/** A sign-in expires this long after the browser reached the sign-in page. */
export const SIGN_IN_LIFETIME_SECONDS = 900;
/** An authorization code can be redeemed this long. */
export const AUTHORIZATION_CODE_LIFETIME_SECONDS = 60;
/** Lifetime of the ID token and of the (unusable) access token. */
export const ID_TOKEN_LIFETIME_SECONDS = 300;

/** An S256 code challenge: base64url of a SHA-256 hash (RFC 7636 Section 4.2). */
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Upper bound for `state` and `nonce`, so a request cannot bloat storage. */
const MAX_PARAMETER_LENGTH = 1024;

/** A sign-in of a relying party through the OpenID Provider. */
export interface OidcSignIn {
    id: string;
    tenantId: string;
    clientId: string;
    redirectUri: string;
    state?: string | null;
    nonce?: string | null;
    /** The requested scope, `openid` plus one assigned scope. */
    scope: string;
    presentationConfigId: string;
    codeChallenge: string;
    /** `acr_values` named only the same-device value. */
    requireSameDevice: boolean;
    status: OidcSignInStatus;
    /** SHA-256 of the secret in the cookie of the browser that started it. */
    browserBindingHash?: string | null;
    presentationSessionId?: string | null;
    /** `openid4vp://` request for a wallet on the same device. */
    sameDeviceRequest?: string | null;
    /** `openid4vp://` request for a wallet on another device (QR code). */
    crossDeviceRequest?: string | null;
    /**
     * The wallet returned the holder with a valid `response_code` to a
     * browser without the binding cookie: the starting browser may then
     * finish as a cross-device sign-in.
     */
    walletReturnedElsewhere: boolean;
    /** SHA-256 of the authorization code. */
    codeHash?: string | null;
    codeExpiresAt?: Date | null;
    acr?: string | null;
    authTime?: Date | null;
    expiresAt: Date;
    createdAt?: Date;
}

/** Parameters of an authorization request, as received. */
export interface AuthorizationRequestParameters {
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    response_mode?: string;
    prompt?: string;
    acr_values?: string;
    request?: string;
    request_uri?: string;
}

/** A validated authorization request. */
export interface ValidatedAuthorizationRequest {
    redirectUri: string;
    state?: string;
    nonce?: string;
    scope: string;
    presentationConfigId: string;
    codeChallenge: string;
    requireSameDevice: boolean;
}

function boundedParameter(
    name: string,
    value: string | undefined,
): string | undefined {
    if (value !== undefined && value.length > MAX_PARAMETER_LENGTH) {
        throw new OidcError(
            "invalid_request",
            `${name} is longer than ${MAX_PARAMETER_LENGTH} characters`,
        );
    }
    return value || undefined;
}

/**
 * Validate an authorization request of a client (OpenID Connect Core 1.0
 * Section 3.1.2.2). The redirect URI is checked first: errors about other
 * parameters carry it, so the caller can send them back to the client.
 */
export function validateAuthorizationRequest(
    client: OidcClient,
    params: AuthorizationRequestParameters,
): ValidatedAuthorizationRequest {
    if (
        !params.redirect_uri ||
        !client.redirectUris.includes(params.redirect_uri)
    ) {
        throw new OidcError(
            "invalid_request",
            "redirect_uri is missing or not registered for this client",
        );
    }
    const redirectUri = params.redirect_uri;
    // An error redirect must carry the client's exact state (RFC 6749
    // Section 4.1.2.1); a state too long to keep is shown on a page instead.
    const state = boundedParameter("state", params.state);
    try {
        if (params.request !== undefined) {
            throw new OidcError(
                "request_not_supported",
                "Request objects are not supported",
            );
        }
        if (params.response_type !== "code") {
            throw new OidcError(
                "unsupported_response_type",
                "response_type must be 'code'",
            );
        }
        if (params.response_mode && params.response_mode !== "query") {
            throw new OidcError(
                "invalid_request",
                "response_mode must be 'query'",
            );
        }
        const { scope, presentationConfigId } = resolveScope(
            client,
            params.scope,
        );
        try {
            assertS256CodeChallenge(
                params.code_challenge,
                params.code_challenge_method,
            );
        } catch (error) {
            throw new OidcError(
                "invalid_request",
                error instanceof Error ? error.message : "PKCE is required",
            );
        }
        if (!S256_CHALLENGE_PATTERN.test(params.code_challenge!)) {
            throw new OidcError(
                "invalid_request",
                "code_challenge must be the base64url SHA-256 of the code_verifier (43 characters)",
            );
        }
        const prompts = (params.prompt ?? "").split(" ").filter(Boolean);
        if (prompts.includes("none")) {
            // Every sign-in is a new presentation; there is no session to reuse.
            throw new OidcError(
                "login_required",
                "Every sign-in needs a presentation from the wallet",
            );
        }
        const acrValues = (params.acr_values ?? "").split(" ").filter(Boolean);
        return {
            redirectUri,
            state,
            nonce: boundedParameter("nonce", params.nonce),
            scope,
            presentationConfigId,
            codeChallenge: params.code_challenge!,
            requireSameDevice:
                acrValues.includes(ACR_SAME_DEVICE) &&
                !acrValues.includes(ACR_CROSS_DEVICE),
        };
    } catch (error) {
        if (error instanceof OidcError) {
            throw error.redirectTo(redirectUri, state);
        }
        throw error;
    }
}

/**
 * `openid` plus exactly one scope assigned to the client. More scopes are
 * refused rather than ignored: picking one of several configurations would
 * ask the user for a credential nobody requested.
 */
function resolveScope(
    client: OidcClient,
    scope: string | undefined,
): { scope: string; presentationConfigId: string } {
    const requested = [...new Set((scope ?? "").split(" ").filter(Boolean))];
    if (!requested.includes(OPENID_SCOPE)) {
        throw new OidcError("invalid_scope", "scope must contain 'openid'");
    }
    const others = requested.filter((value) => value !== OPENID_SCOPE);
    if (others.length !== 1) {
        throw new OidcError(
            "invalid_scope",
            "scope must contain 'openid' and exactly one other scope",
        );
    }
    const assigned = client.scopes.find((entry) => entry.scope === others[0]);
    if (!assigned) {
        throw new OidcError(
            "invalid_scope",
            `Scope '${others[0]}' is not assigned to this client`,
        );
    }
    return {
        scope: `${OPENID_SCOPE} ${assigned.scope}`,
        presentationConfigId: assigned.presentationConfigId,
    };
}

/** Constant-time comparison of two secrets of arbitrary length. */
export function sameSecret(
    stored: string | null | undefined,
    presented: string | null | undefined,
): boolean {
    if (!stored || !presented) return false;
    const digest = (value: string) =>
        createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(stored), digest(presented));
}

export function isExpired(signIn: Pick<OidcSignIn, "expiresAt">, now: Date) {
    return signIn.expiresAt.getTime() <= now.getTime();
}
