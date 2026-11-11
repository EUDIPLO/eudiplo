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
| `statusCheckMode`       | `strict` (default): status lists are checked and verification fails if a status list cannot be fetched or validated, or if a credential's status (SD-JWT VC `status` claim, mDOC MSO `status`) names only another status mechanism. Credentials without status information are accepted, except a PID whose validity period is longer than 24 hours, which fails with `verification_error` (ARF Annex 2, VCR_01, VCR_01b and VCR_14). A credential is a PID when its certificate chain matches a certificate listed with a `PID/Issuance` service in the trust lists (a CA it was issued under, or its own end-entity certificate), also if that certificate is listed with another service as well. Its validity period runs from `nbf` (else `iat`) to `exp` of the SD-JWT VC, where a selectively disclosable `iat` counts only if the wallet discloses it, or from `validFrom` to `validUntil` of the mDOC's MSO; a PID without a start or an end counts as longer than 24 hours. EAAs and Pub-EAAs without status information are left to the relying party's policy and accepted. `best_effort`: verification continues without the status result when the status list is unavailable, and accepts such a PID with a warning. Both reject a status list that is not ZLIB-compressed or decompresses to more than 16 MiB (SD-JWT VC) or 1 MiB (mDOC). Both fail with `verification_error`, without fetching a list, on a malformed status reference: an SD-JWT VC `status` claim that is not a non-empty object, a `status_list` that is not an object, a `uri` that is not an absolute URI, or an `idx` that is not a non-negative integer, and for an mDOC an MSO `status` that names no mechanism or a status list or identifier list `uri` that is not an absolute URI. `disabled`: no status check. Applies to SD-JWT VC and mDOC, including ISO 18013-7. |
| `dcql_query`            | See [DCQL](../presentation/dcql.md). `<TENANT_URL>` anywhere in the query is replaced with `<PUBLIC_URL>/issuers/<tenant>`.                                                                                                               |
| `transaction_data`      | Sent with every request unless the request sets its own `transaction_data`. An ISO 18013-7 request answers `400` unless it sends `"transaction_data": []`. See [Transaction Data](../presentation/transaction-data.md).                                                                          |
| `registration_cert`     | Strategies `jwt`, `id`, `body`. `id` and `body` need a registrar configuration; `jwt` does not. See [Registration Certificates](../trust/registration-certificates.md).                                                                        |
| `registrationCert*`     | Flat form fields used by the Web Client. They are converted into `registration_cert` (only when `registration_cert` is not sent) and are not stored.                                                                                      |
| `webhookEndpointId`     | ID of a [webhook endpoint](webhooks.md) that receives results. A request can override it with an inline `webhook`.                                                                                                                        |
| `attached`              | Stored with the configuration; currently not sent to the wallet.                                                                                                                                                                          |
| `redirectUri`           | Same-device redirect target. `{sessionId}` is replaced with the session ID. A request can override it, except for ISO 18013-7. See [Receive Results](../presentation/receive-results.md).                                                  |
| `accessKeyChainId`      | Access key chain that signs the request, determines the `client_id` and signs `readerAuth`. Without it, EUDIPLO uses the tenant's [default access key chain](../trust/keys-and-certificates.md#default-access-key-chain): `access` of its key chain defaults, else one picked by rule, which prefers a registrar or other CA-issued certificate. |
| `allowedOrigins`        | Unset or empty: any `expected_origin` is accepted. When set, `dc-api` and `iso-18013-7` requests must name one of these origins, or none if exactly one is listed. Not used for `uri` requests. See [Allowed origins](../presentation/configure-verification.md#allowed-origins-digital-credentials-api). |
| `readerAuth`            | `false`. ISO 18013-7 only: sign the `DeviceRequest` with the access key chain. Requires the `db` KMS provider for that key.                                                                                                                |

## Validation rules

Rules that the table cannot show:

- `dcql_query.credentials` needs at least one entry; credential query IDs contain only letters, digits, `_` and `-`, and are unique.
- `meta` is required: `vct_values` (at least one) for `dc+sd-jwt`, `doctype_value` for `mso_mdoc`.
- Every credential query needs `trusted_authorities` with an `etsi_tl` trust list or an `openid_federation` trust anchor, unless `SKIP_TRUST_AUTHORITY=true`. See [DCQL](../presentation/dcql.md#accept-only-trusted-issuers).
- Every ID in `claim_sets` must reference the `id` of a claim in the same credential query; claim IDs are unique.
- Each `allowedOrigins` entry is an origin in serialized form: `https` or `http` scheme, lower-case host, a port only if it is not the default (`443`, `80`), no path, query, credentials or trailing slash. At most 100 entries.
- `transaction_data` entries whose `type` starts with `urn:eudi:sca:` must be a supported [TS12 type with a valid payload](../presentation/transaction-data.md#ts12-sca-transaction-data).
- `transaction_data` entries must name in `credential_ids` only `dc+sd-jwt` queries of the DCQL query ([Which credentials an entry may reference](../presentation/transaction-data.md#which-credentials-an-entry-may-reference)).

## Server-managed fields

Responses also contain `createdAt`, `updatedAt` and `registrationCertCache` (the registration certificate EUDIPLO resolved, with fingerprints and expiry). They are read-only and not part of the schema, so the API rejects them in a request body. When EUDIPLO resolves the certificate again is described in [Registration Certificates](../trust/registration-certificates.md#validation-and-caching).
