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
audience, an ID token of the same client would be accepted as well.

## 2. Configure EUDIPLO

```env
OIDC=https://auth.example.com/application/o/eudiplo/  # the issuer, exactly as the discovery document names it
OIDC_PROVIDER=generic
OIDC_AUDIENCE=<aud value of EUDIPLO's access tokens>
PUBLIC_URL=https://eudiplo.example.com
MASTER_SECRET=<random, 32+ characters>   # derives the default encryption key
# Optional
# OIDC_INTERNAL_ISSUER_URL=     # where the backend loads the discovery document, if not from OIDC
# OIDC_JWKS_URI=                # where the backend loads the signing keys, if not from the document's jwks_uri
# OIDC_SUB=tenant_id            # claim with the tenant
# OIDC_ROLES_CLAIM=             # claim or dot path with the roles
# OIDC_ALGORITHM=RS256          # RS256, PS256 or ES256
# OIDC_UI_CLIENT_ID=eudiplo-ui  # public client of the web client (step 3)
```

At startup, EUDIPLO loads `<OIDC_INTERNAL_ISSUER_URL or OIDC>/.well-known/openid-configuration`,
retrying for up to 60 seconds while the provider starts. It does not follow
redirects. Startup fails when the document names another issuer than `OIDC`,
lacks `issuer`, `jwks_uri` or `token_endpoint`, or names a key set over plain
HTTP at another host. `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_UI_URL`,
`AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are not used. All variables are listed
in the [environment variable reference](../reference/environment-variables.md#authentication).

**Checkpoint:** the backend log shows `Mode: External OIDC (generic)`, and
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
(see the provider notes below). Logging out also ends the session at the
provider when the provider has an `end_session_endpoint`.

The web client hides **API Clients** and **Users**: `/api/client`, `/api/user`
and creating a tenant with `roles` answer `501` in this mode. What else changes
is summarized in
[Tenants and access](tenants-and-access.md#external-oidc-provider-and-human-users).

**Checkpoint:** sign in with SSO as a person of a tenant. The menu shows the
pages of their roles; `GET /api/auth/me` returns their tenant and roles.

## 4. Machine clients

Backends and scripts get tokens with the client credentials grant at the
provider's token endpoint (advertised as `token_endpoint` in
`/.well-known/oauth-authorization-server`). Those tokens need the same audience,
tenant and roles claims as people's tokens; map them on the provider's machine
client or service account. The CLI and `EudiploClient` of `@eudiplo/sdk-core`
fetch tokens only from the built-in server, so pass the provider's token
yourself ([API reference](../reference/api.md#authentication)). These tokens get
no [client limits](tenants-and-access.md#api-clients-with-least-privilege),
unless a client record is left from an earlier mode.

## Example: Authentik

1. Create an **OAuth2/OpenID Provider** with an application, for example with the
   slug `eudiplo`. The issuer is
   `https://auth.example.com/application/o/eudiplo/`, with the trailing slash.
2. Select a **Signing Key**. Without one, Authentik signs with HS256 and the
   client secret, and publishes no keys.
3. Create a property mapping of type **OAuth2/OIDC scope mapping**, for example
   with the scope name `eudiplo`, that returns the tenant and the roles of the
   user, for example from user attributes:

   ```python
   return {
       "tenant_id": user.attributes.get("tenant_id"),
       "roles": user.attributes.get("eudiplo_roles", []),
   }
   ```

4. Add the mapping to the provider's scopes and enable
   **Include claims in id_token**; without it, the claims reach only the
   userinfo endpoint, not the access token.
5. Set the provider's **Redirect URIs** as in step 3, and set
   `OIDC_UI_CLIENT_ID` to its client ID.
6. Decode an access token and set `OIDC_AUDIENCE` to its `aud` value.

For machine clients, create a service account with the `tenant_id` and
`eudiplo_roles` attributes and an app password. It gets tokens with
`grant_type=client_credentials`, the provider's `client_id`, the service
account's name as `username`, the app password as `password`, and the scope of
the mapping (`scope=eudiplo`). The details are in Authentik's
[machine-to-machine documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/machine_to_machine/).

## Provider notes

- **Zitadel** issues opaque access tokens by default: set the application's token
  type to JWT. Project roles arrive in `urn:zitadel:iam:org:project:roles` when
  the project asserts roles on authentication; set `OIDC_ROLES_CLAIM` to that
  name. EUDIPLO ignores the organizations in that claim, so request tokens for
  one organization. Add the tenant claim with an action.
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

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Startup fails: "the document names the issuer '…', but OIDC is '…'" | `OIDC` differs from the provider's issuer, often by the trailing slash | Copy `issuer` from the discovery document into `OIDC` |
| Startup fails: "…neither HTTPS nor at the origin of the discovery document" | The provider names its keys over plain HTTP at another host | Set `OIDC_JWKS_URI` to a URL the backend reaches |
| Startup fails: "Could not load the OIDC discovery document…" | The backend cannot reach the provider within 60 seconds | Set `OIDC_INTERNAL_ISSUER_URL` to the address the backend reaches |
| `401` "Access token is not a JWT…" | The provider issues opaque access tokens | Switch it to JWT access tokens (see the provider notes) |
| `401` without a reason | Wrong `aud`, `iss`, key or algorithm, or no `exp` | Decode a token and compare it with step 1 |
| "This endpoint requires a tenant context" | The token has no tenant claim, or the tenant does not exist | Map the claim named by `OIDC_SUB`, and create the tenant |
| `403` on an endpoint | The roles claim lacks the role, or is not where `OIDC_ROLES_CLAIM` points | Check `GET /api/auth/me`, then the claim mapping |
| **Login with SSO** ends at the provider with an unknown client or redirect URI | `OIDC_UI_CLIENT_ID` is not the provider's public client, or its redirect URIs lack the web client's pages | Compare `ui_client_id` in `/.well-known/oauth-authorization-server` with the provider's client, and register the redirect URIs of step 3 |
