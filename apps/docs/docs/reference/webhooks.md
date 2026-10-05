---
title: Webhooks
description: Webhook payloads, configuration, authentication and delivery semantics.
---

# Webhooks

EUDIPLO sends a webhook when a presentation ends and when a wallet reports what it did with an issued credential. This page is the reference for both payloads, for where webhooks are configured, and for how they are delivered. Claim requests during issuance use a different contract, described in the [attribute provider API](attribute-provider-api.md).

## Overview

| Webhook                                     | Sent when                                                                                         | Configured by                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Presentation result](#presentation-webhook) | An OID4VP, Digital Credentials API or ISO 18013-7 presentation ends as `completed` or `failed`   | Inline `webhook` of `POST /api/verifier/offer`, otherwise `webhookEndpointId` of the presentation configuration |
| [Issuance notification](#notification-webhook) | The wallet calls the OID4VCI notification endpoint                                              | `webhookEndpointId` of `POST /api/issuer/offer`                                                         |

There is no event subscription model: each webhook goes to the one URL configured for that flow.

## Configure a webhook

### Webhook endpoints

A webhook endpoint is a reusable, tenant-scoped target, managed under `/api/issuer/webhook-endpoints` by clients with the `issuance:manage` or `presentation:manage` role. Configurations and offers reference it by `id`.

```json
{
    "id": "membership-results",
    "name": "Membership results",
    "url": "https://backend.example.com/eudiplo/webhook",
    "auth": {
        "type": "apiKey",
        "config": { "headerName": "x-api-key", "value": "replace-with-a-random-secret" }
    }
}
```

| Field         | Required | Description                                       |
| ------------- | -------- | ------------------------------------------------- |
| `id`          | yes      | Identifier within the tenant                      |
| `name`        | yes      | Display name                                      |
| `description` | no       | Free text                                         |
| `url`         | yes      | Target of the `POST` requests                     |
| `auth`        | yes      | `{ "type": "none" }` or the `apiKey` object above |

With `apiKey`, EUDIPLO sends `value` in the header named `headerName`. Webhook requests are not signed, so use HTTPS and check the header. In configuration files, use a `${VAR}` placeholder for `value` ([Configuration as code](../operate/configuration-as-code.md)).

### Where webhooks are referenced

| Place                                   | Field               | Effect                                                                                                    |
| --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| Presentation request (`POST /api/verifier/offer`) | `webhook`  | Inline object with `url`, `auth` and optional `includeRawTokensFor`; replaces the configuration's endpoint for this request |
| Presentation configuration              | `webhookEndpointId` | Default target for presentation results                                                                   |
| Credential offer (`POST /api/issuer/offer`) | `webhookEndpointId` | Target for the notifications of this issuance session                                                 |
| Credential configuration                | `webhookEndpointId` | Stored, but not used: notifications only go to the endpoint named in the offer                            |

The presentation target is resolved when the request is created; later changes to the endpoint do not affect running sessions. A `webhookEndpointId` that does not exist is logged as a warning and no webhook is sent.

## Presentation webhook

EUDIPLO sends one `POST` per presentation after the session reached its final status. The payload always contains `status`, `outcome` and `session`; `credentials` is only present when the presentation succeeded.

**Completed:**

```json
{
    "status": "completed",
    "outcome": {
        "result": "success",
        "credentials": [{ "id": "membership", "verified": true }]
    },
    "credentials": [
        {
            "id": "membership",
            "values": [
                {
                    "vct": "urn:example:membership:1",
                    "iss": "https://eudiplo.example.com/issuers/membership-demo",
                    "name": "Max",
                    "member_id": "M-001"
                }
            ]
        }
    ],
    "session": "0b6f3a8e-6d0c-4b8e-9a63-2f1c5d7e9a10"
}
```

**Failed** (here an issuer that is not on the trust list):

```json
{
    "status": "failed",
    "outcome": {
        "result": "failed",
        "error": "trust_chain_not_trusted",
        "message": "The credential issuer is not in the trusted list.",
        "credentials": [
            {
                "id": "membership",
                "format": "dc+sd-jwt",
                "verified": false,
                "error": "trust_chain_not_trusted",
                "message": "The credential issuer is not in the trusted list."
            }
        ]
    },
    "session": "0b6f3a8e-6d0c-4b8e-9a63-2f1c5d7e9a10"
}
```

| Field              | Description                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | `completed` or `failed`                                                                                                                           |
| `outcome`          | Structured result with machine-readable `error` codes; see [Session outcome](session-outcome.md)                                                  |
| `credentials`      | Only on success. OID4VP: one entry per DCQL credential `id` with the disclosed claims of each presentation in `values` (`cnf` and `status` removed). ISO 18013-7: `id`, `format`, `docType` and `claims` |
| `session`          | Session ID, as returned by `POST /api/verifier/offer`                                                                                             |
| `transaction_data` | The transaction data of the request, if it had any                                                                                               |

A wallet that declines sends an OAuth error; the webhook then reports `failed` with the wallet's error code (for example `access_denied`) as `outcome.error`. Expired requests do not trigger a webhook.

### Raw tokens

For every DCQL credential `id` listed in `includeRawTokensFor` of an inline `webhook`, the matching `credentials` entry also contains `rawToken` with the presented token as received, for example the SD-JWT VC with its key binding JWT. Webhook endpoints referenced by `webhookEndpointId` cannot request raw tokens, and failure payloads never contain them.

### Redirect override

Your webhook may answer with a JSON body containing `redirectUri`. EUDIPLO then sends the wallet to that URI instead of the configured redirect URI, on success with `response_code` and on failure with `error` parameters appended. For ISO 18013-7, failures never redirect. How to handle the redirect is described in [Receive results](../presentation/receive-results.md).

```json
{ "redirectUri": "https://shop.example.com/checkout/done?order=4711" }
```

Other response fields are ignored.

## Notification webhook

When the wallet calls the [notification endpoint](../issuance/notifications.md), EUDIPLO records the event on the session and forwards it to the webhook endpoint named in the offer:

```json
{
    "notification": {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "event": "credential_accepted",
        "credentialConfigurationId": "membership"
    },
    "session": "a6318799-dff4-4b60-9d1d-58703611bd23"
}
```

| Field                                    | Description                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `notification.id`                        | `notification_id` that EUDIPLO returned in the credential response          |
| `notification.event`                     | Sent by the wallet: `credential_accepted`, `credential_failure` or `credential_deleted` |
| `notification.credentialConfigurationId` | Credential configuration of the notified credential                         |
| `session`                                | Issuance session ID, as returned by `POST /api/issuer/offer`                |

The response body is ignored.

## Delivery

- **One attempt.** Each webhook is a single `POST` with a JSON body. EUDIPLO does not retry.
- **Synchronous.** The wallet's request waits for your webhook, because a presentation webhook can change the redirect. Answer quickly and do slow work afterwards.
- **Presentation failures are best effort.** The session status is final before the webhook is sent. A failed delivery (connection error, non-2xx status, blocked URL) is logged and changes neither the session nor the wallet's result. Use [polling or the event stream](../presentation/receive-results.md) as a fallback.
- **Notification failures are reported to the wallet.** EUDIPLO records the event on the session first, then sends the webhook, then updates the session status. If the delivery fails, the wallet's notification request fails with HTTP 500 and the session keeps its previous status.
- **Outbound URL policy.** Webhook URLs must use HTTPS and resolve to public addresses unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` allow otherwise. With `OUTBOUND_URL_ALLOWED_HOSTS` set, the host must also be on that list; see [environment variables](environment-variables.md#webhook). A blocked URL counts as a failed delivery.
