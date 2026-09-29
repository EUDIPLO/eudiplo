---
title: Webhooks
---

# Webhooks

EUDIPLO can notify your backend systems when issuance and presentation events occur, enabling real-time integration without polling.

:::info[Webhooks vs Attribute Providers]

**Webhooks** are designed to **send data OUT** — notifying your backend when events occur (e.g., credential issued, presentation completed).

**Attribute Providers** are designed to **fetch data IN** — retrieving claims from your backend to include in credentials.

For fetching claims during issuance, see [Attribute Providers](./attribute-providers.md).

:::

## Supported Scenarios

| Event                     | Description                                                       | Payload Includes                                       |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| Credential issued         | Wallet successfully received a credential                         | `sessionId`, `credentialType`, `format`, `tenantId`    |
| Presentation completed    | Wallet submitted a verified presentation                          | `sessionId`, `presentedClaims`, `credentialTypes`      |
| Deferred credential ready | Attribute provider completed processing, credential now available | `transactionId`, `claims`                              |
| Notification received     | Wallet sent a notification (acceptance/rejection/deletion)        | `notificationId`, `event`, `credentialId`, `eventTime` |

## Webhook Configuration

Webhooks are configured per tenant via the **Webhook Endpoints** resource:

```json
{
    "id": "issuance-webhook",
    "url": "https://your-backend.example.com/webhooks/eudiplo",
    "events": ["credential.issued", "presentation.completed"],
    "auth": {
        "type": "apiKey",
        "config": {
            "headerName": "x-api-key",
            "value": "your-secret-key"
        }
    }
}
```

| Field    | Type     | Description                              |
| -------- | -------- | ---------------------------------------- |
| `id`     | `string` | Unique identifier within the tenant      |
| `url`    | `string` | HTTPS endpoint to receive webhook events |
| `events` | `array`  | List of event types to subscribe to      |
| `auth`   | `object` | Authentication configuration (optional)  |

### Authentication Options

| Type          | Config Fields          | Description                                   |
| ------------- | ---------------------- | --------------------------------------------- |
| `apiKey`      | `headerName`, `value`  | Send a static API key in a custom header      |
| `bearerToken` | `token`                | Send a Bearer token in `Authorization` header |
| `basic`       | `username`, `password` | HTTP Basic authentication                     |
| `none`        | —                      | No authentication (not recommended)           |

## Outbound URL Policy

Outbound calls reject HTTP targets and private, loopback or link-local addresses by default, in every environment. Enable the relaxations below only where needed, such as for local development or webhook receivers inside the same cluster, and prefer `OUTBOUND_URL_ALLOWED_HOSTS` to restrict targets.

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="webhook" />

## Notification Webhook

The OID4VCI notification endpoint allows wallets to signal credential acceptance, rejection, or deletion. When a notification is received, EUDIPLO can forward it to your backend webhook:

**Event:** `notification.received`

**Payload:**

```json
{
    "event": "notification.received",
    "tenantId": "example-tenant",
    "notificationId": "ntf_abc123",
    "notification": {
        "notification_id": "ntf_abc123",
        "event": "credential_accepted",
        "event_time": 1672531200,
        "credential_id": "cred_xyz789"
    },
    "sessionId": "sess_def456"
}
```

**Use cases:**

- Track credential lifecycle (issued → accepted → deleted)
- Trigger post-issuance workflows (e.g., send confirmation email)
- Audit credential delivery success rates

## Presentation Webhook

When a presentation is successfully verified, EUDIPLO extracts the claims and sends them to your backend:

**Event:** `presentation.completed`

**Payload:**

```json
{
    "event": "presentation.completed",
    "tenantId": "example-tenant",
    "sessionId": "sess_abc123",
    "presentedClaims": {
        "given_name": "John",
        "family_name": "Doe",
        "birth_date": "1990-01-01"
    },
    "credentialTypes": ["PersonIdentificationData"],
    "verifiedAt": "2024-01-15T10:30:00Z"
}
```

**Request Format:**

```http
POST /webhooks/eudiplo
Content-Type: application/json
X-API-Key: your-secret-key

{
  "event": "presentation.completed",
  ...
}
```

**Use cases:**

- Complete user authentication after identity verification
- Populate user profile with verified claims
- Trigger access control decisions based on presented credentials
