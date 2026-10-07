---
title: Attribute provider API
sidebar_label: Attribute provider API
description: Contract between EUDIPLO and attribute providers or offer webhooks that supply credential claims.
---

import SchemaReference from "@site/src/components/SchemaReference";

The HTTP contract EUDIPLO uses to fetch claims from your backend during issuance. It applies to attribute providers and to `webhook` claim sources of an offer. For setup, see [Attribute providers](../issuance/attribute-provider.md); for when a provider is called, see [Claims](../issuance/claims.md).

## Resource

Attribute providers are tenant resources managed with the `issuance:manage` role:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/issuer/attribute-providers` | List providers |
| `GET` | `/api/issuer/attribute-providers/{id}` | Get one provider |
| `POST` | `/api/issuer/attribute-providers` | Create a provider |
| `PATCH` | `/api/issuer/attribute-providers/{id}` | Update fields of a provider |
| `DELETE` | `/api/issuer/attribute-providers/{id}` | Delete a provider |

<SchemaReference name="attribute-provider" mode="table" />

An offer `webhook` source has the shape `{ "url", "auth", "includeRawTokensFor"? }` with the same `auth` options; see [Webhooks](webhooks.md).

## Request

EUDIPLO sends `POST <url>` with `Content-Type: application/json` and, for `apiKey` authentication, the configured header. It calls the provider when the wallet requests the credential, once per credential request.

```json
{
    "session": "a6318799-dff4-4b60-9d1d-58703611bd23",
    "credential_configuration_id": "membership",
    "identity": {
        "iss": "https://keycloak.example.com/realms/eudiplo",
        "sub": "f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        "token_claims": {
            "email": "max@example.com",
            "preferred_username": "max"
        }
    },
    "credentials": [
        {
            "id": "pid",
            "values": [
                { "given_name": "Max", "family_name": "Mustermann", "birthdate": "1990-01-15" }
            ]
        }
    ]
}
```

| Field | Present | Description |
| --- | --- | --- |
| `session` | always | Issuance session ID. It equals the `session` returned when the offer was created. |
| `credential_configuration_id` | always | Credential configuration the wallet requested. |
| `identity` | always | `iss`, `sub` and `token_claims` of the authorization behind the wallet's access token. What they contain per flow is listed in [Claims](../issuance/claims.md#identity-passed-to-attribute-providers). |
| `credentials` | after a presentation | Verified claims the wallet presented to an [OID4VP authorization server](../issuance/authorization-servers.md#oid4vp) or in an [interactive authorization](../issuance/interactive-authorization.md) presentation step. One entry per credential query ID of the presentation's DCQL query; `values` holds the disclosed claims of each matching credential (several with `multiple: true`). |

## Response

### Claims

Answer `200` with the claims under the requested credential configuration ID:

```json
{
    "membership": {
        "name": "Max",
        "member_id": "M-001"
    }
}
```

The claims replace the static defaults of the configuration completely and are validated against its `fields` before signing; see [Claims](../issuance/claims.md#validation).

### Deferred

To issue later, answer `200` with:

```json
{ "deferred": true, "interval": 5 }
```

| Field | Description |
| --- | --- |
| `deferred` | `true` defers the credential. |
| `interval` | Polling interval in seconds suggested to the wallet. Default `5`. |

EUDIPLO answers the wallet with a `transaction_id`. Completing or failing the transaction is described in [Deferred issuance](../issuance/deferred-issuance.md).

## Errors

- Any non-`2xx` status or network error fails the credential request. The wallet receives HTTP `400` with `invalid_credential_request`; claims that do not match the configuration lead to `credential_request_denied`.
- A `200` answer without a claims object under the requested credential configuration ID, and without `deferred: true`, fails the credential request with `credential_request_denied`. EUDIPLO does not fall back to the static defaults.
- EUDIPLO does not retry and sets no timeout of its own. The wallet's credential request waits for your answer, so answer quickly or defer.
- The provider URL must pass the outbound URL policy: HTTPS and public addresses only, unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set (both `false` by default since 9.0). See [Webhooks](webhooks.md).
