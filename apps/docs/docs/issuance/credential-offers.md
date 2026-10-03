---
title: Create credential offers
sidebar_label: Credential offers
---

import SchemaReference from "@site/src/components/SchemaReference";

Start an issuance: your backend creates an offer, EUDIPLO returns an offer URI, and you show it to the wallet as a QR code or link. Which flow to offer is explained in the [issuance overview](index.md).

**Prerequisites:** a [credential configuration](credential-configuration.md), an [authorization server](authorization-servers.md) in the issuance configuration, and a client with the `issuance:offer` role.

## Create the offer

```bash
curl -X POST "$EUDIPLO_URL/api/issuer/offer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "response_type": "uri",
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["membership"],
    "credentialClaims": {
      "membership": { "type": "inline", "claims": { "name": "Max", "member_id": "M-001" } }
    },
    "offerLifetimeSeconds": 600
  }'
```

EUDIPLO answers `201` with:

```json
{
    "session": "a6318799-dff4-4b60-9d1d-58703611bd23",
    "uri": "openid-credential-offer://?credential_offer_uri=https%3A%2F%2Feudiplo.example.com%2Fissuers%2Fmembership-demo%2Fvci%2Fcredential-offers%2Fa6318799-…"
}
```

- `uri` is the offer to render as QR code or deep link. The wallet resolves the offer by reference at `/issuers/{tenant}/vci/credential-offers/{session}`.
- `session` identifies the issuance session. Use it to follow the status (`GET /api/session/{session}`: `active`, then `fetched` after the first credential, `completed` or `failed` after the wallet's [notification](notifications.md), or `expired`), to [revoke credentials](revocation.md) and to correlate [attribute provider](attribute-provider.md) requests.

`response_type` is required by the schema, but issuance offers always answer with this JSON; use `uri`. Unknown credential configurations and inline claims that do not match the configuration answer `409`, an unknown or disabled `authorization_server` answers `400`.

## Choose the flow and authorization server

| `flow` | Use it when | Authorization server |
| --- | --- | --- |
| `pre_authorized_code` | Your backend already knows the user. The offer contains a pre-authorized code; anyone who has the offer can redeem it, so protect it with a transaction code if needed. | Must be the built-in server (default if it is the first enabled entry). |
| `authorization_code` | The user must authenticate or present a credential first. The offer contains `issuer_state` = the session ID. | Set `authorization_server` to the `id` of the entry; without it, the first enabled entry is used. |

### Transaction code

For pre-authorized offers, `tx_code` sets a code the user must type into the wallet; send it on a second channel. EUDIPLO advertises its length and `input_mode` (`numeric` if it consists of digits only, otherwise `text`) and shows `tx_code_description` as hint. A wrong code answers `invalid_grant`. After `txCodeMaxAttempts` failed attempts (issuance configuration, default 5) the pre-authorized code is invalidated, and even the correct code is rejected.

## Choose the claim source

`credentialClaims` sets the claim source per credential configuration of this offer. Keys must appear in `credentialConfigurationIds`; configurations without an entry use their attribute provider or static defaults.

| `type` | Shape | Use it when |
| --- | --- | --- |
| `inline` | `{ "type": "inline", "claims": { … } }` | The values are known now. They are validated when the offer is created. |
| `attributeProvider` | `{ "type": "attributeProvider", "attributeProviderId": "…" }` | Another [attribute provider](attribute-provider.md) than the configuration's should answer. |
| `webhook` | `{ "type": "webhook", "webhook": { "url": "…", "auth": { "type": "none" } } }` | A one-off endpoint with the [attribute provider contract](../reference/attribute-provider-api.md) should answer. |

Priority, identity and validation rules are described in [Claims](claims.md).

## Lifetime and expiry

Since 9.0, an offer can expire:

- `offerLifetimeSeconds` in the request, or the default `offerLifetimeSeconds` of the [issuance configuration](issuance-configuration.md), sets how long the offer can be redeemed. Without both, the offer does not expire until the session is removed by the session retention (`SESSION_TTL`, 24 hours by default).
- After expiry, the offer URI answers `404`, the token endpoint `invalid_grant` ("The credential offer has expired"), and authorization requests with its `issuer_state` are rejected. Tokens issued before keep their own lifetimes.
- The session's `expiresAt` holds the deadline. A maintenance job marks unredeemed offers as `expired` every `SESSION_TIDY_UP_INTERVAL`; expiry is enforced at request time regardless.
- Pre-authorized codes additionally expire with the session retention time (`SESSION_TTL` or the tenant's session settings).

## Single use

- The offer URI can be resolved once; later fetches answer `404`. Set `ISSUER_MULTI_CONSUMPTION=true` to allow repeated fetches, for example for wallets that load the offer twice.
- The code in the offer is redeemed once, at the token endpoint. A second token request answers `invalid_grant` ("The credential offer has already been used"). Refresh tokens stay usable.
- Create a new offer for every issuance.

## Your own reference

`reference` (optional, up to 255 characters) stores an identifier of your system with the session, for example an order or case ID. It is returned in the session list and detail, sent in the session's webhooks, and you can [find the session](../concepts/sessions.md#finding-sessions) by it later.

:::warning
The reference is stored in plaintext, unlike the claims, and stays when sessions are anonymized. Use an opaque identifier, never a name, email address or other personal data.
:::

## Restrict clients

A client with `allowedIssuanceConfigs` can only offer the listed credential configurations; other IDs answer `403`. See [Tenants and access](../operate/tenants-and-access.md).

## Request fields

<SchemaReference name="offer-request" mode="table" />
