---
title: Transaction Data
---

Transaction data allows you to include additional context in the OID4VP authorization request. This is useful for scenarios where the verifier needs to convey transaction-specific information that the wallet can display to the user for informed consent.

## Overview

When requesting credentials from a user's wallet, you may need to provide context about why the credentials are being requested. Transaction data enables this by:

- **Providing transaction context** to the wallet and user
- **Enabling informed consent** by showing what the credentials will be used for
- **Supporting various use cases** like payments, contract signing, or access control

## Configuration

Transaction data is defined as an array of objects. It can be configured at two levels:

1. **Presentation Configuration** — Default transaction data for all requests using this configuration
2. **Request Time** — Override or provide transaction data when creating a specific presentation request

### In Presentation Configuration

Add transaction data to your presentation configuration:

```json
{
  "id": "payment-verification",
  "description": "Payment verification with transaction details",
  "dcql_query": {
    "credentials": [
      {
        "id": "pid",
        "format": "dc+sd-jwt",
        "meta": {
          "vct_values": ["urn:eudi:pid:1"]
        }
      }
    ]
  },
  "transaction_data": [
    {
      "type": "payment",
      "credential_ids": ["pid"],
      "amount": 100,
      "currency": "EUR",
      "merchant": "Example Store"
    }
  ]
}
```

### At Request Time

When creating a presentation request via the `/verifier/offer` endpoint, you can provide or override transaction data:

```json
{
  "requestId": "payment-verification",
  "response_type": "uri",
  "transaction_data": [
    {
      "type": "payment",
      "credential_ids": ["pid"],
      "amount": 250,
      "currency": "EUR",
      "merchant": "Different Store"
    }
  ]
}
```

:::note Override Behavior
When `transaction_data` is provided in the request, it completely replaces any transaction data defined in the presentation configuration. The two are not merged.

The same request-time override model also applies to `webhook` and `redirectUri`. See [Presentation Configuration](configure-verification.md#configuration-fields).
:::

## Fields

Each transaction data object must include the following required fields:

| Field            | Type     | Required | Description                                                                                        |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `type`           | string   | Yes      | Identifies the type of transaction (e.g., `"payment"`, `"age_verification"`, `"contract_signing"`) |
| `credential_ids` | string[] | Yes      | Array of credential IDs from the DCQL query that this transaction data relates to                  |

Additional properties can be added based on the transaction type to provide context-specific information.

## Use Cases

### Payment Authorization

Include payment details so users can verify the transaction before sharing credentials:

```json
{
  "type": "payment",
  "credential_ids": ["pid"],
  "amount": 49.99,
  "currency": "EUR",
  "merchant": "Online Shop GmbH",
  "reference": "ORDER-12345"
}
```

### Age Verification

Specify the minimum age requirement for age-restricted services:

```json
{
  "type": "age_verification",
  "credential_ids": ["pid"],
  "minimum_age": 18,
  "service": "Alcohol Purchase"
}
```

### Contract Signing

Reference document details for contract or agreement signing:

```json
{
  "type": "contract_signing",
  "credential_ids": ["pid"],
  "document_hash": "sha256:abc123...",
  "document_title": "Service Agreement",
  "signing_date": "2026-01-25"
}
```

### Access Control

Include resource or permission information for access control scenarios:

```json
{
  "type": "access_control",
  "credential_ids": ["employee_badge"],
  "resource": "Building A - Floor 3",
  "access_level": "visitor",
  "valid_until": "2026-01-25T18:00:00Z"
}
```

## Best Practices

1. **Be specific with types** — Use clear, descriptive type values that indicate the purpose
2. **Include relevant context** — Add properties that help users understand what they're consenting to
3. **Match credential_ids** — Ensure the `credential_ids` reference valid credentials from your DCQL query
4. **Keep it minimal** — Only include information necessary for informed consent

## Related Documentation

- [Presentation Configuration](configure-verification.md) — Configuring transaction data defaults
- [Presentation Requests](requests.md) — Overriding transaction data at request time
- [DCQL](dcql.md) — Referencing credential IDs in transaction data
