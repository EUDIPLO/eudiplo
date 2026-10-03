---
title: Receive Results
---

After you [create a presentation request](requests.md), the result arrives in the session whose ID the request returned. Your backend can be called by a webhook, follow a stream of status events, or poll the session; same-device flows also return the user's browser to you. States, failure codes and the `outcome` structure are listed in the [session outcome reference](../reference/session-outcome.md).

| Method                                          | Use when                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| [Webhook](#webhook)                             | Your backend should be told about every completed or failed presentation. |
| [Server-Sent Events](#server-sent-events)       | A page or service waits for one session, for example next to a QR code.  |
| [Polling](#polling)                             | You cannot receive webhooks or keep a stream open.                       |
| [Same-device redirect](#same-device-redirect)   | The wallet runs on the same device and should return the user to your page. |

## Webhook

EUDIPLO calls a webhook when a presentation reaches `completed` or `failed`. It uses the inline `webhook` of the request if present, otherwise the webhook endpoint referenced by the configuration's `webhookEndpointId` ([Configure Verification](configure-verification.md#send-results-to-your-backend)). Expiry does not trigger a webhook.

The body always contains `status`, `outcome` and `session`, plus `transaction_data` if the request used it. Only a completed presentation also carries `credentials`, the disclosed claims per DCQL credential query ID:

```json
{
    "status": "completed",
    "outcome": { "result": "success", "credentials": [{ "id": "membership", "verified": true }] },
    "credentials": [{ "id": "membership", "values": [{ "name": "Max", "member_id": "M-001" }] }],
    "session": "3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11"
}
```

A failed presentation, for example because the user declined, sends `"status": "failed"` with the reason in `outcome` and no credentials. The complete payload is described in [Webhooks](../reference/webhooks.md).

- **Raw tokens:** list credential query IDs in `includeRawTokensFor` of an inline request `webhook` to also receive the presented token (for example the SD-JWT) as `rawToken`. Webhook endpoints have no such option.
- **Redirect override:** answer with `{ "redirectUri": "https://shop.example.com/done" }` to send the user there instead of the configured `redirectUri`. This works for completed and, for OpenID4VP, failed presentations.
- **Delivery:** EUDIPLO sends one request and does not retry. A failed delivery is logged and does not change the session, so reconcile missed results by [polling](#polling). Webhook URLs must pass the [outbound URL policy](../reference/webhooks.md).

## Server-Sent Events

Subscribe to `GET /api/session/{id}/events?token=<access token>`. The token goes into the query string because the browser's `EventSource` cannot send headers; any valid access token of the session's tenant works. Use a short-lived token, as URLs can end up in proxy logs.

```javascript
const events = new EventSource(
    `${eudiploUrl}/api/session/${sessionId}/events?token=${encodeURIComponent(token)}`,
);
events.onmessage = (message) => {
    const { status } = JSON.parse(message.data);
    if (["completed", "failed", "expired"].includes(status)) {
        events.close();
        // Fetch the result from your backend, which reads GET /api/session/{id}.
    }
};
```

- The first event carries the current status, so a late subscriber does not miss a result.
- Each event has the form `{ "id": "<session id>", "status": "fetched", "updatedAt": "<ISO timestamp>" }`; every status is sent once.
- The stream ends after `completed`, `failed` or `expired`. Changes processed by another replica arrive within a few seconds.
- A missing or invalid token returns `401`, an unknown session `404`.

## Polling

Read the session with `GET /api/session/{id}`. The caller needs the `presentation:request` role (or `issuance:offer`). Poll every one or two seconds until `status` is `completed`, `failed` or `expired`:

```json
{
    "id": "3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11",
    "status": "completed",
    "requestId": "membership-check",
    "expiresAt": "2026-10-03T10:05:00.000Z",
    "consumedAt": "2026-10-03T10:01:12.000Z",
    "responseCode": "6b1f0d0e-1c4e-4a54-8f7e-0b8f1c2d3e4f",
    "credentials": [{ "id": "membership", "values": [{ "name": "Max", "member_id": "M-001" }] }],
    "outcome": { "result": "success", "credentials": [{ "id": "membership", "verified": true }] }
}
```

The response contains further session fields; the result fields are explained in the [session outcome reference](../reference/session-outcome.md). A request that runs out its lifetime is rejected immediately, but its status changes to `expired` only when the session maintenance job runs (`SESSION_TIDY_UP_INTERVAL`, default one hour). Stop waiting once `expiresAt` has passed.

## Same-device redirect

When the request has a `redirectUri`, the wallet sends the user's browser back to it after the presentation. EUDIPLO replaces `{sessionId}` and appends a one-time `response_code`:

```text
https://shop.example.com/verified?session=3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11&response_code=6b1f0d0e-1c4e-4a54-8f7e-0b8f1c2d3e4f
```

Before you accept the result for this browser:

1. Read the session with `GET /api/session/{id}` from your backend.
2. Check that `status` is `completed` and that `responseCode` equals the `response_code` from the URL.
3. Only then attach the verified claims to the browser's session.

The check proves that this browser received the redirect, so an attacker cannot make a victim complete a session the attacker started ([OID4VP §13.3](../concepts/sessions.md#session-binding-oid4vp-133)). EUDIPLO has no lookup by response code; always start from the session ID you stored when you created the request.

If the presentation fails, the redirect carries `error` and `error_description` instead of a `response_code`. A declined request uses the wallet's error code, such as `access_denied`; a failed verification uses `invalid_request`. ISO 18013-7 requests redirect only after success.

Requests are single-use, and sessions are deleted or anonymized after the tenant's retention time; see [Sessions](../concepts/sessions.md).
