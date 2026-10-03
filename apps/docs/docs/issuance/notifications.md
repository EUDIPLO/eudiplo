---
title: Notification Endpoint
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Webhook Integration > Webhook Payload' -> reference/webhooks.md (single owner of webhook payloads)
-->

EUDIPLO supports the OID4VCI Notification Endpoint, allowing wallets to notify the issuer when credential processing events occur (acceptance, deletion, failure).

:::note Implementation Status
This page documents the notification endpoint as implemented. Some behaviors may be subject to change based on spec evolution and wallet compatibility testing.
:::

## Overview

The notification endpoint provides a way for wallets to send event notifications back to the issuer after receiving credentials. EUDIPLO stores the event on the issuance session and can then forward it to a configured webhook endpoint. This enables issuers to:

- Track credential lifecycle events (accepted, deleted, failed)
- Audit wallet interactions
- Implement business logic based on wallet actions

## Endpoint

```http
POST /{tenant}/notification
```

The endpoint is wallet-facing, but the request is authenticated with the issuance access token. Bearer authentication is accepted unless DPoP is required by the issuance configuration; DPoP is always accepted when enabled.

## Request Format

Wallets send a POST request with a JSON body containing the notification:

```json
{
  "notification_id": "550e8400-e29b-41d4-a716-446655440000",
  "event": "credential_accepted"
}
```

### Request Fields

| Field             | Type   | Required | Description                                             |
| ----------------- | ------ | -------- | ------------------------------------------------------- |
| `notification_id` | string | Yes      | Identifier issued by EUDIPLO in the credential response |
| `event`           | string | Yes      | Event type (see below)                                  |

The request is strict: additional fields such as `event_description` or `credential_id` are rejected.

### Event Types

The OID4VCI spec defines three standard event types:

| Event                 | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `credential_accepted` | Wallet successfully processed and stored the credential |
| `credential_deleted`  | User deleted the credential from the wallet             |
| `credential_failure`  | Wallet failed to process the credential                 |

## Response

The endpoint returns:

- `200 OK` on success
- `400 Bad Request` if the notification payload is invalid
- `401 Unauthorized` if the access token is missing or invalid

## Webhook Integration

When a wallet sends a notification, EUDIPLO can forward it to a configured Webhook Endpoint. This is a fire-and-forget event callback; it is different from an Attribute Provider, which EUDIPLO calls to fetch claims during credential issuance.

### Configuring Webhooks

Webhook endpoints can be configured at two levels:

1. **Credential Configuration Level**: Set `webhookEndpointId` in the [Credential Configuration](credential-configuration.md) to apply to all offers of that type.

2. **Offer Level**: Set `webhookEndpointId` when [creating the offer](credential-offers.md) to override the credential configuration setting for that specific offer.

**Example (credential configuration):**

```json
{
  "id": "employee-badge",
  "webhookEndpointId": "notification-webhook"
}
```

**Example (offer override):**

```json
{
  "response_type": "uri",
  "flow": "pre_authorized_code",
  "credentialConfigurationIds": ["employee-badge"],
  "webhookEndpointId": "staging-notification-webhook"
}
```

### Webhook Payload

When forwarding the notification, EUDIPLO sends a POST request to the configured webhook URL with:

```json
{
  "session": "a6318799-dff4-4b60-9d1d-58703611bd23",
  "notification": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "event": "credential_accepted",
    "credentialConfigurationId": "employee-badge"
  }
}
```

| Field          | Type   | Description                                                                       |
| -------------- | ------ | --------------------------------------------------------------------------------- |
| `session`      | string | The issuance session ID                                                           |
| `notification` | object | The stored notification, including its ID, event, and credential configuration ID |

The notification webhook uses the authentication configured on the Webhook Endpoint, currently `none` or an API key header. EUDIPLO does not currently add an HMAC signature or automatically retry failed deliveries. If delivery fails, the notification request fails and the error is logged.

## Use Cases

### Audit Trail

Log wallet acceptance events for compliance or analytics:

```typescript
// Webhook handler
app.post('/webhooks/notification', (req, res) => {
  const { session, notification } = req.body;

  if (notification.event === 'credential_accepted') {
    auditLog.record({
      session,
      event: 'credential_accepted',
      timestamp: new Date(),
    });
  }

  res.sendStatus(200);
});
```

### User Onboarding

Complete a multi-step onboarding flow when the user accepts the credential:

```typescript
if (notification.event === 'credential_accepted') {
  await completeOnboarding(session);
  await sendWelcomeEmail(session);
}
```

### Credential Lifecycle

Track credential deletion for reissuance workflows:

```typescript
if (notification.event === 'credential_deleted') {
  await markCredentialAsDeleted(notification.credential_id);
  await offerReissuance(session);
}
```

## Best Practices

1. **Create Webhook Endpoints First**: Before referencing a webhook in a credential configuration or offer, create the webhook endpoint resource via the API.

2. **Authenticate the Endpoint**: Configure an API key on the Webhook Endpoint and validate it on receipt.

3. **Handle Idempotency**: Implement idempotency using the notification ID to protect against duplicate delivery attempts by clients or operators.

4. **Log Failures**: If your webhook endpoint is unavailable, EUDIPLO logs the failure. Monitor webhook delivery success rates.

5. **Use Offer-Level Overrides for Testing**: Test with different webhook endpoints during development by overriding at offer creation time.

## Attribute Providers Are Separate

An [Attribute Provider](attribute-provider.md) is not a notification webhook. It is a claims source used during issuance. EUDIPLO sends it a POST request containing the session ID and `credential_configuration_id` (plus identity or presented credentials when available), then expects claims keyed by the credential configuration ID or a deferred-issuance response. Configure it with `attributeProviderId`; do not use `webhookEndpointId` for claim retrieval.

## Related Documentation

- [Credential Configuration](credential-configuration.md) — Configuring credential-level webhooks
- [Credential Offers](credential-offers.md) — Configuring offer-level webhooks
- [Architecture: Webhooks](../reference/webhooks.md) — Webhook integration patterns
- [API Reference](../reference/api.md) — Webhook Endpoint management API
