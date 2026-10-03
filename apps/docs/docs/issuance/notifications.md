---
title: Receive wallet notifications
sidebar_label: Notifications
---

Find out whether the wallet stored, rejected or deleted a credential. Wallets report this to the OID4VCI notification endpoint; EUDIPLO records the event on the issuance session, updates the session status and forwards the event to a webhook endpoint of your choice.

**Prerequisites:** a [webhook endpoint](../reference/webhooks.md) created under `/api/issuer/webhook-endpoints` (web client: **Webhook Endpoints**).

## 1. Keep the endpoint enabled

The notification endpoint is enabled by default. EUDIPLO publishes it as `notification_endpoint` in the credential issuer metadata:

```text
POST /issuers/{tenant}/vci/notification
```

Set `notificationEndpointEnabled: false` in the [issuance configuration](issuance-configuration.md) to remove it from the metadata; requests then answer `404`.

## 2. Reference the webhook endpoint in the offer

Set `webhookEndpointId` when you [create the offer](credential-offers.md):

```json
{
    "response_type": "uri",
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["membership"],
    "webhookEndpointId": "issuance-events"
}
```

Only the offer's `webhookEndpointId` is used. The field of the same name on a credential configuration is stored but ignored for notifications. Without a webhook endpoint, EUDIPLO still records the events on the session.

## 3. Handle the events

Each credential response contains a `notification_id`. The wallet sends it back with one event:

```json
{ "notification_id": "550e8400-e29b-41d4-a716-446655440000", "event": "credential_accepted" }
```

| `event` | Meaning | Session status afterwards |
| --- | --- | --- |
| `credential_accepted` | The wallet stored the credential. | `completed` |
| `credential_failure` | The wallet could not process it. | `failed` |
| `credential_deleted` | The user deleted it. | `failed` |

EUDIPLO then posts the event to the webhook endpoint. The payload and the authentication options are described in [Webhooks](../reference/webhooks.md). Delivery is not retried; a failed delivery fails the wallet's notification request and is logged. Use the notification ID to detect duplicates.

You can also read the recorded events from `notifications` of `GET /api/session/{id}`.

## Endpoint behavior

- The request must carry the access token of the issuance, with DPoP when the issuance configuration sets `dPopRequired`. The endpoint works with tokens of every authorization server type: built-in, external, chained and OID4VP.
- The body is strict: only `notification_id` and `event` are accepted.
- A successful request answers `201` with an empty body.
- Since 9.0, a `notification_id` that was not issued for the token's session answers `400` with `{"error": "invalid_notification_id"}`. A missing or invalid access token answers `401` with `invalid_token`.

Attribute providers are not notification targets; they supply claims during issuance. See [Attribute providers](attribute-provider.md).
