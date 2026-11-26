---
title: Roles
---

# Roles

The roles of the management API and the endpoints that accept them, generated
from the backend's role enum and the `@Secured` decorators of its controllers.
The [list of all roles](#all-roles) says what each role is for. How to assign roles to
clients and users is described in
[Tenants and access](../operate/tenants-and-access.md).

import RoleReference from "@site/src/components/RoleReference";

## How the role check works

- A caller passes the role check if it has **any** of an endpoint's roles;
  where the roles are joined with "and", it needs **all** of them.
- With the built-in OAuth2 server these are the client's current roles
  ([revoke access](../operate/tenants-and-access.md#revoke-access)), with
  Keycloak the roles in the token.
- Most endpoints also act on the tenant in the token and refuse a token without
  one, such as the root client's, with `403` "This endpoint requires a tenant
  context". A token whose tenant does not exist counts as one without.

A few endpoints work without a tenant:

| Endpoint                                                                                   | Without a tenant, needs              |
| ------------------------------------------------------------------------------------------ | ------------------------------------ |
| `/api/tenant`                                                                              | `tenants:manage`                     |
| `POST /api/client/:id/rotate-secret`                                                       | `tenants:manage`                     |
| `/api/cache`, except `DELETE /api/cache/trust-list/sequence-numbers`                       | `tenants:manage`                     |
| `POST /api/config-bundles/documents/upgrade`                                               | `tenants:manage` or `tenant:admin`   |

With `tenants:manage`, the cache endpoints cover the caches of all tenants; with
`issuance:manage` or `presentation:manage` they need a tenant and cover only
that tenant ([which entries](../trust/trust-lists.md#caching)).
`GET /api/config-bundles/resources/:kind` and
`GET /api/config-bundles/resources/:kind/:id/document` also check the kind
([which roles](config-bundle-format.md#management-api)).

## Granting roles

Creating or changing clients (`/api/client`) needs `clients:manage`, and people
(`/api/user`) `users:manage`. Which roles the caller can then give out depends
on what else it has:

| The caller has   | It can grant                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `tenants:manage` | every role                                                         |
| `tenant:admin`   | every role except `tenants:manage` and `tenant:admin`              |
| neither          | only the roles it holds itself, except `tenants:manage` and `tenant:admin` |

For example, a client with `clients:manage` and `presentation:request` can
create clients with `clients:manage`, `presentation:request` or both. To create
a client with `issuance:offer`, it needs `issuance:offer` itself,
`tenant:admin` or `tenants:manage`. Other requests answer `403`.

The `<tenant>-admin` client is bound by the same rule, so choose its roles
with care when you
[create a tenant](../operate/tenants-and-access.md#create-a-tenant).

### Changing, deleting and taking over

- A caller can change or delete a client or person, or rotate a client's
  secret, only if it holds or can grant **each** of its roles. No caller can
  take over an account with more rights than its own.
- A change may keep roles the caller cannot grant, but not add them. A
  `tenant:admin` caller can, for example, change a client that has
  `tenant:admin` without removing that role.
- `tenants:manage` can rotate the secret of any client (with Keycloak,
  see [below](#with-keycloak)). A `file-managed` client answers `409` until a token of the client's tenant
  [detaches](../operate/configuration-as-code.md#configuration-model) it.
- The same rules apply to the clients that an imported
  [configuration bundle](config-bundle-format.md) creates, changes or deletes,
  and its plan already reports a refusal.
- Only roles count: the caller's own `allowedIssuanceConfigs` and
  `allowedPresentationConfigs` do not limit the lists it sets on a client, so a
  caller with `clients:manage` is not bound by its own lists
  ([API clients with least privilege](../operate/tenants-and-access.md#api-clients-with-least-privilege)).

### With Keycloak

- The roles assigned in Keycloak count as well, including those from groups
  and composite roles.
- Roles of the `realm-management` client, also from groups and composite
  roles, and any other client role mapped directly to the account, count as
  roles the caller does not hold. Such accounts are managed in Keycloak only.
- Creating a client that takes over an existing Keycloak client of the tenant
  needs both: the caller must be able to manage that client, and grant each
  requested role, since none counts as one the client already has
  ([Keycloak SSO](../operate/keycloak.md#4-give-people-access)).
- Only clients EUDIPLO manages for a tenant have their secret rotated: other
  clients of the realm, including EUDIPLO's own `OIDC_CLIENT_ID` and
  `AUTH_CLIENT_ID` clients, answer `404`.

## All roles

The endpoint count of a role includes only the endpoints the role opens on its
own, not those that need it together with another role.

<RoleReference table="roles" />

## Endpoints

<RoleReference table="endpoints" />
