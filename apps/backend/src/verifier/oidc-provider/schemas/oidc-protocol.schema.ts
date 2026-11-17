import { z } from "zod";

const optional = (description: string) =>
    z.string().optional().describe(description);

/**
 * Parameters of an authorization request. Every parameter is optional here:
 * the use case validates them, so errors reach the client the OAuth way.
 * Unknown parameters are ignored (OpenID Connect Core 1.0 Section 3.1.2.1).
 */
export const AuthorizationRequestSchema = z.object({
    response_type: optional("Must be `code`."),
    client_id: optional("The client_id."),
    redirect_uri: optional("A registered redirect URI."),
    scope: optional("`openid` and exactly one scope of the client."),
    state: optional("Opaque value returned to the client."),
    nonce: optional("Value returned in the ID token."),
    code_challenge: optional("PKCE code challenge (S256)."),
    code_challenge_method: optional("Must be `S256`."),
    response_mode: optional("Only `query`."),
    prompt: optional(
        "`login`, `consent` and `select_account` are always met; `none` fails with `login_required`.",
    ),
    acr_values: optional(
        "Name only the same-device value to accept only a same-device sign-in.",
    ),
    request: optional("Request objects are not supported."),
    request_uri: optional("The request_uri from the pushed request."),
});

/** Client credentials sent in the body (`client_secret_post`). */
const ClientCredentialsSchema = z.object({
    client_id: optional("The client_id, with client_secret_post."),
    client_secret: optional("The client secret, with client_secret_post."),
});

export const PushedAuthorizationRequestSchema =
    AuthorizationRequestSchema.extend(ClientCredentialsSchema.shape);

export const TokenRequestSchema = ClientCredentialsSchema.extend({
    grant_type: optional("Must be `authorization_code`."),
    code: optional("The authorization code."),
    redirect_uri: optional("The redirect URI of the authorization request."),
    code_verifier: optional("The PKCE code verifier."),
});

export const SignInCallbackQuerySchema = z.object({
    response_code: optional("One-time code of the completed presentation."),
    error: optional("Error of a failed presentation."),
    error_description: optional("Description of the error."),
});
