---
title: Roles
---

# Roles

The roles of the management API and the endpoints that accept them, generated
from the backend's role enum and the `@Secured` decorators of its controllers.
How to assign roles to clients and users is described in
[Tenants and access](../operate/tenants-and-access.md).

A token passes the role check if it carries **any** of an endpoint's roles.
Most endpoints also act on the tenant in the token and refuse a token without
one, such as the root client's. Without a tenant, `tenants:manage` works for the
`/api/tenant` endpoints and for rotating client secrets.

import RoleReference from "@site/src/components/RoleReference";

## Roles

<RoleReference table="roles" />

## Endpoints

<RoleReference table="endpoints" />
