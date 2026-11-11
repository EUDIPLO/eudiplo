---
title: Keycloak SSO
---

# Keycloak SSO

Use Keycloak as the identity provider of the management API: people sign in to
the web client with their Keycloak account, and EUDIPLO creates tenant service
clients and users in Keycloak. What changes in this mode is summarized in
[Tenants and access](tenants-and-access.md#external-oidc-provider-and-human-users).

Keycloak as the login for *wallet users* during credential issuance (chained
authorization server) is a different setup, configured per tenant in the
[authorization servers](../issuance/authorization-servers.md) guide; the
[Issue after login](../cookbooks/issue-after-login.md) cookbook walks through it.

## Before you start

- Keycloak 22 or later, reachable from the EUDIPLO backend and from browsers
- EUDIPLO and the web client deployed at their final HTTPS URLs
- A realm for EUDIPLO, for example `eudiplo`

EUDIPLO uses two Keycloak clients:

| Client          | Type         | Purpose                                                                         | Setting                                   |
| --------------- | ------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `eudiplo-admin` | Confidential | Backend access to the Keycloak admin API: realm roles, users, tenant clients     | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`    |
| `eudiplo-ui`    | Public       | Sign-in to the web client with authorization code and PKCE                      | `OIDC_UI_CLIENT_ID` (default `eudiplo-ui`) |

## 1. Create the admin client

1. In the realm, go to **Clients > Create client** and create the OpenID Connect
   client `eudiplo-admin`.
2. Enable **Client authentication** and **Service account roles**; disable
   **Standard flow** and **Direct access grants**.
3. Under **Service account roles**, assign the `realm-management` role
   `realm-admin`. EUDIPLO creates realm roles and manages users, clients, client
   secrets and service-account role mappings. To use a narrower role set, check
   that it covers all of these.
4. In the client's **Advanced** settings, enable
   **Use refresh tokens for client credentials grant**. Without it, startup can
   fail with `Cannot read properties of undefined (reading 'split')`.
5. Copy the secret from the **Credentials** tab.

## 2. Configure EUDIPLO

```env
OIDC=https://keycloak.example.com/realms/eudiplo
OIDC_CLIENT_ID=eudiplo-admin
OIDC_CLIENT_SECRET=<secret of eudiplo-admin>
PUBLIC_URL=https://eudiplo.example.com
MASTER_SECRET=<random, 32+ characters>   # derives the default encryption key
OIDC_UI_URL=https://console.example.com  # where the web client is served, comma-separated for several
# Optional, defaults shown
# OIDC_UI_CLIENT_ID=eudiplo-ui
# OIDC_SUB=tenant_id            # claim that carries the tenant
# OIDC_ALGORITHM=RS256          # RS256, PS256 or ES256
# OIDC_INTERNAL_ISSUER_URL=     # expected token issuer, defaults to OIDC
# OIDC_AUDIENCE=                # aud value tokens must carry, checked only when set (see below)
# OIDC_ROLES_CLAIM=             # claim with the roles; leave unset with Keycloak (see step 3)
# Optional: a Keycloak client with tenants:manage for automation
AUTH_CLIENT_ID=root
AUTH_CLIENT_SECRET=<secret>
```

EUDIPLO validates access tokens against the issuer `OIDC_INTERNAL_ISSUER_URL`
(default: `OIDC`) and loads the signing keys from
`<issuer>/protocol/openid-connect/certs`. Leave it unset unless the `iss` of
your tokens differs from `OIDC`.

`OIDC_AUDIENCE` is off by default: Keycloak access tokens carry `aud: account`.
To require your own audience, create a client scope with an **Audience** mapper
that adds the value to the access token, and make it a **Default** client scope
of the realm (**Client scopes**, type **Default**), so that `eudiplo-ui`, the
clients EUDIPLO creates and the `AUTH_CLIENT_ID` client all get it. Then set
`OIDC_AUDIENCE` to that value.

Keycloak adds a realm default client scope only to clients created after it
became a default, and EUDIPLO assigns no scopes when it creates or updates a
client. On an existing installation, also add the scope to `eudiplo-ui`, the
`AUTH_CLIENT_ID` client and every tenant client created before: open the
client under **Clients**, then **Client scopes > Add client scope**, type
**Default**. Otherwise their tokens get `401` once `OIDC_AUDIENCE` is set.

On every start, EUDIPLO:

- creates the missing realm roles (the [EUDIPLO roles](../reference/roles.md)),
- creates or updates the public client `eudiplo-ui` (see below) and sets its
  valid post-logout redirect URIs to `+` (the redirect URIs), so logging out in
  the web client also ends the Keycloak session and returns to the web client,
- creates or updates the `AUTH_CLIENT_ID` client with `tenants:manage`, if both
  `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are set.

`eudiplo-ui` is a public client: whoever receives one of its authorization codes
can exchange it for the signed-in person's tokens. Keycloak must therefore send
codes only to the web client. With `OIDC_UI_URL` set, EUDIPLO sets the client's
redirect URIs to the pages under each URL (`https://console.example.com/*`) and
its web origins to their origins, on every start. A path, as in
`https://example.com/eudiplo-client/` for a web client behind
`CLIENT_BASE_HREF`, is kept.

Without `OIDC_UI_URL`, EUDIPLO keeps the redirect URIs and web origins set in
Keycloak, so you can manage them there, but removes the redirect URI `*`, which
EUDIPLO 9.x set and which lets any website receive codes. A web origin `*`
becomes `+` (the origins of the redirect URIs), as does an empty list of web
origins. If no redirect URI is left, the backend logs a warning and nobody can
sign in to the web client with SSO.

**Checkpoint:** the backend log shows `Mode: External OIDC (keycloak)` and no
warning about `eudiplo-ui`, and the web client's login page offers single
sign-on after you enter the backend URL.

## 3. Put the tenant into user tokens

EUDIPLO reads the tenant from the `tenant_id` claim (`OIDC_SUB`) and the roles
from `roles` or `realm_access.roles`. Service clients created through EUDIPLO
get both claims automatically, so leave `OIDC_ROLES_CLAIM` unset with Keycloak:
a claim these clients do not carry leaves them without roles. For people, add
the tenant claim once:

1. In Keycloak 24 or later, declare the user attribute `tenant_id` in
   **Realm settings > User profile** (or enable unmanaged attributes), so Keycloak
   keeps the attribute that EUDIPLO sets on users.
2. Create a client scope, for example `eudiplo-tenant`, with a **User Attribute**
   mapper: user attribute `tenant_id`, token claim name `tenant_id`, added to the
   access token.
3. Add the scope as a **Default** client scope of `eudiplo-ui`.

Realm roles are in `realm_access.roles` by default.

## 4. Give people access

- **Platform administrators:** assign the realm role `tenants:manage`. They do
  not need a `tenant_id`.
- **Tenant users:** create them in the web client or with `POST /api/user`
  (role `users:manage`). EUDIPLO stores them in Keycloak with the `tenant_id`
  attribute of the caller's tenant, assigns the requested roles and returns a
  temporary password. Do not change that attribute in Keycloak; EUDIPLO uses it
  to keep users in their tenant.
- **Applications:** create service clients in the web client or with
  `POST /api/client`. EUDIPLO creates them in Keycloak with mappers for
  `tenant_id` and `roles`; they get tokens from Keycloak's token endpoint with
  the client credentials grant.

Choose the roles from the [roles reference](../reference/roles.md), for example
`issuance:manage` and `presentation:manage` for people who configure a tenant,
or `sessions:read` and `credentials:status` for support staff who look up
sessions and revoke credentials.
Tenant administrators need `clients:manage` and `users:manage` plus every role
they hand out ([granting roles](../reference/roles.md#granting-roles)), or
`tenant:admin`, which also allows key export and KMS settings. Roles you assign
in Keycloak, also through groups, count for that check. When an update of a
user or client (`PATCH /api/user/{id}`, `PATCH /api/client/{id}` or a
configuration bundle) sets `roles`, EUDIPLO replaces only the EUDIPLO realm
roles mapped directly to it; Keycloak's default roles, other realm roles and
roles from groups stay. An update without `roles` keeps all of them.

**Checkpoint:** sign in to the web client as a tenant user. The dashboard loads
and shows only that tenant's data.

## Troubleshooting

| Symptom                                              | Cause                                                       | Fix                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Startup fails with `reading 'split'`                 | Refresh tokens for client credentials disabled on `eudiplo-admin` | Enable **Use refresh tokens for client credentials grant**                     |
| Keycloak shows "Invalid parameter: redirect_uri" after **Login with SSO** | The web client's URL is not a redirect URI of `eudiplo-ui` | Add it to `OIDC_UI_URL` and restart the backend, or add `<web client URL>/*` as redirect URI of `eudiplo-ui` in Keycloak when `OIDC_UI_URL` is unset |
| API calls return 401 after login                     | Token `iss` differs from `OIDC_INTERNAL_ISSUER_URL`/`OIDC`, or wrong `OIDC_ALGORITHM` | Compare the `iss` and `alg` of a token with the configuration |
| API calls return 401 since `OIDC_AUDIENCE` was set   | The token's `aud` lacks the value                           | Add the audience mapper to a realm default client scope, as in [step 2](#2-configure-eudiplo). Clients that existed before the scope became a default need it added in each client's **Client scopes** tab |
| `This endpoint requires a tenant context`            | User token has no `tenant_id` claim                         | Add the mapper from [step 3](#3-put-the-tenant-into-user-tokens)                       |
| `403` on an endpoint                                 | Missing realm role                                          | Assign the role listed for the endpoint in the [roles reference](../reference/roles.md#endpoints) |
| `403` "Cannot grant …" or "Cannot manage …"          | The roles involved go beyond the caller's own               | Assign the realm role to the caller in Keycloak ([granting roles](../reference/roles.md#granting-roles)). A target with a `realm-management` role or another client role can only be managed in Keycloak |
