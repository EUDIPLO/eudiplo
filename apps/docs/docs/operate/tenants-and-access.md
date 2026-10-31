---
title: Tenants and Access
---

# Tenants and Access

Create tenants, give applications least-privilege API clients, and let people
sign in. Every management endpoint (`/api/...`) needs an OAuth 2.0 bearer token;
the roles and tenant of its client or person decide what the caller may do. The
roles are listed in the [roles reference](../reference/roles.md).

## Tenants

A tenant is one issuer and/or verifier: its credential, issuance and presentation
configurations, keys, trust lists, sessions and clients belong to it. All
records carry the tenant ID, and every request is scoped to the tenant in the
access token. Tenants have no lifecycle states besides `active`; to take a
tenant offline, delete it (below). Deleting its clients only ends their API
access ([revoke access](#revoke-access)): people who sign in with Keycloak keep
theirs, and wallets can still finish the offers and requests already sent.

### Create a tenant

With a token that has `tenants:manage` (for example the root client below):

```bash
curl -X POST https://eudiplo.example.com/api/tenant \
  -H "Authorization: Bearer $ROOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "acme",
    "name": "Acme GmbH",
    "roles": ["issuance:manage", "presentation:manage", "tenant:admin"]
  }'
```

`POST /api/tenant` accepts only IDs that use lowercase letters, digits, `-` and
`_`, start with a letter or digit and have at most 63 characters, since the ID
is also the name of the tenant's folder in `CONFIG_FOLDER`; other IDs answer
`400`. The startup import does not check folder names against this rule, so
name tenant folders by it as well.

If you pass `roles`, EUDIPLO also creates the client `acme-admin` with
`clients:manage` plus these roles, and returns its secret once in the response.
Use that client to set up the tenant and to create narrower clients. It can
hand out only `clients:manage` and these roles, unless they include
`tenant:admin` ([granting roles](../reference/roles.md#granting-roles)), so
choose them with that in mind. The root client has no tenant and cannot change
a tenant's clients, but sending `POST /api/tenant` again for the existing
tenant, with its name and all roles the admin client needs, gives that client
the roles; with the built-in server it also returns a new secret.
`DELETE /api/tenant/:id` removes the tenant with its data and files. Tenants can
also be created from a config folder with an `info.json`
([configuration as code](configuration-as-code.md)).

## API authentication

### Built-in OAuth2 server

Without `OIDC`, EUDIPLO issues tokens itself with the client credentials grant:

```bash
curl -X POST https://eudiplo.example.com/api/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=acme-admin \
  -d client_secret="$CLIENT_SECRET"
```

The client can also send its credentials with HTTP Basic authentication. Tokens
are signed with `MASTER_SECRET` and expire after 24 hours. The response has no
refresh token; request a new token with the client credentials. Use tokens as
`Authorization: Bearer <token>`. The Swagger UI of the
management API is at `/api/docs` (its **Authorize** button uses the same
endpoint); the wallet-facing protocol API is documented at `/docs`.

On the first start, EUDIPLO creates the root client from `AUTH_CLIENT_ID` and
`AUTH_CLIENT_SECRET`. It has `tenants:manage` and belongs to no tenant, so it
can create and manage tenants (each new tenant gets a `<tenant>-admin` client)
and rotate client secrets, but cannot call tenant-scoped endpoints such as
clients, issuance or presentation configs. Changing the two variables later does not
change the stored client; rotate its secret with
`POST /api/client/<client-id>/rotate-secret` instead.

### API clients with least privilege

Create one client per application, with only the roles it needs. A token with
`clients:manage` creates clients in its own tenant, with the roles it can hand
out, for example the `acme-admin` client above:

```bash
curl -X POST https://eudiplo.example.com/api/client \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "shop-backend",
    "description": "Issues membership cards and checks age",
    "roles": ["issuance:offer", "presentation:request"],
    "allowedIssuanceConfigs": ["membership"],
    "allowedPresentationConfigs": ["age-check"]
  }'
```

The response contains the generated secret once; it is stored as a bcrypt hash
and cannot be read again. Rotate it with `POST /api/client/:id/rotate-secret`;
with the built-in server, tokens issued with the old secret stop working at
once ([revoke access](#revoke-access)).
Client IDs may contain letters, digits, `.`, `_`, `:` and `-`, and are unique
across all tenants: an ID that is already taken answers `409`.

`allowedIssuanceConfigs` limits the credential configuration IDs the client may
put in offers, `allowedPresentationConfigs` the presentation configurations it
may request. Other IDs are rejected with `403`; an empty or missing list allows
all.

The session endpoints (`/api/session`) need `issuance:offer`,
`presentation:request` or `sessions:read`. Without `sessions:read`, a client
sees only the sessions of its side: issuance sessions with `issuance:offer` or
`issuance:manage`, presentation sessions with `presentation:request` or
`presentation:manage`. Other sessions are left out of the list, answer `404`
and are not deleted. `sessions:read` reads the sessions of both sides, with
their logs, events, counts and credential status, including issued claims and
presented credentials, but creates, cancels and deletes none; together with
`issuance:offer` or `presentation:request`, a client still cancels and deletes
only the sessions of that side. Of the session types a client with
`sessions:read` cannot cancel, which also holds for `issuance:manage` or
`presentation:manage` without `issuance:offer` or `presentation:request`, it
sees only the sessions a wallet can no longer use: redeemed, answered or in a
final status. The others are left out of the list and answer `404`,
because the session ID of an ISO 18013-7 request, or of an offer created
before 10.0, alone lets a wallet answer or redeem it; the counts include them.
The sessions it sees come without the values
a wallet redeems or answers them with, such as the offer and request URIs and
the transaction code. Changing credential status
(`POST /api/session/revoke`) needs `credentials:status` or `issuance:manage`.

Typical role sets:

| Caller                                   | Roles                                                         |
| ---------------------------------------- | ------------------------------------------------------------- |
| Your application backend                 | `issuance:offer`, `presentation:request`; also `credentials:status` if it revokes or suspends credentials |
| Support staff who look up sessions and revoke credentials | `sessions:read`, `credentials:status`        |
| Auditor                                  | `audit:read`, `sessions:read`                                 |
| Key custodian                            | `keys:manage`                                                 |
| CI pipeline that imports configuration   | `tenant:admin`                                                |
| Person who configures a tenant           | `issuance:manage`, `presentation:manage`, `clients:manage`, `users:manage`, and the roles they hand out; `tenant:admin` instead also allows key export and KMS settings |
| Platform operator                        | `tenants:manage`, on a client without a tenant                |

`issuance:manage`, `presentation:manage` and `keys:manage` create, import,
rotate and delete key chains, but exporting a key chain with its private key
(`GET /api/key-chain/{id}/export` or its configuration document) and the tenant KMS provider configuration
(`/api/key-chain/providers/config`), which contains provider credentials, need
`tenant:admin` or `tenants:manage`, like configuration bundles.

A caller hands out only roles it holds, or with `tenant:admin` every role
except `tenants:manage` and `tenant:admin`, and cannot change or take over a
client or user with more rights than its own
([granting roles](../reference/roles.md#granting-roles)).

### Revoke access

With the built-in server, EUDIPLO reads the client on every request: a token is
accepted only while its client exists in the token's tenant, and with the roles,
`allowedIssuanceConfigs` and `allowedPresentationConfigs` the client has now.
Deleting a client (`DELETE /api/client/:id`) ends its access at once; changing
its roles or limits applies to the tokens it already has.

A token is accepted only for the client and secret it was issued for. A client
created again with the same ID, including `<tenant>-admin` when you create a
deleted tenant again, does not revive the old tokens. A new secret ends the
client's tokens at once, also a token requested while the secret changed:

- `POST /api/client/:id/rotate-secret`;
- `POST /api/tenant` with `roles` for an existing tenant, which gives
  `<tenant>-admin` a new secret;
- a configuration bundle import with another secret, or with `!generate` for
  an existing client;
- a startup import with another secret. A client file without `secret` gets a
  new random secret on every start in `upsert` or `replace` mode, so set the
  secret in the file.

Importing the secret the client already has keeps its tokens, also when the
startup import in `upsert` or `replace` mode re-creates the client. To change a
secret without interrupting an integration, create a second client, switch the
integration to it, then delete the first one.

With Keycloak, EUDIPLO checks tokens without asking Keycloak. Deleting a client
also deletes it in Keycloak, which then issues no new tokens to it, but the
tokens it already has stay valid until they expire (the realm's access token
lifespan, 5 minutes by default), as they do after a new secret, and during that
time its config limits no longer apply. Keep that lifespan short. Changes to
the limits apply at once, role changes in Keycloak with the next token.

## External OIDC provider and human users

To let people sign in with their own accounts, set `OIDC` to a Keycloak realm
(OIDC mode always uses Keycloak's admin API). Then:

- EUDIPLO accepts Keycloak access tokens instead of issuing its own; the
  built-in `POST /api/oauth2/token` is disabled.
- The web client signs people in with the authorization code flow and PKCE.
- Clients created through `/api/client` are Keycloak clients, and people are
  managed through `/api/user` (role `users:manage`) or in the web client. Without
  `OIDC`, `/api/user` answers `501`.
- Access tokens must carry the tenant ID in the claim named by `OIDC_SUB`
  (default `tenant_id`) and the roles in `roles` or `realm_access.roles`.

The variables and the Keycloak setup are described in [Keycloak SSO](keycloak.md).
`MASTER_SECRET` is optional in OIDC mode, but the default encryption key is
derived from it; set it, or use another
[encryption key source](encryption-keys.md).
