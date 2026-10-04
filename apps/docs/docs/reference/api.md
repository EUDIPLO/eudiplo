---
title: API Reference
description: Where the OpenAPI specification lives, how to authenticate, and how to call the API with @eudiplo/sdk-core.
---

# API reference

Every EUDIPLO instance serves its own OpenAPI specification, so the reference always matches the running version. Your backend calls the management API under `/api`; wallets call the protocol endpoints at the root path.

## Specifications

| API            | Swagger UI  | OpenAPI JSON     | Contents                                                                                       |
| -------------- | ----------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Management API | `/api/docs` | `/api/docs-json` | Everything under `/api`: tenants, clients, configurations, key chains, offers, sessions, lists |
| Protocol API   | `/docs`     | `/docs-json`     | Wallet-facing OID4VCI, OID4VP and ISO 18013-7 endpoints, metadata, status and trust lists      |

Both are OpenAPI 3.1 documents. In Swagger UI, choose **Authorize** to call the management API with a client's credentials.

## Path prefixes

Management endpoints carry the `/api` prefix, for example `POST /api/issuer/offer`. Wallet-facing and public endpoints are served without it:

| Path                                                | Purpose                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `/.well-known/...`                                  | Issuer and authorization server metadata, JWKS                       |
| `/issuers/{tenant}/vci/...`                         | Credential offer, credential, deferred, notification and nonce endpoints |
| `/issuers/{tenant}/authorize/...`                   | Built-in authorization server (PAR, authorize, token, interactive)   |
| `/issuers/{tenant}/chained-as/...`                  | Chained authorization server                                         |
| `/issuers/{tenant}/authorization-servers/{id}/...`  | OID4VP-based authorization servers                                   |
| `/issuers/{tenant}/credentials-metadata/...`        | SD-JWT VC type metadata                                              |
| `/issuers/{tenant}/status-management/...`           | Status lists                                                         |
| `/issuers/{tenant}/trust-list/...`                  | Published trust lists                                                |
| `/presentations/{id}/oid4vp/...`                    | OID4VP request object and response endpoint                          |
| `/presentations/{session}/iso-18013-7`              | ISO 18013-7 Annex C response endpoint                                |
| `/storage/{key}`                                    | Public files such as credential logos                                |
| `/health`                                           | Health check                                                         |

When you restrict network access to the management API, keep the wallet-facing paths reachable from the internet.

## Authentication

Management endpoints require a bearer token of an API client. Which client holds which roles is described in [Tenants and access](../operate/tenants-and-access.md).

With the built-in OAuth 2.0 server (the default), request a token with the client credentials grant:

```bash
curl -X POST https://eudiplo.example.com/api/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=membership-backend \
  -d client_secret="$CLIENT_SECRET"
```

The endpoint accepts the credentials in the form or JSON body or as HTTP Basic authentication. The response contains an `access_token` that is valid for 24 hours (`expires_in: 86400`); send it as `Authorization: Bearer <token>`. `GET /.well-known/oauth-authorization-server` advertises the token endpoint for OAuth client libraries.

When `OIDC` is set, for example to use [Keycloak](../operate/keycloak.md), `/api/oauth2/token` is disabled and tokens come from the external provider.

This includes the session event stream `GET /api/session/{id}/events`, which does not accept tokens in the URL. Browsers cannot set headers on an `EventSource`, so read the stream from your backend.

## `@eudiplo/sdk-core`

`@eudiplo/sdk-core` is the TypeScript client for the management API. It works in Node.js 20+ and in browsers.

```bash
npm install @eudiplo/sdk-core
```

`EudiploClient` covers the common flows. It fetches and renews the token from `/api/oauth2/token` itself:

```typescript
import { EudiploClient } from "@eudiplo/sdk-core";

const eudiplo = new EudiploClient({
  baseUrl: "https://eudiplo.example.com",
  clientId: process.env.EUDIPLO_CLIENT_ID!,
  clientSecret: process.env.EUDIPLO_CLIENT_SECRET!,
});

const { uri, sessionId } = await eudiplo.createPresentationRequest({
  configId: "membership-check",
});
// Show `uri` as a QR code, then wait for a terminal status.
const session = await eudiplo.waitForSession(sessionId);
```

| Method                                                          | Purpose                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| `createIssuanceOffer()`                                         | `POST /api/issuer/offer` with inline claims                   |
| `createPresentationRequest()`                                   | `POST /api/verifier/offer`                                    |
| `getSession()`, `waitForSession()`                              | Read or poll a session until it is `completed`, `failed` or `expired` |
| `subscribeToSession()`, `waitForSessionWithSse()`               | Follow a session over Server-Sent Events                      |
| `createDcApiPresentationRequest()`, `submitDcApiPresentation()`, `verifyWithDcApi()` | Digital Credentials API flow in the browser |

Keep `clientId` and `clientSecret` on your server. Browser code should talk to your backend, which calls EUDIPLO.

For every other endpoint, use the generated functions from `@eudiplo/sdk-core/api`. They are generated from the management OpenAPI specification and named after the controller method, for example `sessionControllerGetSession` or `webhookEndpointControllerCreate`:

```typescript
import { client, sessionControllerGetSession } from "@eudiplo/sdk-core/api";

client.setConfig({
  baseUrl: "https://eudiplo.example.com",
  headers: { Authorization: `Bearer ${accessToken}` },
});

const { data: session } = await sessionControllerGetSession({
  path: { id: sessionId },
});
```

`EudiploClient` authenticates only against the built-in OAuth 2.0 server. With an external OIDC provider, obtain the token yourself and use the generated functions as shown above.

## Related pages

- [Webhooks](webhooks.md): payloads EUDIPLO sends to your backend
- [Attribute provider API](attribute-provider-api.md): the contract for claim sources
- [Environment variables](environment-variables.md)
