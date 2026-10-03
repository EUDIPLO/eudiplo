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
[authorization servers](../issuance/authorization-servers.md) guide.

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
# Optional, defaults shown
# OIDC_UI_CLIENT_ID=eudiplo-ui
# OIDC_SUB=tenant_id            # claim that carries the tenant
# OIDC_ALGORITHM=RS256          # RS256, PS256 or ES256
# OIDC_INTERNAL_ISSUER_URL=     # expected token issuer, defaults to OIDC
# Optional: a Keycloak client with tenants:manage for automation
AUTH_CLIENT_ID=root
AUTH_CLIENT_SECRET=<secret>
```

EUDIPLO validates access tokens against the issuer `OIDC_INTERNAL_ISSUER_URL`
(default: `OIDC`) and loads the signing keys from
`<issuer>/protocol/openid-connect/certs`. Leave it unset unless the `iss` of
your tokens differs from `OIDC`.

On every start, EUDIPLO:

- creates the missing realm roles (the [EUDIPLO roles](../reference/roles.md)),
- creates or updates the public client `eudiplo-ui`, with redirect URIs and web
  origins set to `*`,
- creates or updates the `AUTH_CLIENT_ID` client with `tenants:manage`, if both
  `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are set.

Restrictive redirect URIs that you set on `eudiplo-ui` are overwritten at the next
start, so restrict access to the web client at the network level if needed.

**Checkpoint:** the backend log shows `Mode: External OIDC`, and the web client's
login page offers single sign-on after you enter the backend URL.

## 3. Put the tenant into user tokens

EUDIPLO reads the tenant from the `tenant_id` claim (`OIDC_SUB`) and the roles
from `roles` or `realm_access.roles`. Service clients created through EUDIPLO
get both claims automatically. For people, add the tenant claim once:

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
and `clients:manage` and `users:manage` for tenant administrators.

**Checkpoint:** sign in to the web client as a tenant user. The dashboard loads
and shows only that tenant's data.

## Troubleshooting

| Symptom                                              | Cause                                                       | Fix                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Startup fails with `reading 'split'`                 | Refresh tokens for client credentials disabled on `eudiplo-admin` | Enable **Use refresh tokens for client credentials grant**                     |
| API calls return 401 after login                     | Token `iss` differs from `OIDC_INTERNAL_ISSUER_URL`/`OIDC`, or wrong `OIDC_ALGORITHM` | Compare the `iss` and `alg` of a token with the configuration |
| `This endpoint requires a tenant context`            | User token has no `tenant_id` claim                         | Add the mapper from [step 3](#3-put-the-tenant-into-user-tokens)                       |
| `403` on an endpoint                                 | Missing realm role                                          | Assign the role listed for the endpoint in the [roles reference](../reference/roles.md#endpoints) |
