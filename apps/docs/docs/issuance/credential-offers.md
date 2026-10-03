---
title: Credential Offers
---

Credential offers start OID4VCI issuance. Your backend creates an offer via the API, EUDIPLO returns an offer URI, and you present that URI to the wallet (for example as a QR code or deep link).

This page covers request shape and offer behavior. For flow selection guidance, see the [Issuance Overview](index.md).

## Before You Create an Offer

Usually you create these resources first:

1. A [Credential Configuration](credential-configuration.md)
2. An [Issuance Configuration](issuance-configuration.md)
3. Optionally an [Attribute Provider](attribute-provider.md) if claims should be fetched dynamically

## Creating Credential Offers

Use the [credential offer endpoint](../reference/api.md) to create the offer.

When creating an offer, you can:

1. Define the flow with `flow`
2. Select the credentials with `credentialConfigurationIds`
3. Optionally select a configured authorization server by `id` with `authorization_server`
4. Optionally override claims with `credentialClaims`
5. Optionally enable a transaction code with `tx_code` and `tx_code_description`
6. Optionally configure notifications with `webhookEndpointId`

### Common Request Fields

- `response_type` - how the offer is returned to the caller
- `flow` - `pre_authorized_code` or `authorization_code`
- `credentialConfigurationIds` - list of credential configuration IDs to include in the offer
- `authorization_server` - optional authorization server `id` from issuance configuration
- `credentialClaims` - optional per-credential claims source override
- `tx_code` - optional transaction code for pre-authorized flows
- `tx_code_description` - optional prompt shown with the transaction code
- `webhookEndpointId` - optional notification webhook endpoint ID

:::info[Notification webhook endpoint references]
`webhookEndpointId` references a standalone Webhook Endpoint resource. Create the endpoint first, then reference it by ID.

If both a credential configuration and an offer specify `webhookEndpointId`, the offer-level value is used for that session.
:::

### Example: Pre-authorized Offer with Inline Claims

```json
{
    "response_type": "uri",
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["citizen"],
    "credentialClaims": {
        "citizen": {
            "type": "inline",
            "claims": {
                "given_name": "John",
                "family_name": "Doe"
            }
        }
    }
}
```

### Example: Authorization Code Offer with External AS

```json
{
    "response_type": "uri",
    "flow": "authorization_code",
    "authorization_server": "external-corp-idp",
    "credentialConfigurationIds": ["employee_badge"]
}
```

`authorization_server` must match the `id` of an enabled entry in `authorizationServers`. See [Authorization](authorization-servers.md) for configuration details.

## Single-Use Offers

Credential offers are single-use and non-replayable. Once a wallet completes issuance with an offer:

- Token replay with the same authorization or pre-authorized code is rejected with an `invalid_grant` error
- Offer-by-reference replay is rejected: once the offer is resolved by `credential_offer_uri` from the server, it cannot be requested again (`404` on subsequent fetches).
- The offer is marked as consumed at the credential endpoint and cannot be used again after successful credential processing
- The `consumedAt` timestamp records when the offer was first used

Important considerations:

- Create a new offer for each issuance request
- Combine single-use enforcement with TTL-based cleanup so expired offers do not accumulate
- Refresh tokens remain valid for follow-up operations on the issued credentials

This prevents credential offer replay attacks where an intercepted offer could otherwise be reused.

## Pre-Authorized Code Lifetime and Transaction Codes

- A pre-authorized code expires with its session: it is accepted until the session's creation time plus the tenant's session time-to-live (`sessionConfig.ttlSeconds`, or the global `SESSION_TTL`, 24 hours by default). Later token requests fail with `invalid_grant` ("Expired 'pre-authorized_code' provided"). Lower the tenant's session TTL if offers should expire sooner.
- A wrong `tx_code` is rejected with `invalid_grant` (OID4VCI 1.0, Section 6.3). After `txCodeMaxAttempts` failed attempts (default 5) the pre-authorized code is invalidated, and even the correct transaction code is rejected.

## Passing Claims

EUDIPLO provides multiple methods to pass claims during issuance. Claims are resolved in the following priority order:

1. Offer-level claims via `credentialClaims`
2. Configuration-level Attribute Provider via `attributeProviderId`
3. Configuration-level static claims on the credential configuration

:::warning[Claims are not merged]
Higher priority sources completely override lower priority sources. If an offer-level webhook or Attribute Provider is used, lower-priority sources are not merged in. For a complete explanation of the claims priority system, see [Claims](claims.md).
:::

### Request Shape for `credentialClaims`

`credentialClaims` must be an object keyed by credential configuration ID. Each key must also appear in `credentialConfigurationIds`.

Each value selects the claims source for that credential:

- `type: "inline"` - pass the claims directly in the request
- `type: "attributeProvider"` - fetch claims from an existing Attribute Provider
- `type: "webhook"` - fetch claims from an inline webhook definition for this offer only

The most common way to override claims is the inline variant:

```json
{
    "response_type": "uri",
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["citizen"],
    "credentialClaims": {
        "citizen": {
            "type": "inline",
            "claims": {
                "given_name": "John",
                "family_name": "Doe"
            }
        }
    }
}
```

In this example:

- `citizen` is the credential configuration ID
- `claims` contains the actual credential claim values
- the inline claims override any configuration-level Attribute Provider or static claims for `citizen`

You can also override the source instead of embedding claims directly:

```json
{
    "response_type": "uri",
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["citizen", "employee_badge"],
    "credentialClaims": {
        "citizen": {
            "type": "attributeProvider",
            "attributeProviderId": "citizen-claims-provider"
        },
        "employee_badge": {
            "type": "webhook",
            "webhook": {
                "url": "https://issuer.example.com/api/claims/employee-badge"
            }
        }
    }
}
```

Notes:

- `credentialClaims` keys must be a subset of `credentialConfigurationIds`
- values are resolved per credential configuration, not globally for the whole offer
- if you want to override only one credential in a multi-credential offer, include only that credential in `credentialClaims`
- for the full webhook shape, see [Attribute Providers](attribute-provider.md), [Webhooks](../reference/webhooks.md), and the [API documentation](../reference/api.md)

### When to Use Each Method

- Configuration-level static claims for fixed metadata used on every issuance
- Configuration-level Attribute Providers for dynamic claims based on authentication context
- Offer-level inline claims when claim values are already known at offer creation time
- Offer-level webhook or Attribute Provider overrides when claim resolution should vary per offer

For the broader claims model, see [Claims](claims.md) and [Webhooks](../reference/webhooks.md).
