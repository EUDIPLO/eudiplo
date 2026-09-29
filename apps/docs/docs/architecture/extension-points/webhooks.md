---
title: Webhooks
---

# Webhooks

EUDIPLO can notify your backend systems about presentation results and wallet notifications, enabling real-time integration without polling.

:::info[Webhooks vs Attribute Providers]

**Webhooks** are designed to **send data OUT** — notifying your backend when events occur (e.g., presentation completed, credential accepted by the wallet).

**Attribute Providers** are designed to **fetch data IN** — retrieving claims from your backend to include in credentials.

For fetching claims during issuance, see [Attribute Providers](./attribute-providers.md).

:::

## Supported Scenarios

EUDIPLO has no event-type subscription model. Exactly two kinds of outbound webhook calls are sent:

| Scenario               | Trigger                                                                        | Payload Includes                             |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Presentation completed | Wallet submitted a presentation that EUDIPLO verified                          | `credentials`, `session`, `transaction_data` |
| Notification received  | Wallet called the OID4VCI notification endpoint (accepted / failure / deleted) | `notification`, `session`                    |

## Webhook Configuration

Webhooks are configured per tenant via the **Webhook Endpoints** resource (`/api/issuer/webhook-endpoints`):

```json
{
    "id": "issuance-webhook",
    "name": "Issuance webhook",
    "description": "Receives wallet notifications",
    "url": "https://your-backend.example.com/webhooks/eudiplo",
    "auth": {
        "type": "apiKey",
        "config": {
            "headerName": "x-api-key",
            "value": "your-secret-key"
        }
    }
}
```

| Field         | Type     | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `id`          | `string` | Unique identifier within the tenant                    |
| `name`        | `string` | Display name                                           |
| `description` | `string` | Optional description                                   |
| `url`         | `string` | Endpoint that receives the webhook `POST` requests     |
| `auth`        | `object` | Authentication configuration (required, may be `none`) |

### Authentication Options

| Type     | Config Fields         | Description                              |
| -------- | --------------------- | ---------------------------------------- |
| `apiKey` | `headerName`, `value` | Send a static API key in a custom header |
| `none`   | —                     | No authentication (not recommended)      |

## Outbound URL Policy

Outbound calls reject HTTP targets and private, loopback or link-local addresses by default, in every environment. Enable the relaxations below only where needed, such as for local development or webhook receivers inside the same cluster, and prefer `OUTBOUND_URL_ALLOWED_HOSTS` to restrict targets.

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="webhook" />

## Notification Webhook

The OID4VCI notification endpoint allows wallets to signal credential acceptance, failure, or deletion. When a notification is received, EUDIPLO forwards it to the webhook endpoint referenced by `webhookEndpointId` in the **credential offer request** (`POST /api/issuer/offer`). If the offer did not set `webhookEndpointId`, no notification webhook is sent.

:::note

Credential configurations also accept a `webhookEndpointId`, but it is currently not used at runtime. Set `webhookEndpointId` on the offer request instead.

:::

**Payload:**

```json
{
    "notification": {
        "id": "ntf_abc123",
        "event": "credential_accepted",
        "credentialConfigurationId": "pid"
    },
    "session": "sess_def456"
}
```

`event` is the value sent by the wallet (`credential_accepted`, `credential_failure` or `credential_deleted`). EUDIPLO does not evaluate the webhook response.

**Use cases:**

- Track credential lifecycle (issued → accepted → deleted)
- Trigger post-issuance workflows (e.g., send confirmation email)
- Audit credential delivery success rates

## Presentation Webhook

When a presentation is successfully verified, EUDIPLO sends the disclosed claims to your backend. The webhook is resolved in this order:

1. The inline `webhook` object in the presentation request (`POST /api/verifier/offer`)
2. The webhook endpoint referenced by the presentation configuration's `webhookEndpointId`

The inline `webhook` object has the fields `url`, `auth` and optionally `includeRawTokensFor`.

**Payload:**

```json
{
    "credentials": [
        {
            "id": "pid",
            "values": [
                {
                    "given_name": "John",
                    "family_name": "Doe",
                    "birth_date": "1990-01-01"
                }
            ]
        }
    ],
    "session": "sess_abc123",
    "transaction_data": []
}
```

Each entry in `credentials` carries the DCQL credential query `id` and the disclosed claims in `values`. For every credential `id` listed in the inline webhook's `includeRawTokensFor`, the entry additionally contains `rawToken` with the raw presented token (for example the SD-JWT from the `vp_token`). `transaction_data` is only set when the request used [transaction data](../../presentation/transaction-data.md).

**Request Format:**

```http
POST /webhooks/eudiplo
Content-Type: application/json
x-api-key: your-secret-key

{
  "credentials": [...],
  "session": "sess_abc123",
  ...
}
```

**Response:** your backend may answer with `{ "redirectUri": "https://your-app.example.com/done" }`. If present, this URI is used instead of the configured `redirectUri` to redirect the user after the presentation. Webhook delivery errors do not fail the presentation.

**Use cases:**

- Complete user authentication after identity verification
- Populate user profile with verified claims
- Trigger access control decisions based on presented credentials
