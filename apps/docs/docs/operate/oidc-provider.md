---
title: Other OIDC providers
---

# Other OIDC providers

Use an OpenID Connect provider other than Keycloak, such as Authentik, Zitadel,
Auth0 or Entra ID, to sign in to the management API and the web client
(`OIDC_PROVIDER=generic`). The provider manages people and API clients; EUDIPLO
only checks its access tokens. For Keycloak, where EUDIPLO also manages clients
and people, see [Keycloak SSO](keycloak.md).

## Before you start

- A provider that issues **JWT** access tokens signed with RS256, PS256 or
  ES256 and publishes an OpenID Connect discovery document
- EUDIPLO and the web client deployed at their final HTTPS URLs
- The EUDIPLO tenants your people and machine clients belong to

## 1. Plan the token claims

EUDIPLO accepts an access token only when all of this holds:

| Check | Requirement |
| ----- | ----------- |
| Format | A JWT (three parts). Opaque tokens get `401` "Access token is not a JWT" |
| Token type | The JWS header has no `typ`, or `JWT` or `at+jwt` (also with the `application/` prefix, in any case), and the token carries no `at_hash`, `c_hash` or `s_hash`, which only ID tokens carry. Otherwise `401` "Not an access token: …" |
| `iss` | Exactly `OIDC`, including a trailing slash |
| Signature | A key from the discovery document's `jwks_uri` (or `OIDC_JWKS_URI`), algorithm `OIDC_ALGORITHM` |
| `aud` | Contains `OIDC_AUDIENCE` |
| `exp` | Present and in the future |
| Tenant | The claim named by `OIDC_SUB` (default `tenant_id`) holds an existing tenant ID. Without it, tenant endpoints answer `403` |
| Roles | The claim named by `OIDC_ROLES_CLAIM`, or `roles` / `realm_access.roles` without it, holds [EUDIPLO role names](../reference/roles.md) |

`OIDC_ROLES_CLAIM` is a claim name or a dot path into nested claims
(`resource_access.eudiplo.roles`); a claim with exactly that name wins, so
namespaced names such as `https://eudiplo.example.com/roles` work. The claim is
an array of role names, or an object whose keys are role names. A string holds
no roles.

