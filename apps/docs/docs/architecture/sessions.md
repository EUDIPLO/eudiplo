---
title: Sessions
---

# Sessions

EUDIPLO tracks **issuance** and **verification** sessions to correlate multi-step protocol flows, enforce security policies, and maintain audit logs. Sessions are ephemeral state records that exist only while a credential flow is active.

## OID4VP Security Fields

Each verification session includes security fields defined by the OpenID4VP specification (§13.3):

| Field          | Purpose                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `walletNonce`  | Wallet-facing nonce, included in presentation requests                                               |
| `sessionId`    | Internal correlation ID, never exposed to the wallet                                                 |
| `nonce`        | Server-side replay prevention nonce (deprecated in favor of `walletNonce` for clarity)               |
| `state`        | Same-device state parameter (optional, for redirect-based flows)                                     |
| `responseCode` | One-time code for same-device redirect flow (appended to `redirect_uri` to prevent session fixation) |

**Security Rationale:**

- `walletNonce` is the ONLY nonce value sent to the wallet and included in VP tokens
- `sessionId` remains internal and is used only for backend correlation (e.g., mapping to `response_code`)
- This separation prevents session fixation attacks where an attacker could substitute their own session identifier

For technical background, see [OID4VP §13.3 (Security Considerations)](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-session-identifier-separati).

## Session Status and Events

A session moves through `active` → `fetched` → `completed`, `failed` or `expired`. Every status change of issuance and presentation sessions is published as a Server-Sent Event on `GET /session/:id/events` (used by the admin UI) and updates the session metrics. Terminal states also clear the session's response-encryption private key.

## Single-Use Validation

Every one-time value is consumed with a single conditional database update, so concurrent requests cannot both succeed:

- Authorization and pre-authorized codes: the first token request marks the session consumed; later or concurrent requests get `invalid_grant`.
- Pushed `request_uri`s: expired on first use; a second authorize call gets `invalid_request_uri`.
- Credential proof nonces: deleted on use; a reused nonce gets `invalid_nonce`.
- OID4VP and ISO 18013 responses: only the first response completes the session (and triggers the webhook); others get `400` "The presentation offer has already been used".
- Credential offers by reference are consumed on first retrieval (unless `ISSUER_MULTI_CONSUMPTION` is enabled), and a ready deferred credential can be retrieved once, only with an access token of the session that requested it.

A pre-authorized code is additionally only valid until the session's creation time plus the tenant's session TTL, and a transaction code (`tx_code`) locks the code after `txCodeMaxAttempts` wrong attempts (default 5). See [Credential Offers](../issuance/credential-offers.md#pre-authorized-code-lifetime-and-transaction-codes).

## Session Cleanup

A maintenance job runs every `SESSION_TIDY_UP_INTERVAL` seconds (default: 1 hour). It marks overdue presentation sessions as `expired`, then applies each tenant's retention policy to sessions whose creation time is older than the tenant's TTL. Two cleanup modes exist:

| Mode | Effect | Use when |
| --- | --- | --- |
| `full` (default) | Deletes the session record. | No audit trail of the flow is required. |
| `anonymize` | Keeps the record but clears `credentials`, `credentialPayload`, `auth_queries`, `offer`, `requestObject` and `responseEncryptionPrivateJwk`. | Flow metadata (timestamps, protocol details, status) must be retained, but not credential data. |

## Per-Tenant Configuration

Tenants override the global defaults through the session configuration API (`GET`, `PUT` and `DELETE /session-config`):

```json
{
    "ttlSeconds": 3600,
    "cleanupMode": "anonymize"
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `ttlSeconds` | `number` | `SESSION_TTL` (86400) | Session lifetime in seconds: retention period for cleanup and validity of pre-authorized codes. |
| `cleanupMode` | `"full" \| "anonymize"` | `SESSION_CLEANUP_MODE` (`full`) | What cleanup does with sessions older than `ttlSeconds`. |

Setting a field to `null` restores the global default.

## Code Structure

Session persistence is behind the `SessionRepository` port (`session/ports/`) with a TypeORM adapter covered by a shared SQLite/PostgreSQL contract test. Other features use `SessionStore` for lookups and updates (including the atomic single-use operations) and `ChangeSessionState` for status transitions with events and metrics. Cleanup and metric initialization are the `CleanupSessions` and `InitializeSessionMetrics` use cases, scheduled by `SessionMaintenanceJob`. See [Backend Architecture](./backend-architecture.md#reference-implementations).

## Session Logs

Session events (authorization, token exchange, credential issuance, presentation submission) are logged using the PinoLogger:

```typescript
this.logger.log(`Credential issued for session ${sessionId}`, {
    sessionId,
    credentialType,
    format,
});
```

Logs include correlation IDs and are exportable to SIEM systems via OpenTelemetry or log aggregators.

## Global Configuration

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="session" />
