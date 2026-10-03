---
title: Registration Certificates
---

# Registration Certificates

Registration certificates authorize credential presentation requests from EUDI Wallets. They ensure that verifiers are authorized to request specific credentials and prevent overasking.

## When Are They Used?

Registration certificates are attached to OID4VP requests when:

- A registrar is configured for the tenant, and
- The selected presentation config contains a `registrationCert` field

## Resolution Strategies

The `registrationCert` field supports three mutually exclusive strategies, evaluated in priority order:

| Field                   | Behavior                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registrationCert.jwt`  | Uses the provided JWT directly (no registrar call). Still validated for expiry and DCQL authorization.                                                                          |
| `registrationCert.id`   | Looks up an existing (non-revoked) certificate by ID from the registrar. Falls back to creating a new one using `registrationCert.body` if no active cert is found for that ID. |
| `registrationCert.body` | Creates a new certificate at the registrar using the merged body (see below).                                                                                                   |

At least one of `jwt`, `id`, or `body` must be provided.

## Payload Merging

When creating via `body`, the final certificate payload is merged in this order (later takes precedence):

1. `registrationCertificateDefaults` from the tenant's registrar config (shared legal/contact defaults)
2. `registrationCert.body` from the presentation config (per-presentation overrides)

The `rpId` is always derived automatically from the tenant's registrar relying party and cannot be set manually.

## Required Fields

After merging, these fields must be present:

| Field            | Where to set                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `privacy_policy` | Registrar defaults or presentation body                          |
| `support_uri`    | Registrar defaults or presentation body                          |
| `purpose`        | Presentation body (`registrationCert.body.purpose`)              |
| `credentials`    | Auto-derived from `dcql_query.credentials` if not explicitly set |

## Credential Auto-Derivation

If `registrationCert.body.credentials` is not explicitly set, EUDIPLO automatically derives the credentials list from the effective DCQL query (`dcql_query.credentials`) of the presentation config.

Only the `format`, `claims`, and `meta` fields are forwarded to the registrar. DCQL-only fields like `id`, `multiple`, and `trusted_authorities` are stripped.

## Certificate Validation

Every registration certificate (regardless of source) is validated before use:

### Temporal Validity

`exp` and `nbf` are checked with a 60-second clock-skew tolerance. Expired or not-yet-valid certificates are rejected.

### DCQL Authorization (Overasking Prevention)

Every credential requested in the DCQL query must be present in the certificate's authorized `credentials` claim. If the certificate does not cover all requested credentials, the request is rejected to prevent overasking.

For development and interoperability testing, the check can be turned off with `SKIP_OVERASKING_CHECK=true`. The JWT and its `exp`/`nbf` are still validated; the service logs a warning on startup and for every request that skips the check. Never enable it in production. See [Skip Flags](../reference/environment-variables.md#skip-flags).

## Recommended Setup

### Registrar Defaults

Shared legal/contact defaults for all presentation configs:

```json title="config/{tenant-id}/registrar.json"
{
    "registrationCertificateDefaults": {
        "privacy_policy": "https://verifier.example/privacy",
        "support_uri": "mailto:support@verifier.example"
    }
}
```

### Presentation Config

Per-presentation fields:

```json title="Presentation config"
{
    "registrationCert": {
        "body": {
            "purpose": [{ "lang": "en", "value": "Age verification" }]
        }
    }
}
```

## Related Topics

- [Registrar](registrar.md) — Configuring registrar credentials and access certificates
- [Presentation Configuration](../presentation/configure-verification.md) — Defining verification requests
- [DCQL Queries](../presentation/dcql.md) — Structured credential queries