Choose an audience that only EUDIPLO's access tokens carry, such as an API
identifier. Some providers also put a client ID into ID tokens; with that as
audience, an ID token of the same client passes the audience check. The token
type check refuses it only when it carries one of the hashes above. Where the
provider offers no other audience and its ID tokens carry no hash, as in the
[Authentik example](#example-authentik), keep its token lifetimes short.

## 2. Configure EUDIPLO

```env
OIDC=https://auth.example.com/application/o/eudiplo/  # the issuer, exactly as the discovery document names it
OIDC_PROVIDER=generic
OIDC_AUDIENCE=<aud value of EUDIPLO's access tokens>
PUBLIC_URL=https://eudiplo.example.com
MASTER_SECRET=<random, 32+ characters>   # derives the default encryption key
# Optional
# OIDC_INTERNAL_ISSUER_URL=     # where the backend loads the discovery document, if not from OIDC
# OIDC_JWKS_URI=                # where the backend loads the signing keys, if not from the document's jwks_uri; HTTPS, or HTTP only inside a private network
# OIDC_SUB=tenant_id            # claim with the tenant
# OIDC_ROLES_CLAIM=             # claim or dot path with the roles
# OIDC_ALGORITHM=RS256          # RS256, PS256 or ES256
# OIDC_UI_CLIENT_ID=            # public client of the web client; no default, SSO only when set (step 3)
```

At startup, EUDIPLO loads `<OIDC_INTERNAL_ISSUER_URL or OIDC>/.well-known/openid-configuration`,
retrying for up to 60 seconds while the provider starts. It does not follow
redirects. Startup fails when the document names another issuer than `OIDC`,
lacks `issuer`, `jwks_uri` or `token_endpoint`, or names a key set over plain
HTTP at another origin (scheme, host and port) than the discovery document;
setting `OIDC_JWKS_URI` skips that last check. `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_UI_URL`,
`AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are not used. All variables are listed
in the [environment variable reference](../reference/environment-variables.md#authentication).

**Checkpoint:** the backend log shows `External OIDC (generic)` as the mode, and
`GET /.well-known/oauth-authorization-server` names the provider's
`token_endpoint`.

## 3. Let people sign in to the web client

1. Create a public client at the provider with Authorization Code and PKCE.
2. Register `<web client URL>/login` and `<web client URL>/silent-check-sso.html`
   as redirect URIs, the web client's URL as post-logout redirect URI, and its
   origin for CORS.
3. Set `OIDC_UI_CLIENT_ID` to the client's ID and restart the backend.

The web client then offers an **SSO** tab and reads the provider's endpoints
from its discovery document. It requests the scope `openid` only, so the
provider must put the audience and the claims of step 1 into that access token
(see the provider notes below). Most providers issue a refresh token only for
the scope `offline_access`, which the web client does not request, so it cannot
renew that token: when it expires, the web client says that the session has
expired, and **Log in** signs the person in again and returns to the page,
without asking while their session at the provider lasts. The access token
lifetime is therefore also the longest the web client stays signed in.

When the provider has an `end_session_endpoint`, logging out also goes there,
and the provider sends the browser back to the web client if its URL is
registered as a post-logout redirect URI. Whether the provider's own session
ends depends on its settings (for Authentik, see step 6 of the example). The
web client opens it with a GET, which every provider accepts, so the
`id_token_hint` is part of the address and can reach the browser history and
access logs.

What changes in this mode, such as the hidden **API Clients** and **Users**
pages, is summarized in
[Tenants and access](tenants-and-access.md#external-oidc-provider-and-human-users).

**Checkpoint:** sign in with SSO as a person of a tenant. The menu shows the
pages of their roles; `GET /api/auth/me` returns their tenant and roles.

## 4. Machine clients

Backends and scripts get tokens with the client credentials grant at the
provider's token endpoint (advertised as `token_endpoint` in
`/.well-known/oauth-authorization-server`). Those tokens need the same audience,
tenant and roles claims as people's tokens; map them on the provider's machine
client or service account. The CLI's `config export`, `plan`, `import`,
`operations` and `recover` commands take the provider's token through `--token`
or `EUDIPLO_TOKEN` ([CLI](cli.md#environment-variables)). `EudiploClient` of
`@eudiplo/sdk-core` and the CLI's other commands fetch tokens only from the
built-in server, so pass the provider's token yourself
([`@eudiplo/sdk-core`](../reference/api.md#eudiplosdk-core)). Which client
limits these tokens get is described in
[Tenants and access](tenants-and-access.md#external-oidc-provider-and-human-users).

## Example: Authentik

1. Create an **OAuth2/OpenID Provider** with an application, for example with the
   slug `eudiplo`. The issuer is
   `https://auth.example.com/application/o/eudiplo/`, with the trailing slash.
   Set **Client type** to **Public**, and under **Allowed grant types** select
   **Authorization code**, plus **Client credentials** for machine clients.
   Authentik refuses every grant type that is not selected; the browser then
   returns to the web client with `invalid_request`.
2. Select a **Signing Key**. Without one, Authentik signs with HS256 and the
   client secret, and publishes no keys.
3. Create a property mapping of type **OAuth2/OIDC scope mapping** with the scope
   name `openid` that returns the tenant and the roles of the user, for example
   from user attributes. Of the scopes that carry claims, the web client
   requests only `openid`, so a mapping under another scope name never reaches
   its tokens. Authentik merges it with its built-in `openid` mapping.

   ```python
   return {
       "tenant_id": user.attributes.get("tenant_id"),
       "roles": user.attributes.get("eudiplo_roles", []),
   }
   ```

4. Add the mapping to the provider's scopes and enable
   **Include claims in id_token**; without it, the claims reach only the
   userinfo endpoint, not the access token.
5. Add the provider's **Redirect URIs** of step 3: `<web client URL>/login`
   and `<web client URL>/silent-check-sso.html` of the type **Authorization**,
   and the web client's URL, with the trailing slash, of the type **Logout**.
   Without the logout entry, logging out ends on an Authentik page instead of
   the web client. Set `OIDC_UI_CLIENT_ID` to the provider's client ID.
6. Set the provider's **Invalidation flow** to `default-invalidation-flow`
   (**Logout**). The preset `default-provider-invalidation-flow` only logs out
   of the application and keeps the Authentik session, so the next
   **Login with SSO** signs the person in again without asking.
7. Decode an access token and set `OIDC_AUDIENCE` to its `aud` value. Authentik
   puts the provider's client ID there. Its access token is its ID token plus
   `azp`, `uid` and `scope`, with the same audience and no hash, so EUDIPLO
   cannot tell them apart and also accepts the provider's ID tokens as access
   tokens. When someone logs out, the web client passes the
   ID token to Authentik in the logout address (`id_token_hint`), where it can
   end up in browser history and proxy or access logs. Keep the provider's
   **Access token validity** short, to limit how long such a token can be used.
   When it expires, the web client asks the person to log in again, which
   happens without a password prompt while their Authentik session lasts.

For machine clients, create a service account with the `tenant_id` and
`eudiplo_roles` attributes and an app password. It gets tokens with
`grant_type=client_credentials`, the provider's `client_id`, the service
account's name as `username`, the app password as `password`, and
`scope=openid`. The details are in Authentik's
[machine-to-machine documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/machine_to_machine/).

## Provider notes

- **Zitadel** issues opaque access tokens by default: set the application's token
  type to JWT. Project roles arrive in `urn:zitadel:iam:org:project:roles` when
  the project asserts roles on authentication; set `OIDC_ROLES_CLAIM` to that
  name. EUDIPLO reads only the role names in that claim and ignores the
  organizations that granted them, so a role granted in any organization counts
  for the token's tenant. Grant the project's roles only in the organization
  that maps to that tenant, and add the tenant claim with an action.
- **Auth0** issues a JWT access token only for an API audience. Create an API,
  set its identifier as `OIDC_AUDIENCE` and as the tenant's default audience,
  because the web client sends no `audience` parameter. Custom claims must have
  namespaced names; add them in an action and set `OIDC_SUB` and
  `OIDC_ROLES_CLAIM` to those names.
- **Entra ID** must issue v2 access tokens (`requestedAccessTokenVersion: 2` in
  the app manifest); v1 tokens carry another issuer than the discovery document.
  App roles arrive in `roles`. Entra ID issues a token for your API only when a
  scope of that API is requested, which the web client does not do, so use it
  for machine clients.

## Troubleshooting

When startup fails at the discovery document, the error starts with "Could not
load the OIDC discovery document from `<URL>`:", followed by one of the reasons
in the first four rows.

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Startup fails: "the document names the issuer '…', but OIDC is '…'" | `OIDC` differs from the provider's issuer, often by the trailing slash | Copy `issuer` from the discovery document into `OIDC` |
| Startup fails: "…neither HTTPS nor at the origin of the discovery document" | The provider names its keys over plain HTTP at another origin (scheme, host and port) than the discovery document | Set `OIDC_JWKS_URI` to an HTTPS URL of the key set, or a plain HTTP URL only inside the deployment's private network (such as a Compose service name). Setting it skips the check, and whoever can change the keys on the way can sign tokens for any tenant |
| Startup fails: "the document has no valid issuer, jwks_uri, token_endpoint" (the missing values) | The URL in the error does not serve the provider's discovery document, or the document lacks these values | Check `OIDC`, or `OIDC_INTERNAL_ISSUER_URL` when set; the backend appends `/.well-known/openid-configuration` itself |
| Startup fails after about 60 seconds with a network error, "status code …" or a JSON error | The backend cannot reach the provider at the URL in the error, or something else answers there | Set `OIDC_INTERNAL_ISSUER_URL` to the address the backend reaches, or start the provider first |
| Startup warns: "The discovery document names the token endpoint … at the internal address" | The provider builds its URLs from the address the backend used (`OIDC_INTERNAL_ISSUER_URL`). EUDIPLO advertises this token endpoint to machine clients, which cannot reach it | Configure the provider's public host name, so its discovery document names public URLs |
| `401` "Access token is not a JWT…" | The provider issues opaque access tokens | Switch it to JWT access tokens (see the provider notes) |
| `401` "Not an access token: …" | The caller sent an ID token or another kind of token, or the provider puts another `typ` than `JWT` or `at+jwt` into its access tokens' header | Send the access token of the token response, not the ID token. If real access tokens get this, check their header's `typ` |
| `401` "Access token has no expiry" | The provider issues access tokens without `exp` | Give the provider's access tokens a lifetime |
| `401` without a reason | Wrong `aud`, `iss`, key or algorithm | Decode a token and compare it with step 1 |
| "This endpoint requires a tenant context" | The token has no tenant claim, or the tenant does not exist | Map the claim named by `OIDC_SUB`, and create the tenant |
| `403` on an endpoint | The roles claim lacks the role, or is not where `OIDC_ROLES_CLAIM` points | Check `GET /api/auth/me`, then the claim mapping |
| **Login with SSO** returns to the web client with `invalid_request` | The provider does not allow the authorization code grant for this client | Allow it on the provider's client; in Authentik, under **Allowed grant types** |
| Signed in, but `GET /api/auth/me` shows no tenant or roles | The provider adds the claims only for a scope the web client does not request | Add them for the scope `openid`, as in step 3 of the Authentik example |
| **Login with SSO** comes back from the provider to the login page; the browser console shows "Unable to decode token, payload not found" | The provider sent a refresh token that is not a JWT, which the web client cannot read | Do not let the web client's provider client issue refresh tokens, for example by not granting it `offline_access` |
| "Your session has expired" each time the access token expires | The provider issues the web client no refresh token (step 3) | Select **Log in**. A longer access token lifetime keeps people signed in longer, and keeps a leaked token usable longer too |
| After logging out, **Login with SSO** signs in without asking | Logging out ended only the web client's session, not the provider's | Make the provider end its session at its `end_session_endpoint`; in Authentik, with step 6 of the example |
| **Login with SSO** ends at the provider with an unknown client or redirect URI | `OIDC_UI_CLIENT_ID` is not the provider's public client, or its redirect URIs lack the web client's pages | Compare `ui_client_id` in `/.well-known/oauth-authorization-server` with the provider's client, and register the redirect URIs of step 3 |
