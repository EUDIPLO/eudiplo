---
title: Authorization servers
---

Configure how wallets obtain the access token they present at the credential endpoint. Authorization servers are entries of `authorizationServers` in the [issuance configuration](issuance-configuration.md); an offer selects one by `id`.

## Choose a type

| | `built-in` | `external` | `chained` | `oid4vp` |
| --- | --- | --- | --- | --- |
| User authentication | None (optionally [interactive authorization](interactive-authorization.md)) | Your OAuth 2.0 server | Login at an upstream OpenID provider, brokered by EUDIPLO | Presentation of a credential the wallet already holds |
| Access token issued by | EUDIPLO | Your server | EUDIPLO | EUDIPLO |
| Flows | Pre-authorized code; authorization code, also wallet-initiated | Authorization code offer | Authorization code offer | Authorization code offer |
| Claim source | Any ([Claims](claims.md)) | Offer claims or attribute provider (required) | Any; identity is the upstream user | Any; presented claims are passed on |
| Refresh tokens, DPoP, wallet attestation | EUDIPLO | Your server | EUDIPLO | EUDIPLO |
| Issuer URL | `/issuers/{tenant}` | Your `issuer` | `/issuers/{tenant}/chained-as` | `/issuers/{tenant}/authorization-servers/{id}` |

Typical choices: `built-in` when your backend already knows the user and creates pre-authorized offers; `chained` to issue after a login at your identity provider ([cookbook](../cookbooks/issue-after-login.md)); `oid4vp` to issue after a PID presentation; `external` when your OAuth server already issues JWT access tokens and can carry the EUDIPLO session ID.

## Configure entries

```json
{
    "authorizationServers": [
        { "type": "built-in", "id": "issuer-built-in" },
        {
            "type": "oid4vp",
            "id": "pid-login",
            "presentationConfigId": "pid",
            "requireDPoP": true
        }
    ]
}
```

- Every entry needs a unique `id`; `built-in` and `chained-as` are reserved. `label` is shown in the web client; `enabled: false` disables an entry.
- At least one entry is required, at most one `built-in`. Only the first enabled `chained` entry is used. A new tenant starts with `{ "type": "built-in", "id": "issuer-built-in" }`.
- EUDIPLO publishes the issuer URLs of all enabled entries, in order, as `authorization_servers` in the credential issuer metadata.
- An offer selects an entry with `authorization_server`; without it, the first enabled entry is used. The offer tells the wallet which server to use, also for pre-authorized codes. Only the built-in server redeems pre-authorized codes, so pre-authorized offers must select it (explicitly or as the first enabled entry).

Entries of the types `built-in`, `chained` and `oid4vp` accept:

| Field | Default | Description |
| --- | --- | --- |
| `token.lifetimeSeconds` | `300` (built-in), `3600` (chained, OID4VP) | Access token lifetime, minimum 60. |
| `token.signingKeyId` | Tenant default key | Key chain that signs access tokens. The built-in server falls back to the issuance configuration's `signingKeyId` first. |
| `token.refreshTokenEnabled` | `true` | See [Refresh tokens](#refresh-tokens). |
| `token.refreshTokenExpiresInSeconds` | `2592000` (30 days) | Minimum 60. |
| `requireDPoP` | `false` | See [DPoP](#dpop). |
| `walletAttestationRequired`, `walletProviderTrustLists` | Issuance configuration values | Wallet attestation at PAR and token endpoints; see [Wallet and key attestation](../trust/attestation.md). |

## Built-in

EUDIPLO's own authorization server at `/issuers/{tenant}/authorize/*` (`par`, `authorize`, `token`, `interactive`), with metadata at `/.well-known/oauth-authorization-server/issuers/{tenant}`. It redeems pre-authorized codes and issues authorization codes without a login step. Wallets may also start an authorization code flow without an offer; they then select credentials with `authorization_details`. The access token's `sub` is the issuance session ID.

## External

Use your own OAuth 2.0 authorization server. EUDIPLO validates its access tokens and maps them to the offer's issuance session.

```json
{
    "type": "external",
    "id": "corporate-idp",
    "issuer": "https://auth.example.com/realms/corp",
    "sessionBinding": { "method": "access_token_claim", "claim": "issuer_state" }
}
```

Requirements for your server:

1. It publishes OAuth authorization server or OpenID Connect discovery metadata for `issuer`, including `jwks_uri`.
2. It issues JWT access tokens (`typ: at+jwt`) with `iss`, `sub`, `aud`, `exp`, `iat` and `jti`. `aud` must contain `{PUBLIC_URL}/issuers/{tenant}`.
3. It copies the offer's `issuer_state` (the EUDIPLO session ID) unchanged into the access token claim named in `sessionBinding.claim`.
4. Its metadata, `jwks_uri` and any `introspection_endpoint` are HTTPS URLs on public addresses, as the [outbound URL policy](../concepts/security-model.md#https-and-tls) requires. For a server on HTTP or a private address, set `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK`.

Every token must point to an active offer session that was created for this authorization server; EUDIPLO never creates a session from an external token. With the first credential request, EUDIPLO binds the token's `iss` and `sub` to the session, and later tokens must carry the same identity. The claims must come from the offer or an attribute provider, see [Claims](claims.md#external-authorization-servers-need-a-dynamic-source). External entries do not accept `token`, `requireDPoP` or wallet attestation settings; your server handles those.

:::caution[Offer selection]
EUDIPLO currently binds external tokens only to offers that selected the external server as the default: list it as the first enabled entry of `authorizationServers` and create the offer without `authorization_server`.
:::

## Chained

EUDIPLO acts as the authorization server towards the wallet and delegates the login to an upstream OpenID provider, such as Keycloak. The upstream provider needs no EUDIPLO-specific changes.

```json
{
    "type": "chained",
    "id": "keycloak-login",
    "upstream": {
        "issuer": "https://keycloak.example.com/realms/eudiplo",
        "clientId": "eudiplo-chained-as",
        "clientSecret": "change-me",
        "scopes": ["openid", "profile", "email"]
    },
    "requireDPoP": true
}
```

- Register `{PUBLIC_URL}/issuers/{tenant}/chained-as/callback` as redirect URI of the upstream client.
- EUDIPLO uses OpenID Connect discovery, the authorization code flow with PKCE (`S256`), and sends `client_id` and `client_secret` in the token request body. Omit `clientSecret` for a public client. `scopes` defaults to `["openid"]`.
- EUDIPLO fetches the discovery document and calls the token endpoint under the [outbound URL policy](../concepts/security-model.md#https-and-tls): both need HTTPS on a public address unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set, and the token endpoint must answer without a redirect.
- Attribute providers receive the upstream user as `identity`: `iss` and `sub` of the upstream ID token and the ID token claims merged over the upstream access token claims.
- EUDIPLO's access token contains `issuer_state`, `client_id`, `upstream_iss` and `upstream_sub`; its `sub` is the wallet's `client_id`.
- Endpoints: `/issuers/{tenant}/chained-as/{par,authorize,callback,token}`, metadata at `/.well-known/oauth-authorization-server/issuers/{tenant}/chained-as`, keys at `/.well-known/jwks.json/issuers/{tenant}/chained-as`.

Start chained flows from an authorization code offer; the wallet must send the offer's `issuer_state` in its pushed authorization request.

## OID4VP

The wallet authorizes by presenting a credential, for example a PID, that matches a [presentation configuration](../presentation/configure-verification.md).

```json
{ "type": "oid4vp", "id": "pid-login", "presentationConfigId": "pid", "requireDPoP": true }
```

1. The wallet sends a pushed authorization request to `/issuers/{tenant}/authorization-servers/{id}/par` and opens `…/authorize`. This returns a page with an **Open wallet** link to the presentation request.
2. After a successful presentation, EUDIPLO stores the verified claims on the issuance session, redirects with an authorization code, and issues tokens at `…/token`.
3. Attribute providers receive the presented claims in `credentials`, see the [Attribute provider API](../reference/attribute-provider-api.md).

Metadata is at `/.well-known/oauth-authorization-server/issuers/{tenant}/authorization-servers/{id}`. Like chained flows, OID4VP flows start from an authorization code offer. `immediateWalletRedirect` is accepted but has no effect.

The VP-backed chained server (`chained-as-vp`) was removed in 9.0; use the `oid4vp` type. See the [upgrade guide](../upgrade/8.x-to-9.0.md).

## Refresh tokens

The built-in, chained and OID4VP servers share one policy (9.0):

- Refresh tokens are enabled by default and valid for 30 days (`token.refreshTokenEnabled`, `token.refreshTokenExpiresInSeconds`).
- A refresh token never lives unbounded. Tokens stored without an expiry by older versions expire 30 days (or the configured lifetime) after their session was created.
- Refreshing keeps the original expiry. Chained and OID4VP servers rotate the refresh token; the built-in server keeps the original one.
- With `refreshTokenEnabled: false`, the token endpoint answers `unsupported_grant_type` and the metadata omits the `refresh_token` grant.

Refresh only helps while the issuance session exists: sessions are removed after the session retention time (`SESSION_TTL`, 24 hours by default, or the tenant's session settings). Expired chained and OID4VP authorization sessions are removed every `SESSION_TIDY_UP_INTERVAL`.

## DPoP

Two settings control DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)):

| Setting | Default | Enforced at |
| --- | --- | --- |
| Issuance `dPopRequired` | `true` | Built-in token endpoint (all grants) and the credential, deferred credential and notification endpoints. When `true`, these endpoints accept only `DPoP` tokens, no `Bearer`. |
| Per server `requireDPoP` | `false` | Built-in: PAR must carry a DPoP proof or `dpop_jkt`. Chained and OID4VP: PAR and token requests must carry a proof. |

Because `dPopRequired` applies at the credential endpoint for every server, set `requireDPoP: true` on chained and OID4VP servers while `dPopRequired` is `true`; otherwise they may issue `Bearer` tokens that the credential endpoint rejects. A key bound at PAR must sign the proofs at the token and refresh requests. Since 9.0, EUDIPLO verifies every proof: algorithm `ES256`, `ES384` or `ES512`, at most 5 minutes old, `jti` used once, no private key material. Failures answer `invalid_dpop_proof`.

## PKCE, PAR and authorization codes

- **PKCE:** every authorization code requires `S256`, at the built-in, chained, OID4VP and interactive endpoints and on the upstream leg. A missing `code_challenge` or another method answers `invalid_request`.
- **PAR:** the built-in server requires pushed authorization requests with `client_id` and `redirect_uri` (9.0). Its `request_uri` is single use and valid for 60 seconds, its authorization codes for 60 seconds. Chained and OID4VP servers use 600 and 300 seconds.
- **Grant binding (9.0):** a pre-authorized code is redeemable only with the `pre-authorized_code` grant, every other code only with `authorization_code`; otherwise the answer is `invalid_grant`. Codes are single use, bound to the client of the PAR request and, if sent, to its `redirect_uri`.
