---
title: Roles
---

# Roles

The roles of the management API and the endpoints that accept them, generated
from the backend's role enum and the `@Secured` decorators of its controllers.
How to assign roles to clients and users is described in
[Tenants and access](../operate/tenants-and-access.md); the roles of the MCP
tools are listed in [AI assistants (MCP)](../operate/mcp.md#tools).

A caller passes the role check if it has **any** of an endpoint's roles;
where the roles are joined with "and", it needs **all** of them. With the
built-in OAuth2 server these are the client's current roles
([revoke access](../operate/tenants-and-access.md#revoke-access)), with Keycloak
the roles in the token.
Most endpoints also act on the tenant in the token and refuse a token without
one, such as the root client's. Without a tenant, `tenants:manage` works for the
`/api/tenant` endpoints and for rotating client secrets.
`GET /api/config-bundles/resources/:kind` and
`GET /api/config-bundles/resources/:kind/:id/document` also check the kind
([which roles](config-bundle-format.md#management-api)).

import RoleReference from "@site/src/components/RoleReference";

## Granting roles

A caller that creates or changes a client (`/api/client`) or a person
(`/api/user`) can grant only these roles:

| The caller has   | It can grant                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `tenants:manage` | every role                                                         |
| `tenant:admin`   | every role except `tenants:manage` and `tenant:admin`              |
| neither          | the roles it holds, except `tenants:manage` and `tenant:admin`     |

A caller can change or delete a client or person, or rotate a client's
secret, only if it holds or can grant each of its roles; `tenants:manage` can
rotate the secret of any client. A change may keep roles the caller cannot
grant, such as `tenant:admin` for a `tenant:admin` caller, but not add them.
The same rules apply to the clients that an imported
[configuration bundle](config-bundle-format.md) creates, changes or deletes,
and its plan already reports a refusal. Other requests answer `403`.

With Keycloak, the roles assigned in Keycloak count as well, including those
from groups and composite roles. Roles of the `realm-management` client, also
from groups and composite roles, and any other client role mapped directly to
the account, count as roles the caller does not hold, so such accounts are
managed in Keycloak only.

## Roles

The endpoint count of a role includes only the endpoints the role opens on its
own, not those that need it together with another role.

<RoleReference table="roles" />

## Endpoints

<RoleReference table="endpoints" />
