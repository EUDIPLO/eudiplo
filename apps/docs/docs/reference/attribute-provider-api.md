---
title: Attribute Providers
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Deferred Issuance' -> issuance/deferred-issuance.md
  - 'Usage' (how-to) -> issuance/attribute-provider.md
  - merge the contract parts of issuance/attribute-provider.md here
-->

# Attribute Providers

**Attribute Providers** are tenant-level resources that define how EUDIPLO fetches claims from your backend services during credential issuance.

:::info[Attribute Providers vs Webhooks]

**Attribute Providers** are designed to **fetch data IN** — retrieving claims from your backend to include in credentials.

**Webhooks** are designed to **send data OUT** — notifying your backend when events occur (e.g., presentation completed, credential accepted by the wallet).

For sending notifications, see [Webhooks](./webhooks.md).

:::

## Overview

When issuing credentials, EUDIPLO needs to populate the credential with claims (attributes). These claims can come from several sources:

1. **Static claims** — Defined in the credential configuration or passed at offer time
2. **Attribute Providers** — Fetched dynamically from your backend via HTTP

Attribute Providers are the recommended approach for production deployments because they:

- **Centralize configuration** — Define once, reuse across multiple credential configurations
- **Improve security** — Sensitive data is fetched just-in-time, not stored in offers
- **Enable dynamic claims** — Claims can be computed or retrieved from external systems
- **Support deferred issuance** — Your backend can signal that processing is needed

## How It Works

```mermaid
sequenceDiagram
    autonumber
    actor Wallet as EUDI Wallet
    participant EUDIPLO as Middleware
    participant AP as Attribute Provider

    Wallet->>EUDIPLO: Credential Request
    EUDIPLO->>AP: POST (session, credential_configuration_id, identity)
    AP-->>EUDIPLO: { "<credentialConfigId>": { ... } }
    EUDIPLO->>EUDIPLO: Validate claims against fields
    EUDIPLO-->>Wallet: Credential with claims
```

1. The wallet requests a credential from EUDIPLO
2. EUDIPLO calls the configured Attribute Provider with identity context
3. Your backend returns the claims to include in the credential, keyed by credential configuration ID
4. EUDIPLO validates the claims against the credential configuration's `fields`
5. EUDIPLO issues the credential with those claims

## Configuration

An Attribute Provider is a tenant-level resource with:

| Field         | Type   | Description                                                |
| ------------- | ------ | ---------------------------------------------------------- |
| `id`          | string | Unique identifier within the tenant                        |
| `name`        | string | Human-readable name                                        |
| `description` | string | Optional description                                       |
| `url`         | string | Endpoint EUDIPLO calls with `POST` to fetch claims         |
| `auth`        | object | Authentication: `none` or `apiKey` (`headerName`, `value`) |

Attribute Providers are managed via `/api/issuer/attribute-providers`.

### Example

```json
{
    "id": "employee-claims-api",
    "name": "Employee Claims API",
    "url": "https://hr.example.com/api/claims",
    "auth": {
        "type": "apiKey",
        "config": {
            "headerName": "x-api-key",
            "value": "your-api-key"
        }
    }
}
```

### Request and Response

EUDIPLO sends a `POST` request to the provider's `url`:

```json
{
    "session": "sess_abc123",
    "credential_configuration_id": "EmployeeBadge",
    "identity": {
        "iss": "https://auth.example.com",
        "sub": "user-123",
        "token_claims": { "sub": "user-123" }
    }
}
```

`identity` is optional. When present, it carries the issuer (`iss`), subject (`sub`) and claims (`token_claims`) of the access token presented with the credential request; for chained or external authorization servers, these describe the upstream identity.

Your backend returns the claims keyed by the credential configuration ID:

```json
{
    "EmployeeBadge": {
        "given_name": "John",
        "family_name": "Doe",
        "employee_id": "EMP-12345"
    }
}
```

### Claim Validation

Before signing, EUDIPLO validates the final claims against the credential configuration's `fields`. This applies to every claim source: static defaults, inline claims from the offer, Attribute Providers, and claims supplied when completing a deferred transaction. Missing mandatory claims, claims with the wrong type, and claims not defined in `fields` are rejected, and the credential is not issued. Configurations without `fields` entries are not validated.

## Usage

Reference an Attribute Provider in your credential configuration:

