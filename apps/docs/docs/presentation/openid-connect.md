---
title: Sign-in with OpenID Connect
---

import SchemaReference from '@site/src/components/SchemaReference';

# Sign-in with OpenID Connect

EUDIPLO can act as an OpenID Provider, so an application that already speaks OpenID Connect can verify a credential from the user's wallet. The application redirects the user to EUDIPLO, the user presents a credential, and the application receives an ID token with the verified claims. Any OpenID Connect client library works; the application needs no wallet-specific code.

This is the opposite direction of [Other OIDC providers](../operate/oidc-provider.md), where EUDIPLO trusts an external provider for its own management API.

## Before you start

- A [presentation configuration](configure-verification.md) that requests what the user presents. It must not define [transaction data](transaction-data.md): an authorization request cannot supply it.
- A token with the `presentation:manage` role.
- The application's redirect URIs. HTTPS is required; HTTP only for `localhost`, `127.0.0.1` and `[::1]`.

## 1. Register the client

```bash
curl -X POST "$EUDIPLO/api/verifier/oidc-clients" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Customer Portal",
    "redirectUris": ["https://portal.example.com/auth/callback"],
    "scopes": [{ "scope": "pid", "presentationConfigId": "pid" }]
  }'
```

The response holds the `id` (your `client_id`), the `clientSecret` and the `issuer`. The secret is returned only now and stored as a hash; it cannot be read back.

<SchemaReference name="oidc-client" mode="table" />

- **Scopes**: each scope selects one presentation configuration. A client can assign a configuration once; several clients can use the same configuration. `openid` is reserved.
- **Profile**: `secure` (the default) requires a pushed authorization request ([RFC 9126](https://www.rfc-editor.org/rfc/rfc9126)); the authorization endpoint then reads only `client_id` and `request_uri`. `basic` also accepts the parameters at the authorization endpoint directly, for libraries that cannot push a request, such as Auth.js. Without the push, anyone who knows the client ID can start sign-ins for it, so use `secure` where your library allows it.
- Change a client with `PATCH /api/verifier/oidc-clients/{id}`; `scopes` are replaced as a whole. `DELETE` removes it.

## 2. Configure your application

Point the OpenID Connect library at the issuer; it reads `<issuer>/.well-known/openid-configuration`:

```text
https://eudiplo.example.com/verifiers/<tenantId>/oidc
```

The discovery document exists once the tenant has a client. Configure the library with:

| Setting | Value |
| --- | --- |
| Client authentication | `client_secret_basic` or `client_secret_post` |
| Scope | `openid` and exactly one scope of the client, for example `openid pid` |
| PKCE | `S256`, always required |
| Response type | `code` |
| ID token algorithm | The one in `id_token_signing_alg_values_supported`, ES256 unless the key chain uses another curve. RS256 is not offered: set `id_token_signed_response_alg` in libraries that default to it, such as openid-client |

Every request must ask for `openid` and exactly one other scope. Many libraries request `openid profile email` by default, which EUDIPLO refuses with `invalid_scope`; set the scope explicitly. `prompt=none` fails with `login_required`, since every sign-in is a new presentation.

## 3. Read the ID token

The ID token is signed by the tenant's [authorization server key chain](../trust/keys-and-certificates.md#authorization-server-key-chain) with its algorithm (ES256, ES384 or ES512); verify it with the keys from `jwks_uri`. The verified claims arrive under `credentials`, in the same shape as the [presentation webhook](../reference/webhooks.md):

```json
{
  "iss": "https://eudiplo.example.com/verifiers/root/oidc",
  "sub": "3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11",
  "aud": "<client_id>",
  "auth_time": 1760000000,
  "nonce": "<your nonce>",
  "acr": "urn:eudiplo:acr:oidc:same-device",
  "credentials": [{ "id": "pid", "values": [{ "given_name": "Ada", "birthdate": "1815-12-10" }] }]
}
```

- `sub` is the ID of the presentation session and new for every sign-in: EUDIPLO keeps no account of the user. Never use it as a key; identify the user by a claim in `credentials`.
- There is no userinfo endpoint, refresh token or logout. The access token is opaque and accepted nowhere.
- The sign-in is an ordinary presentation session of the tenant: it appears in the session list, triggers the configuration's webhook and follows the tenant's retention. A webhook that answers with a `redirectUri` replaces the sign-in's callback, so a same-device sign-in can no longer finish; leave it out for configurations used here.

## Same device and cross device

The sign-in page shows a QR code for a wallet on another device and a button for a wallet on the same device. Only the browser that started the sign-in can finish it. `acr` says which flow happened:

| `acr` | Meaning |
| --- | --- |
| `urn:eudiplo:acr:oidc:same-device` | The wallet returned the holder to the browser that started the sign-in. |
| `urn:eudiplo:acr:oidc:cross-device` | The wallet presented on another device, or returned the holder to a different browser. Only the starting browser proved itself. |

A cross-device sign-in can be phished: an attacker starts a sign-in, shows its QR code to someone else, and that person's credential lands in the attacker's session. Where the sign-in grants anything that matters, check `acr` in the ID token, or send `acr_values=urn:eudiplo:acr:oidc:same-device` in the pushed request, and EUDIPLO refuses a cross-device presentation with `access_denied`. With the `basic` profile the browser carries the parameters and can drop `acr_values`, so check `acr` there.

A same-device sign-in waits for the wallet's redirect. A wallet that does not redirect back cannot finish it; scan the QR code instead.

## Errors

If the presentation fails or the sign-in expires (15 minutes), the browser returns to your `redirect_uri` with `error=access_denied`, a short `error_description` for your logs, and your `state`.

An invalid request (unknown scope, missing PKCE, `prompt=none`) is answered where it was sent: with the `secure` profile in the pushed request's response (HTTP 400 with `error` and `error_description`), with `basic` at your `redirect_uri` with the matching OAuth error. The user sees an error page instead of a redirect for an unknown client, an unregistered `redirect_uri`, a `state` over 1024 characters, and an expired (after 5 minutes) or already used `request_uri`.

## Rotate the client secret

A client holds up to two secrets and accepts either:

1. `POST /api/verifier/oidc-clients/{id}/secrets` returns a new `clientSecret`.
2. Switch your application to it.
3. `DELETE /api/verifier/oidc-clients/{id}/secrets/{secretId}` removes the old one. `lastUsedAt` on each secret, accurate to five minutes, shows when it was last used. To stop accepting a secret at a set time instead, `PATCH` it with `expiresAt`.

The last secret of a client cannot be deleted; add the new one first.
