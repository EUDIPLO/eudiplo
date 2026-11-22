---
title: Sessions
description: Session states, single-use rules, OID4VP session binding and retention.
---

# Sessions

A session is EUDIPLO's record of one issuance or presentation flow. It ties the wallet's requests to the offer or request your backend created, stores the result, and enforces that every one-time value is used once. This page explains the rules that apply to both flows.

## States

| Status      | Issuance                                                  | Presentation                                   |
| ----------- | --------------------------------------------------------- | ---------------------------------------------- |
| `active`    | Offer created                                             | Request created                                |
| `fetched`   | First credential issued                                   | Wallet fetched the request object              |
| `completed` | Wallet reported `credential_accepted`                     | Response verified                              |
| `failed`    | Wallet reported `credential_failure` or `credential_deleted` | Verification failed, or the wallet sent an error |
| `expired`   | Offer not redeemed before `expiresAt`                     | No response before `expiresAt`                 |
| `cancelled` | Offer [cancelled](#cancelling-an-offer) by an operator    | Request cancelled by an operator               |

The flow diagrams are on [Issuance under the hood](issuance.md#session-states) and [Presentation under the hood](presentation.md#session-states).

- **Terminal states are final.** `completed`, `failed`, `expired` and `cancelled` never change again. Redeeming the offer of a finished session, or answering its presentation request, is rejected and does not overwrite the result. This includes [OpenID4VCI notifications](../reference/session-outcome.md#issuance-notifications): the first event finishes the issuance session, later events are only recorded and forwarded.
- **Expiry is checked when the wallet arrives.** A presentation request expires after the configuration's `lifeTime` (default 300 seconds). An offer expires after `offerLifetimeSeconds` of the offer or the issuance configuration, and never if neither is set. The wallet-facing endpoints that redeem an offer (offer retrieval, PAR, authorization, token) or serve and answer a presentation request compare `expiresAt` with the current time, so an overdue session is rejected immediately (`invalid_grant` at the token endpoint, HTTP 400 or 404 elsewhere). The maintenance job only records the `expired` status afterwards.
- **Redeemed offers do not expire.** Once the token exchange succeeded, the wallet can keep requesting credentials with its tokens; `expiresAt` only limits redemption.
- **Results are structured.** A finished presentation stores an `outcome` with per-credential details, and a classified failure also a machine-readable failure code. An issuance session gets both from the wallet's [notification](../reference/session-outcome.md#issuance-notifications) ([Session outcome](../reference/session-outcome.md)).
- **Changes are observable.** Each status change is published on the event stream `GET /api/session/{id}/events`, which starts with the current status and ends after a terminal one, and in the `sessions` metric ([Receive results](../presentation/receive-results.md), [Monitoring](../operate/monitoring.md)).

## Single use

Each one-time value is consumed with one conditional database update, so two concurrent requests cannot both succeed, even across backend instances.

| Value                                     | Consumed when                                         | Second use gets                                       |
| ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Credential offer fetched by reference     | First retrieval (unless `ISSUER_MULTI_CONSUMPTION`)   | HTTP 404                                              |
| Pushed `request_uri`                      | First authorization request                           | `invalid_request_uri`                                 |
| Authorization code or pre-authorized code | First successful token request (the built-in server marks the session consumed) | `invalid_grant`             |
| Credential proof nonce                    | First credential request that uses it                 | `invalid_nonce`                                       |
| DPoP proof (`jti`)                        | First request that uses it                            | `invalid_dpop_proof` or `invalid_token`               |
| Ready deferred credential                 | First retrieval, with a token of the same session     | `invalid_transaction_id`                              |
| OID4VP or ISO 18013-7 response            | First response that completes or fails the session    | HTTP 400 "The presentation offer has already been used" |

A pre-authorized code is also only valid until the session's creation time plus the tenant's session TTL, and a transaction code (`tx_code`) locks the code after too many wrong attempts ([Credential offers](../issuance/credential-offers.md)).

## Session binding (OID4VP §13.3)

A presentation session has two identifiers, because the QR code is visible to anyone near the screen:

- The **session ID** is for your backend: the management API, webhooks and the event stream use it. Whoever has it can read the result.
- The **`walletNonce`** is for the wallet: it appears in `request_uri`, `response_uri` and as `state`. Seeing the QR code reveals only the `walletNonce`, not the session ID. The OID4VP endpoints do not accept the session ID in its place.

Two more values bind the response to the request:

- **`nonce`** is a random value in the request object. The wallet signs it into its key binding JWT or mdoc device authentication, so a presentation captured from another session cannot be replayed.
- **`response_code`** protects same-device flows. After a verified response, EUDIPLO creates a random `response_code`, stores it as `responseCode` on the session and appends it to the redirect URI the wallet opens. Your page passes it to your backend, which compares it with `responseCode` from `GET /api/session/{id}` before it accepts the result for this browser.

Without the `response_code`, an attacker could start a request at your site, send its link to a victim, and pick up the victim's verified result in the attacker's own browser session. With it, only the browser that the victim's wallet redirected can claim the result, and a session completes once, so it has exactly one code.

An ISO 18013-7 session has a `walletNonce` too (since 10.0): it is the last but one path segment of the offer's `org_iso_mdoc.response_uri`, and the response endpoint does not accept the session ID in its place. The OpenID4VP endpoints do not answer it.

Each presentation step of [interactive authorization](../issuance/interactive-authorization.md) creates a presentation session of its own. Since 10.0, its ID is not the `auth_session` the wallet continues the authorization with.

The [OID4VP-based authorization server](../issuance/authorization-servers.md) creates a presentation session with the ID of its authorization session, which is also the end of the pushed authorization `request_uri` and the `cas` parameter of its callback. The `request_uri` is no longer accepted once the wallet has opened it, before the presentation session exists. Since 10.0, the callback issues the authorization code only with the presentation session's `response_code`, and it ends the authorization only once the presentation session failed or expired.

An issuance session has a `walletNonce` as well (since 10.0). It is the last path segment of the `credential_offer_uri` and, in the authorization code flow, the offer's `issuer_state`, which an external authorization server copies into its access tokens. The issuer endpoints and authorization servers do not accept the session ID in its place. Offers created before 10.0 keep their session ID as `walletNonce`.

ISO 18013-7 has no `nonce` and `response_code` like OpenID4VP; its response endpoint is covered by the `walletNonce` above. How to implement the check is described in [Receive results](../presentation/receive-results.md); the specification text is in [OID4VP §13.3](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-session-identifier-separati).

## Cancelling an offer

An offer or presentation request that should not be used anymore, for example because it was sent to the wrong person, its link leaked or the user aborted the flow in your application, can be cancelled while it is `active` or `fetched` and no wallet has redeemed it yet:

```http
POST /api/session/{id}/cancel
Content-Type: application/json

{ "reason": "sent to wrong recipient" }
```

The body is optional.

- The session moves to `cancelled` and is kept for auditing. To remove it, use `DELETE /api/session/{id}`.
- A wallet can no longer use the offer or request to start a flow: offer retrieval, PAR, authorization and the token endpoint, as well as fetching or answering the presentation request, are rejected like for a finished session.
- Once a wallet exchanged the offer for tokens, the offer is redeemed and can no longer be cancelled (`409`); the wallet finishes its flow. Credentials that were already issued stay valid; revoke them with `POST /api/session/revoke` or on the session page of the web client ([Revocation](../issuance/revocation.md)).
- A session that is already `completed`, `failed`, `expired` or `cancelled` answers `409` and does not change. Cancellation, the token exchange and the presentation response use the same conditional update, so when they race exactly one wins.
- The optional `reason` (up to 500 characters) is stored as `cancelReason` on the session, shown on the session page of the Web Client, and recorded with the client that cancelled the session in the tenant [audit log](../operate/logging.md#audit-log), and in the session log when session logging is enabled. Sessions cancelled before 10.0 have no `cancelReason`. Like `reference`, it is stored in plaintext and stays when sessions are anonymized: never put personal data into it. The status change is published on the event stream, and the session's webhook receives a [cancellation webhook](../reference/webhooks.md#cancellation-webhook).

The web client offers the same action on the session page and as a bulk action in the session list.

## Finding sessions

`GET /api/session` lists the sessions of the caller's tenant, most recently updated first. All filters are optional, combined with AND, and always limited to the tenant, to the session types the client's roles allow and to the configurations the client is limited to ([Tenants and access](../operate/tenants-and-access.md#api-clients-with-least-privilege)).

| Parameter                   | Matches                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `createdFrom`, `createdTo`  | Creation time, bounds included. ISO 8601 with a time zone, for example `2026-10-02T08:00:00Z`.                                  |
| `updatedFrom`, `updatedTo`  | Time of the last change, for example sessions that completed or failed in the last hour.                                        |
| `status`                    | One or more states; repeat the parameter, for example `status=active&status=fetched` for pending sessions.                      |
| `type`                      | `issuance` or `presentation`.                                                                                                   |
| `credentialConfigurationId` | Issuance sessions that offer this credential configuration.                                                                     |
| `requestId`                 | Presentation sessions of this presentation configuration.                                                                       |
| `failureCode`               | Failed sessions with this [failure code](../reference/session-outcome.md#failure-codes), for example `trust_chain_not_trusted`. |
| `id`                        | Sessions whose ID starts with the value.                                                                                        |
| `q`                         | Search, see below.                                                                                                              |
| `sortBy`, `sortOrder`       | `id`, `status`, `createdAt`, `updatedAt` (default) or `requestId`; `asc` or `desc` (default).                                   |
| `page`, `pageSize`          | Page number from 1 (default 1) and page size from 1 to 100 (default 25).                                                        |

The response is paged: `items` holds the sessions of the page, and `total` and `totalPages` count all matches. An unknown parameter or status, a range that starts after it ends, an `id` that is not the beginning of a session ID, or a `requestId`, `credentialConfigurationId` or `failureCode` longer than 255 characters answers `400`.

```http
GET /api/session?type=presentation&status=failed&createdFrom=2026-10-02T08:00:00Z&requestId=age-check&sortBy=updatedAt&sortOrder=desc
```

`credentialConfigurationId` only finds issuance sessions created with 9.x or later releases that store the offered configuration IDs next to the encrypted offer; older sessions are not backfilled.

### Search

`q` takes whatever identifier you have at hand, for example from a log line, a support request or a screenshot of a QR code:

- a session ID or its beginning,
- the `walletNonce` of a presentation or offer (the offer's `issuer_state`),
- a pre-authorized code,
- the `reference` set when the offer or request was created,
- a pasted link: a credential offer link (by reference or by value) finds its session, an OID4VP request link (`openid4vp://?…request_uri=…`) finds the session of its `walletNonce`.

The search term can contain a pre-authorized code, so its value is replaced by `[redacted]` in all log lines and in the `url.query` attribute of traces. The web client offers the same filters in the session list and keeps them in the URL, so a filtered view can be bookmarked or shared; its update-time presets (for example "Last hour") stay relative in a bookmark.

### Your own reference

`POST /api/issuer/offer` and `POST /api/verifier/offer` accept an optional `reference`, an identifier of your system such as an order or case ID (up to 255 characters). It is returned in the session list and detail, sent in the session's webhooks and found by `q`. The reference is stored **in plaintext** and **stays when sessions are anonymized**: never put personal data into it.

### From a log line to the session

Once a wallet request has resolved its session (by offer ID, `walletNonce`, `issuer_state`, code or access token), every following log line of that request carries `sessionId` and `tenantId`, with or without OpenTelemetry, and the request's trace gets the `session.id` attribute. See [Logging](../operate/logging.md#correlate-logs-with-sessions).

### Counting sessions

`GET /api/session/stats` counts the tenant's sessions over all pages, with the same role scope and configuration limits as the list. `createdFrom` and `createdTo` limit it to sessions created in a time range, with the same format and checks as in the list. The response has one entry per session type the client may read, `issuance` and `presentation`, each with:

- `total` and a count for every state in `byStatus` (`0` when there is none),
- `failureCodes`, the [failure codes](../reference/session-outcome.md#failure-codes) of the failed sessions, most frequent first, at most 10 and cut to 255 characters; failed sessions without a code are not listed; issuance sessions record `credential_failure` and `credential_deleted` from [wallet notifications](../reference/session-outcome.md#issuance-notifications),
- `lastCompletedAt`, the last update of the most recently updated completed session (`null` when none completed).

Only stored sessions count: in the default `full` [cleanup](#session-cleanup) mode, sessions older than the TTL are deleted and drop out. `retention` reports the tenant's effective `ttlSeconds` and `cleanupMode`, so a client can tell how far back the counts reach.

The web client's dashboard shows these numbers for all stored sessions and for an activity window that retention allows: the last seven days by day when sessions are kept for a week or anonymized, fewer days when they are kept for two to six days, and otherwise the last hours by hour, for example the last 24 hours with the default TTL.

```http
GET /api/session/stats?createdFrom=2026-10-04T00:00:00%2B02:00&createdTo=2026-10-10T23:59:59%2B02:00
```

```json
{
  "presentation": {
    "total": 42,
    "byStatus": { "active": 3, "fetched": 1, "completed": 35, "expired": 2, "failed": 1, "cancelled": 0 },
    "failureCodes": [{ "code": "trust_chain_not_trusted", "count": 1 }],
    "lastCompletedAt": "2026-10-10T08:12:44.000Z"
  },
  "retention": { "ttlSeconds": 86400, "cleanupMode": "full" }
}
```

## Session cleanup

Sessions contain personal data: claims, offers, authorization requests and presented credentials. Sensitive fields are encrypted at rest ([Security model](security-model.md#encryption-at-rest)), and sessions are kept only for a retention period:

- A maintenance job runs every `SESSION_TIDY_UP_INTERVAL` seconds (default one hour). It marks overdue sessions as `expired`, then processes every session older than the tenant's TTL, counted from creation (default `SESSION_TTL`, 24 hours).
- In `full` mode (default) the session is deleted.
- In `anonymize` mode the session keeps its status, timestamps and protocol metadata, but `credentials`, `credentialPayload`, `auth_queries`, `offer`, `requestObject` and `responseEncryptionPrivateJwk` are cleared. The plaintext `reference`, `cancelReason` and `credentialConfigurationIds` are kept.

The TTL also limits how long a pre-authorized code is valid. The global defaults are `SESSION_TTL` and `SESSION_CLEANUP_MODE` ([environment variables](../reference/environment-variables.md#session)); a tenant can override both through `/api/session-config`. Session log entries are stored separately and controlled by `LOG_SESSION_STORE` ([Logging](../operate/logging.md)).