```json
{
    "id": "EmployeeBadge",
    "attributeProviderId": "employee-claims-api",
    "vct": "EmployeeBadge",
    "config": {
        "format": "dc+sd-jwt",
        "display": [{ "name": "Employee Badge", "locale": "en-US" }]
    },
    "fields": [
        { "path": ["given_name"], "type": "string", "mandatory": true },
        { "path": ["family_name"], "type": "string", "mandatory": true },
        { "path": ["employee_id"], "type": "string", "mandatory": true }
    ]
}
```

Or override at offer time:

```json
{
    "credentialClaims": {
        "EmployeeBadge": {
            "type": "attributeProvider",
            "attributeProviderId": "employee-claims-api"
        }
    }
}
```

## Deferred Issuance

**Deferred issuance** allows your Attribute Provider to signal that the credential cannot be issued immediately. This is useful when:

- Background verification is required (e.g., KYC, identity proofing)
- An approval workflow must be completed
- External data sources need time to respond
- The credential requires asynchronous processing

### How It Works

When your Attribute Provider returns a **deferred response**, EUDIPLO:

1. Stores the pending request with a `transaction_id`
2. Returns HTTP 202 (Accepted) to the wallet with the `transaction_id`
3. The wallet polls the **deferred credential endpoint** (`POST /issuers/{tenantId}/vci/deferred_credential`) until the credential is ready

```mermaid
sequenceDiagram
    autonumber
    actor Wallet as EUDI Wallet
    participant EUDIPLO as Middleware
    participant AP as Attribute Provider

    Wallet->>EUDIPLO: Credential Request
    EUDIPLO->>AP: POST (session, credential_configuration_id, identity)
    AP-->>EUDIPLO: { "deferred": true, "interval": 5 }
    EUDIPLO-->>Wallet: HTTP 202 + transaction_id

    loop Polling (every interval seconds)
        Wallet->>EUDIPLO: POST /deferred_credential
        alt Credential not ready
            EUDIPLO-->>Wallet: { "error": "issuance_pending", "interval": 5 }
        else Credential ready
            EUDIPLO-->>Wallet: { "credential": "..." }
        end
    end
```

### Deferred Response Format

To trigger deferred issuance, your Attribute Provider should return:

```json
{
    "deferred": true,
    "interval": 5
}
```

| Field      | Type    | Description                                          |
| ---------- | ------- | ---------------------------------------------------- |
| `deferred` | boolean | Set to `true` to defer the credential issuance       |
| `interval` | number  | Recommended polling interval in seconds (default: 5) |

### Completing Deferred Issuance

Once your backend has completed processing, call EUDIPLO's API to provide the claims:

```bash
# Complete the deferred transaction with claims
POST /api/issuer/deferred/{transactionId}/complete
Content-Type: application/json
Authorization: Bearer <your-token>

{
    "claims": {
        "given_name": "John",
        "family_name": "Doe",
        "employee_id": "EMP-12345"
    }
}
```

Or, if the issuance failed:

```bash
# Mark the deferred transaction as failed
POST /api/issuer/deferred/{transactionId}/fail
Content-Type: application/json
Authorization: Bearer <your-token>

{
    "error": "KYC verification failed"
}
```

### Deferred Credential Errors

When the wallet polls the deferred credential endpoint, it may receive:

| Error Code               | HTTP Status | Description                                           |
| ------------------------ | ----------- | ----------------------------------------------------- |
| `issuance_pending`       | 400         | Credential is still being processed. Retry later.     |
| `invalid_transaction_id` | 400         | Transaction not found, expired, or already retrieved. |

The `issuance_pending` error includes an `interval` field indicating when to retry:

```json
{
    "error": "issuance_pending",
    "error_description": "The credential issuance is still pending",
    "interval": 5
}
```

### Transaction Lifecycle

Deferred transactions have the following states:

| Status      | Description                                      |
| ----------- | ------------------------------------------------ |
| `pending`   | Waiting for your backend to complete processing  |
| `ready`     | Credential is ready for wallet retrieval         |
| `retrieved` | Wallet has successfully retrieved the credential |
| `expired`   | Transaction expired (default: 24 hours)          |
| `failed`    | Issuance failed due to an error                  |

:::info[Transaction Expiry]

Deferred transactions expire after 24 hours by default. Expired transactions are automatically cleaned up hourly.

:::

## Detailed Documentation

For complete documentation including:

- API endpoints for managing Attribute Providers
- Request/response formats
- Identity context and token claims
- Integration with Interactive Authorization (IAE)
- Error handling and best practices

See the [Attribute Provider Getting Started Guide](../issuance/attribute-provider.md).
