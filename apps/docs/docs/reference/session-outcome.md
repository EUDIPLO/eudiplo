---
title: Session Outcome
---

Statuses, result fields and failure codes of EUDIPLO sessions, as returned by `GET /api/session/{id}`, sent in [SSE events](../presentation/receive-results.md#server-sent-events) and in [webhooks](webhooks.md). How to receive them is described in [Receive Results](../presentation/receive-results.md).

## Statuses

| Status      | Presentation session                                                                                           | Issuance session                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `active`    | Request created; the wallet has not fetched it yet.                                                            | Offer created.                                                                                    |
| `fetched`   | The wallet fetched the request object. ISO 18013-7 sessions skip this status.                                  | The first credential of the session was issued.                                                   |
| `completed` | The presentation was verified.                                                                                 | The wallet reported `credential_accepted` ([Notifications](../issuance/notifications.md)).        |
| `failed`    | Verification failed, or the wallet sent an error response (for example the user declined).                    | The wallet reported `credential_failure` or `credential_deleted`.                                 |
| `expired`   | `expiresAt` passed before the session finished.                                                                | The offer expired before it was redeemed ([Credential Offers](../issuance/credential-offers.md)). |

Sessions only move forward: `active` → `fetched` → `completed`, `failed` or `expired`. The last three are terminal; a later wallet request is rejected with `400`, and a late response never overwrites the final status.

Expiry is enforced when a wallet uses the session: a presentation request or response after `expiresAt` gets `400` ("The session has expired"). The status itself changes to `expired` when the session maintenance job runs, every `SESSION_TIDY_UP_INTERVAL` seconds (default 3600). Until then an overdue session still shows `active` or `fetched`.

## Result fields

| Field              | Content                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | See above.                                                                                                                                                                                  |
| `credentials`      | Only when `completed`. OpenID4VP: `[{ "id": "<query id>", "values": [ { <claims> } ] }]`, one `values` entry per presented credential. ISO 18013-7: `[{ "id", "format": "mso_mdoc", "docType", "claims" }]`. |
| `outcome`          | Structured result, see below. Set on `completed` and `failed`.                                                                                                                              |
| `failureCode`      | Stable code of a classified failure, see [failure codes](#failure-codes). Absent for other failures.                                                                                        |
| `errorReason`      | Short, display-safe description of the failure.                                                                                                                                             |
| `responseCode`     | One-time code of a completed OpenID4VP or ISO 18013-7 presentation; compare it with the `response_code` of a [same-device redirect](../presentation/receive-results.md#same-device-redirect). |
| `consumedAt`       | When the presentation completed.                                                                                                                                                            |
| `expiresAt`        | When the request expires (presentation configuration `lifeTime`, default 300 seconds).                                                                                                      |
| `transaction_data` | The [transaction data](../presentation/transaction-data.md) sent with the request.                                                                                                          |

## Outcome

```json
{
    "result": "failed",
    "error": "trust_chain_not_trusted",
    "message": "The credential issuer is not in the trusted list.",
    "credentials": [
        {
            "id": "pid",
            "format": "mso_mdoc",
            "docType": "eu.europa.ec.eudi.pid.1",
            "verified": false,
            "error": "trust_chain_not_trusted",
            "message": "The credential issuer is not in the trusted list."
        }
    ]
}
```

| Field                      | Content                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result`                   | `success` or `failed`.                                                                                                                                             |
| `error`                    | Failure code; same value as `failureCode`. Only for classified failures.                                                                                           |
| `message`                  | Short, display-safe message; same value as `errorReason`.                                                                                                          |
| `credentials[]`            | Per credential query. On success every presented query with `"verified": true`; on a classified verification failure the credential that failed, with its `error` and `message`. |
| `credentials[].format`, `docType` | Credential format and, for mDOC, the docType, when known.                                                                                                    |
| `credentials[].trust`      | ISO 18013-7 success only: the matched trust list entry (`matchedIssuer`, `issuanceThumbprint`, `matchMode`, `revocationThumbprint`).                               |

Branch on `error`; treat `message` as display text. Detailed diagnostics, such as certificate subjects or trust list URLs, are never part of the outcome; they go to the server log and the [session log](#session-logs).

## Failure codes

### Credential verification

The same codes are used for SD-JWT VC and mDOC, in OpenID4VP and ISO 18013-7 flows.

| Code                      | Message                                                                          | Cause                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `signature_invalid`       | The credential signature is invalid.                                             | Issuer or device signature does not verify: tampered credential, wrong session transcript or key mismatch.             |
| `no_trust_chain_to_root`  | The credential issuer does not chain to a trusted root.                          | No certificate path from the credential's certificate to a certificate in the trust list.                              |
| `trust_chain_not_trusted` | The credential issuer is not in the trusted list.                                | A path exists, but it matches no PID or EAA issuance entry of the trust list.                                          |
| `trust_list_unavailable`  | The trusted list could not be loaded, so the credential could not be validated. | A configured trust list could not be fetched, parsed or signature-checked, or its `NextUpdate` has passed. EUDIPLO fails closed. This is a verifier-side problem. |
| `certificate_expired`     | The credential issuer certificate is expired or not yet valid.                  | A certificate in the path is outside its validity period.                                                              |
| `x5c_missing`             | The credential is missing its issuer certificate chain.                         | The credential carries no `x5c` certificate chain.                                                                     |
| `verification_error`      | The credential could not be verified.                                            | Any other verification error, including a malformed `x5c` and federation trust failures.                              |

### Wallet error responses

When the wallet answers with an OAuth error instead of a presentation, for example because the user declined, EUDIPLO records the wallet's code as `failureCode` (`access_denied`, `invalid_request`, `vp_formats_not_supported`, `wallet_unavailable`, ...). `errorReason` and `outcome.message` read `Wallet error: <error>: <error_description>`. The wallet gets HTTP `200`, as OpenID4VP 1.0 §8.2 requires, with a `redirect_uri` carrying `error` and `error_description` if a redirect is configured. EUDIPLO accepts the error both as form parameters and inside an encrypted `direct_post.jwt` response.

### Other failures

Some failures have no code; `failureCode` and `outcome.error` are absent and `errorReason` describes the problem. Examples:

- `Missing required credentials: ...` or `Missing required claims for credential '...': ...`: the response does not satisfy the DCQL query.
- `Presentation validation failed: ...`: for example a transaction data hash mismatch, an invalid key binding, or several presentations for a query without `multiple`.
- `HPKE decryption failed`: an ISO 18013-7 response that cannot be decrypted.

### What the wallet or browser receives

An OpenID4VP response that fails verification is answered with `400`; with a configured redirect the body contains `redirect_uri` with `error=invalid_request` and the message as `error_description`. An ISO 18013-7 response that fails verification is answered with `400` and the code:

```json
{
    "statusCode": 400,
    "timestamp": "2026-10-03T10:01:12.000Z",
    "path": "/presentations/3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11/iso-18013-7",
    "error": "trust_chain_not_trusted",
    "message": "The credential issuer is not in the trusted list."
}
```

## Session logs

`GET /api/session/{id}/logs` returns the log entries stored for a session (`timestamp`, `level` (`info`, `warn` or `error`), `stage`, `message`, `detail`). Entries are only stored when `LOG_SESSION_STORE` is `errors` (warnings and errors), `all` or `verbose` (also request and response bodies); the default `off` stores nothing. See [Environment Variables](environment-variables.md#logging).
