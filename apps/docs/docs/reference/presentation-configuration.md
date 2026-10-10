---
title: Presentation Configuration
---

import SchemaReference from "@site/src/components/SchemaReference";

Fields of a presentation configuration, as accepted by `POST /api/verifier/config` and in `config/<tenant>/presentation/<id>.json`. `PATCH /api/verifier/config/{id}` accepts the same fields, all optional. For the task-oriented guide see [Configure Verification](../presentation/configure-verification.md).

## Fields

The table is generated at build time from the Zod schema the backend validates with. The schema is strict: unknown fields are rejected. `dcql_query.credentials[]` has one shape per format (`mso_mdoc` and `dc+sd-jwt`).

<SchemaReference name="presentation-configuration" mode="table" />

## Defaults and behavior

| Field                   | Default and behavior                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | Used as `requestId` in [presentation requests](../presentation/requests.md).                                                                                                                                                               |
| `description`           | Internal only; not shown to the wallet user.                                                                                                                                                                                               |
| `lifeTime`              | `300`. Seconds until a request created from this configuration expires (`expiresAt` of the session).                                                                                                                                      |
| `skewSeconds`           | `60`. Clock skew tolerance for credential time checks; a request can override it.                                                                                                                                                         |
| `statusCheckMode`       | `strict`: status lists are checked and verification fails if a status list cannot be fetched or validated, or if an SD-JWT VC's `status` claim has no `status_list`. Credentials without status information are accepted. `best_effort`: verification continues without the status result when the status list is unavailable. `disabled`: no status check. Applies to SD-JWT VC and mDOC, including ISO 18013-7. |
| `dcql_query`            | See [DCQL](../presentation/dcql.md). `<TENANT_URL>` anywhere in the query is replaced with `<PUBLIC_URL>/issuers/<tenant>`.                                                                                                               |
| `transaction_data`      | Sent with every request unless the request sets its own `transaction_data`. Ignored for ISO 18013-7. See [Transaction Data](../presentation/transaction-data.md).                                                                          |
| `registration_cert`     | Strategies `jwt`, `id`, `body`. Only attached when the tenant has a registrar configuration. See [Registration Certificates](../trust/registration-certificates.md).                                                                        |
| `registrationCert*`     | Flat form fields used by the Web Client. They are converted into `registration_cert` (only when `registration_cert` is not sent) and are not stored.                                                                                      |
| `webhookEndpointId`     | ID of a [webhook endpoint](webhooks.md) that receives results. A request can override it with an inline `webhook`.                                                                                                                        |
| `attached`              | Stored with the configuration; currently not sent to the wallet.                                                                                                                                                                          |
| `redirectUri`           | Same-device redirect target. `{sessionId}` is replaced with the session ID. A request can override it, except for ISO 18013-7. See [Receive Results](../presentation/receive-results.md).                                                  |
| `accessKeyChainId`      | Access key chain that signs the request, determines the `client_id` and signs `readerAuth`. Without it, EUDIPLO uses an access key chain of the tenant; set it when the tenant has several.                                                  |
| `readerAuth`            | `false`. ISO 18013-7 only: sign the `DeviceRequest` with the access key chain. Requires the `db` KMS provider for that key.                                                                                                                |

## Validation rules

Rules that the table cannot show:

- `dcql_query.credentials` needs at least one entry; credential query IDs contain only letters, digits, `_` and `-`, and are unique.
- `meta` is required: `vct_values` (at least one) for `dc+sd-jwt`, `doctype_value` for `mso_mdoc`.
- Every credential query needs `trusted_authorities` with an `etsi_tl` trust list or an `openid_federation` trust anchor, unless `SKIP_TRUST_AUTHORITY=true`. See [DCQL](../presentation/dcql.md#accept-only-trusted-issuers).
- Every ID in `claim_sets` must reference the `id` of a claim in the same credential query; claim IDs are unique.
- `transaction_data` entries whose `type` starts with `urn:eudi:sca:` must be a supported [TS12 type with a valid payload](../presentation/transaction-data.md#ts12-sca-transaction-data).

## Server-managed fields

Responses also contain `createdAt`, `updatedAt` and `registrationCertCache` (the registration certificate EUDIPLO resolved, with fingerprints and expiry). They are read-only and not part of the schema, so the API rejects them in a request body. EUDIPLO clears the cache when `registration_cert` or `dcql_query` changes and refreshes it in the background. To force a new certificate, call `POST /api/verifier/config/{id}/registration-cert/reissue`.
