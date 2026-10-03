---
title: DCQL (Digital Credentials Query Language)
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Trust Authorities' (ETSI trust lists, own trust lists, AKI transformation, verification behavior) -> trust/trust-lists.md and cookbooks/trusted-issuers.md; keep a one-sentence link
  - add credential_sets from concepts/presentation.md ('DCQL (Digital Credentials Query Language)')
-->

DCQL (Digital Credentials Query Language) is a standardized query format for requesting specific credentials and claims from wallets in OpenID4VP flows. EUDIPLO uses DCQL in the `dcql_query` field of presentation configurations.

## Overview

DCQL allows verifiers to:

- Request specific credential formats (SD-JWT, mDoc, etc.)
- Select specific claims from credentials
- Define trust requirements for credential issuers
- Allow or restrict multiple matching credentials

## Schema Reference

The full DCQL JSON schema is available at [DCQL.schema.json](https://github.com/openwallet-foundation/eudiplo/blob/main/schemas/DCQL.schema.json) in the repository.

## Basic Structure

```json
{
    "dcql_query": {
        "credentials": [
            {
                "id": "credential-query-id",
                "format": "mso_mdoc",
                "meta": {
                    "doctype_value": "eu.europa.ec.eudi.pid.1"
                },
                "claims": [
                    {
                        "path": ["eu.europa.ec.eudi.pid.1", "given_name"]
                    },
                    {
                        "path": ["eu.europa.ec.eudi.pid.1", "family_name"]
                    }
                ],
                "trusted_authorities": [
                    {
                        "type": "etsi_tl",
                        "values": [
                            {
                                "trustListId": "local-pid-trust-list"
                            }
                        ]
                    }
                ]
            }
        ]
    }
}
```

## Credential Query Fields

Each entry in the `credentials` array defines one credential query:

| Field                 | Type    | Required | Description                                                 |
| --------------------- | ------- | -------- | ----------------------------------------------------------- |
| `id`                  | string  | Yes      | Unique identifier for this credential query                 |
| `format`              | string  | Yes      | Credential format (e.g., `mso_mdoc`, `dc+sd-jwt`)           |
| `meta`                | object  | No       | Format-specific metadata (e.g., `doctype_value` for mDoc)   |
| `claims`              | array   | No       | Specific claims to request (see below)                      |
| `multiple`            | boolean | No       | Allow multiple matching credentials. Default: `false`       |
| `trusted_authorities` | array   | No       | Trust requirements for credential issuers (see below)       |
| `claim_sets`          | array   | No       | Alternative claim combinations (any matching set satisfies) |

## Requesting Claims

Claims are specified using JSON path arrays:

### SD-JWT Format

```json
{
    "id": "employee-badge",
    "format": "dc+sd-jwt",
    "meta": {
        "vct_values": ["EmployeeBadge"]
    },
    "claims": [
        {
            "path": ["employee_id"]
        },
        {
            "path": ["department"]
        }
    ]
}
```

### mDoc Format

```json
{
    "id": "pid-mso-mdoc",
    "format": "mso_mdoc",
    "meta": {
        "doctype_value": "eu.europa.ec.eudi.pid.1"
    },
    "claims": [
        {
            "path": ["eu.europa.ec.eudi.pid.1", "given_name"]
        },
        {
            "path": ["eu.europa.ec.eudi.pid.1", "family_name"]
        },
        {
            "path": ["eu.europa.ec.eudi.pid.1", "birthdate"]
        }
    ]
}
```

## Trust Authorities

To validate that a credential was issued by a trusted entity, configure trust lists per credential using the `trusted_authorities` field. This follows the [OID4VP Trusted Authorities Query](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-trusted-authorities-query) specification.

### Structure

Each entry in `trusted_authorities` specifies:

- `type`: The trust framework type. Supported values:
    - `etsi_tl` — ETSI TS 119 602 List of Trusted Entities (LoTE)
    - `openid_federation` — OpenID Federation trust anchors
- `values`: Array of trust anchors.

### ETSI Trust Lists

For `etsi_tl`, each `values` entry can be:

**Managed local trust list pointer:**

```json
{
    "type": "etsi_tl",
    "values": [
        {
            "trustListId": "local-pid-trust-list"
        }
    ]
}
```

**External trust list reference:**

```json
{
    "type": "etsi_tl",
    "values": [
        {
            "url": "https://example.com/trust-list/pid-provider.jwt",
            "verifierX509Der": "MIIB..."
        }
    ]
}
```

When `trustListId` is used, EUDIPLO resolves:

- LoTE URL as `<TENANT_URL>/trust-list/{trustListId}`
- verifier certificate from the trust list key chain

### Using Your Own Trust Lists

You can reference trust lists published by your own EUDIPLO instance at `/{tenantId}/trust-list/{trustListId}`. You can also use the `<TENANT_URL>` placeholder in trust list URLs, which will be replaced with the tenant's base URL at runtime.

### Automatic Transformation to AKI

:::info[Automatic transformation to `aki` in authorization requests]
The `etsi_tl` format with `TrustListRef` objects is an **internal configuration format** only. When EUDIPLO builds the OID4VP authorization request sent to wallets, it automatically transforms each `etsi_tl` entry into the DCQL-compliant `aki` (Authority Key Identifier) format required by [OID4VP 1.0 Final §6](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-trusted-authorities-query).

The transformation extracts the Subject Key Identifier (SKI, OID 2.5.29.14) from the trust anchor certificate and encodes it as a base64url string. A wallet can match credentials locally by checking whether any certificate in a credential's chain was signed by a CA whose key identifier equals one of the `aki` values — without fetching external trust-list resources.

**Configuration format** (stored in EUDIPLO):

```json
{ "type": "etsi_tl", "values": [{ "trustListId": "my-list" }] }
```

**Wire format** (sent to wallets):

```json
{ "type": "aki", "values": ["<base64url-encoded-SKI>"] }
```

:::

### Verification Behavior

During verification, EUDIPLO will:

1. Fetch the LoTE JWT(s) from the provided URLs
2. Parse the trusted entities and their certificates
3. Validate that the credential's issuer certificate chains to one of the trusted entities
4. If status checks are enabled (`statusCheckMode` is `strict` or `best_effort`), ensure the status list (if present) is signed by the revocation certificate from the **same** trusted entity

:::warning[Trust validation is opt-in per credential]
If `trusted_authorities` is not specified on a credential query, trust list validation is **skipped** for that credential. To enforce trust validation, always include `trusted_authorities` in your DCQL credential queries.
:::

## Claim Sets

Claim sets define alternative combinations of claims. The credential satisfies the query if it contains **all claims from any one set**:

```json
{
    "id": "age-verification",
    "format": "mso_mdoc",
    "meta": {
        "doctype_value": "eu.europa.ec.eudi.pid.1"
    },
    "claim_sets": [["age_over_18"], ["birthdate"]]
}
```

In this example, the credential satisfies the query if it contains either:

- The `age_over_18` claim, **OR**
- The `birthdate` claim

## Multiple Credentials

By default, EUDIPLO expects exactly one credential matching each query. Set `multiple: true` to allow multiple matching credentials:

```json
{
    "id": "employee-badges",
    "format": "dc+sd-jwt",
    "multiple": true,
    "claims": [
        {
            "path": ["badge_type"]
        }
    ]
}
```

## Full Example

```json
{
    "dcql_query": {
        "credentials": [
            {
                "id": "pid-mso-mdoc",
                "format": "mso_mdoc",
                "meta": {
                    "doctype_value": "eu.europa.ec.eudi.pid.1"
                },
                "claims": [
                    {
                        "path": ["eu.europa.ec.eudi.pid.1", "given_name"]
                    },
                    {
                        "path": ["eu.europa.ec.eudi.pid.1", "family_name"]
                    },
                    {
                        "path": ["eu.europa.ec.eudi.pid.1", "age_over_18"]
                    }
                ],
                "trusted_authorities": [
                    {
                        "type": "etsi_tl",
                        "values": [
                            {
                                "trustListId": "eudi-pid-trust-list"
                            }
                        ]
                    }
                ]
            },
            {
                "id": "employee-badge",
                "format": "dc+sd-jwt",
                "meta": {
                    "vct_values": ["EmployeeBadge"]
                },
                "claims": [
                    {
                        "path": ["employee_id"]
                    }
                ]
            }
        ]
    }
}
```

This query requests:

1. A PID (mDoc format) with name and age verification
2. An employee badge (SD-JWT format) with employee ID

Both credentials must be present to satisfy the request.

## Best Practices

1. **Request only necessary claims** — Minimize data collection to protect user privacy
2. **Use trust lists** — Always configure `trusted_authorities` for production deployments
3. **Use descriptive IDs** — Choose credential query IDs that indicate their purpose
4. **Test with real wallets** — Verify that your DCQL queries work with target wallet implementations
5. **Document claim requirements** — Keep a mapping of business requirements to DCQL claims

## Related Documentation

- [Presentation Configuration](configure-verification.md) — Configuring presentation requests
- [Trust Lists](../trust/trust-lists.md) — Trust list management
- [OpenID4VP Specification](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html) — DCQL specification
