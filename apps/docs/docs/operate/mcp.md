---
title: AI assistants (MCP, experimental)
sidebar_label: AI assistants (MCP)
---

:::caution[Experimental]
The MCP endpoint and its tools may change in minor releases.
:::

Let an AI assistant or another [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) client read a tenant's configurations and sessions, for example to ask
why offers failed today. The endpoint is off by default and its tools only read.

**Prerequisites:** a token with `clients:manage` in the tenant, and either the
roles you give the assistant or `tenant:admin`
([granting roles](../reference/roles.md#granting-roles)), and an MCP client
that supports Streamable HTTP with a custom `Authorization` header.

## 1. Enable the endpoint

```env
MCP_ENABLED=true
```

After a restart, EUDIPLO serves `POST /api/mcp` over Streamable HTTP. It keeps
no session between requests, so it works behind any load balancer. The route is
part of the management API: your [WAF rules](waf.md) for `/api/*` apply, and
it is not in the OpenAPI document. `CORS_ORIGINS` does not open it to browser
pages ([limits](#limits)).

## 2. Create a client for the assistant

Give the assistant a client of its own with the roles of the tools it needs
([tools](#tools)), as described in
[API clients with least privilege](tenants-and-access.md#api-clients-with-least-privilege):

```bash
curl -X POST https://eudiplo.example.com/api/client \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "assistant",
    "description": "AI assistant, reads sessions",
    "roles": ["sessions:read"]
  }'
```

Keep the `clientSecret` of the response; it is shown only once. The token works for the whole management API, not only for `/api/mcp`, so a
role allows the assistant everything it allows elsewhere: with
`issuance:manage`, it could also change credential configurations through
`/api/issuer/credentials`. `sessions:read` alone changes nothing, but through
`GET /api/session/{id}` it also reads issued claims and presented credentials.

## 3. Get an access token

Request a token for `assistant` with the client credentials grant
([built-in OAuth2 server](tenants-and-access.md#built-in-oauth2-server)). The
assistant cannot renew it: when it expires, request a new one and update the
assistant's configuration. With [Keycloak](keycloak.md), use a token of a
Keycloak client; it lasts only the realm's access token lifespan, 5 minutes by
default ([revoke access](tenants-and-access.md#revoke-access)). Set
`OIDC_AUDIENCE` there, so that EUDIPLO accepts only tokens issued for it
([Keycloak](keycloak.md#accept-only-tokens-issued-for-eudiplo)).

## 4. Connect the assistant

Point the MCP client at `https://eudiplo.example.com/api/mcp` and send the
token as `Authorization: Bearer <token>`. In Claude Code, for example:

```bash
claude mcp add --transport http eudiplo https://eudiplo.example.com/api/mcp \
  --header "Authorization: Bearer $EUDIPLO_TOKEN"
```

**Checkpoint:** ask the assistant which EUDIPLO tenant it is connected to. It
calls `get_caller` and answers with the tenant and the client's roles.

## Tools

Every tool reads only the tenant of the token and needs one of the roles of the
management endpoint it mirrors. A call without them answers with the roles it
needs.

| Tool | Returns | Roles | Mirrors |
| --- | --- | --- | --- |
| `get_caller` | Tenant, client ID and EUDIPLO roles of the token, EUDIPLO version | Any EUDIPLO role | — |
| `list_sessions` | One page of session summaries; takes the filters of the session list | `issuance:offer`, `presentation:request` or `sessions:read` | `GET /api/session` |
| `get_session_stats` | Session counts per type and status, frequent failure codes, retention settings | `issuance:offer`, `presentation:request` or `sessions:read` | `GET /api/session/stats` |
| `list_credential_configurations` | ID, description, display name, format, vct or docType, status management | `issuance:manage` | `GET /api/issuer/credentials` |
| `list_presentation_configurations` | ID, description, and the DCQL query ID, format and vct values or docType of each requested credential | `presentation:manage` or `presentation:request` | `GET /api/verifier/config` |

The root client (`tenants:manage`, no tenant) can only call `get_caller`.

## What the assistant receives

The assistant sends every tool result to its language model, so the tools
return less than the endpoints they mirror:

- **Sessions** come as the summaries of the session list: ID, status,
  timestamps, presentation configuration, failure code and the `reference` of
  the offer or presentation request. Claims, presented credentials, offer and
  request URIs and codes are never returned. The visibility rules of the
  session endpoints apply
  ([API clients with least privilege](tenants-and-access.md#api-clients-with-least-privilege)).
- **Failure codes** come as `[withheld]` unless they are one of EUDIPLO's
  [failure codes](../reference/session-outcome.md#failure-codes) or an error
  code that OAuth 2.0 or OpenID4VP defines for wallets. A wallet chooses the
  error code of its response, and the assistant would read any other text as
  part of the answer.
- **Configurations** come without claim templates, keys, webhooks and
  registration certificates.

Keep personal data out of the `reference` of offers and presentation requests,
as the API asks.

## Limits

- **No sign-in from the client.** The endpoint answers `401` without OAuth
  protected resource metadata, so an MCP client cannot obtain a token by
  itself. Give it a token as in step 3.
- **Streamable HTTP only.** There is no stdio transport. With a valid token,
  `GET` and `DELETE` on the endpoint answer `405`.
- **No browser pages on other hosts.** A request whose `Origin` header names
  another host than `localhost`, `127.0.0.1` or `[::1]` answers `403`, also
  for origins in `CORS_ORIGINS`. MCP clients outside a browser send no
  `Origin` header.
- **Read only.** Creating offers or presentation requests, cancelling sessions
  and changing configurations stay in the management API and the web client.
