---
title: Attribute Providers
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'API Endpoints', 'Request and Response' (request format, identity object, response format) -> reference/attribute-provider-api.md
  - 'Request and Response > Response Format > Deferred Issuance' -> issuance/deferred-issuance.md
  - claim-source duplicates -> issuance/claims.md
-->

Attribute Providers are external HTTPS endpoints that EUDIPLO calls during credential issuance to dynamically fetch claim values. They provide a centralized, reusable way to configure claim sources at the tenant level.

## Overview

Instead of repeating claim source settings on each credential configuration, you can:

1. Create an Attribute Provider with the endpoint URL and authentication settings
2. Reference the Attribute Provider by ID in one or more credential configurations

This approach offers several benefits:

- **Reusability** – One Attribute Provider can serve multiple credential configurations
- **Centralized management** – Update the URL or authentication in one place
- **Separation of concerns** – Keep credential structure separate from data source configuration
- **Security** – API keys and authentication details are stored once and referenced by ID

## API Endpoints

Attribute Providers are managed via the `/issuer/attribute-providers` endpoint:

| Method   | Endpoint                           | Description                       |
| -------- | ---------------------------------- | --------------------------------- |
| `GET`    | `/issuer/attribute-providers`      | List all Attribute Providers      |
| `GET`    | `/issuer/attribute-providers/{id}` | Get a specific Attribute Provider |
| `POST`   | `/issuer/attribute-providers`      | Create a new Attribute Provider   |
| `PATCH`  | `/issuer/attribute-providers/{id}` | Update an Attribute Provider      |
| `DELETE` | `/issuer/attribute-providers/{id}` | Delete an Attribute Provider      |

## Configuration

### Required Fields

| Field  | Type   | Description                                  |
| ------ | ------ | -------------------------------------------- |
| `id`   | string | Unique identifier for the Attribute Provider |
| `name` | string | Human-readable name                          |
| `url`  | string | HTTPS endpoint URL that returns claims       |

### Optional Fields

| Field         | Type   | Description                              |
| ------------- | ------ | ---------------------------------------- |
| `description` | string | Human-readable description               |
| `auth`        | object | Authentication configuration (see below) |

### Authentication Options

#### No Authentication

```json
{
    "auth": {
        "type": "none"
    }
}
```

#### API Key Authentication

Sends an API key in a request header:

```json
{
    "auth": {
        "type": "apiKey",
        "config": {
            "headerName": "x-api-key",
            "value": "your-secret-api-key"
        }
    }
}
```

## Example

### Creating an Attribute Provider

```bash
POST /issuer/attribute-providers
Content-Type: application/json
Authorization: Bearer <your-token>

{
    "id": "employee-claims-api",
    "name": "Employee Claims API",
    "description": "Fetches employee data from HR system",
    "url": "https://hr-api.example.com/claims",
    "auth": {
        "type": "apiKey",
        "config": {
            "headerName": "Authorization",
            "value": "Bearer hr-api-secret-token"
        }
    }
}
```

### Referencing in Credential Configuration

Once created, reference the Attribute Provider in your credential configuration:

```json
{
    "id": "employee-badge",
    "description": "Employee Badge Credential",
    "config": {
        "format": "dc+sd-jwt",
        "display": [
            {
                "name": "Employee Badge",
                "locale": "en-US"
            }
        ]
    },
    "attributeProviderId": "employee-claims-api"
}
```

## Request and Response

When EUDIPLO calls your Attribute Provider endpoint, it sends a POST request with issuance session context.

### Request Format

```json
{
    "session": "a6318799-dff4-4b60-9d1d-58703611bd23",
    "credential_configuration_id": "employee-badge",
    "identity": {
        "iss": "https://idp.example.com/realms/myrealm",
        "sub": "user-uuid-from-idp",
        "token_claims": {
            "email": "user@example.com",
            "preferred_username": "jdoe",
            "given_name": "John",
            "family_name": "Doe"
        }
    }
}
```

| Field                         | Type   | Description                                                                               |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `session`                     | string | The session ID identifying the issuance request                                           |
| `credential_configuration_id` | string | The ID of the credential configuration being requested                                    |
| `identity`                    | object | Identity context from the authorization flow (see below)                                  |
| `credentials`                 | array  | Verified presented credentials (only for OID4VP authorization servers, omitted otherwise) |

### Identity Object

The `identity` object contains information about the authenticated user. Its contents depend on the authorization flow used:

| Field          | Type   | Description                                                              |
| -------------- | ------ | ------------------------------------------------------------------------ |
| `iss`          | string | The issuer URL of the authorization server                               |
| `sub`          | string | The subject identifier (user ID) from the authorization server           |
| `token_claims` | object | All available claims from the access token (and ID token for Chained AS) |

#### Identity Sources by Flow

| Flow                  | Identity Source                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| **External AS**       | Claims from the external authorization server's access token                                               |
| **Chained AS**        | Claims from the upstream OIDC provider (merged ID token + access token)                                    |
| **OID4VP AS**         | Access token claims of the tenant's OID4VP authorization server. The presented claims are in `credentials` |
| **Pre-authenticated** | Not available (no user authentication)                                                                     |
| **IAE**               | Identity from the IAE interaction (presentation or web redirect)                                           |

### Presentation-Based Authorization

When the wallet authorizes through an [OID4VP authorization server](authorization-servers.md#oid4vp-authorization-server), the Attribute Provider receives the verified claims of the presented credentials in the `credentials` array. There is one entry per credential ID of the presentation's DCQL query. `values` is an array with the disclosed claims of each presented credential, because a query with `multiple: true` can match more than one credential:

```json
{
    "session": "a6318799-dff4-4b60-9d1d-58703611bd23",
    "credential_configuration_id": "citizen-credential",
    "identity": {
        "iss": "https://issuer.example.com/issuers/my-tenant/authorization-servers/pid-auth",
        "sub": "wallet-client-id",
        "token_claims": {
            "issuer_state": "a6318799-dff4-4b60-9d1d-58703611bd23"
        }
    },
    "credentials": [
        {
            "id": "pid",
            "values": [
                {
                    "given_name": "John",
                    "family_name": "Doe",
                    "birthdate": "1990-01-15"
                }
            ]
        }
    ]
}
```

Your Attribute Provider can use the presented credentials to derive or transform claims for the new credential being issued.

:::note
The `openid4vp_presentation` action of [Interactive Authorization (IAE)](interactive-authorization.md) does not verify the presented credentials, so they are not forwarded in `credentials`.
:::

### Response Format

#### Immediate Issuance

Return the claims keyed by the credential configuration ID:

```json
{
    "employee-badge": {
        "employee_id": "EMP-12345",
        "department": "Engineering",
        "hire_date": "2023-01-15"
    }
}
```

#### Deferred Issuance

To defer credential issuance (e.g., for background verification), return:

```json
{
    "deferred": true,
    "interval": 5
}
```

See the [Architecture documentation](../reference/attribute-provider-api.md) for details on deferred issuance handling.

## Offer-time Override

You can override the Attribute Provider at offer creation time. For complete examples and usage patterns, see the [Claims](claims.md) page, which explains the priority system in detail.

### Reference a Different Attribute Provider

```json
{
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["employee-badge"],
    "credentialClaims": {
        "employee-badge": {
            "type": "attributeProvider",
            "attributeProviderId": "staging-claims-api"
        }
    }
}
```

### Provide an Inline Webhook

```json
{
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["employee-badge"],
    "credentialClaims": {
        "employee-badge": {
            "type": "webhook",
            "webhook": {
                "url": "https://test-api.example.com/claims",
                "auth": {
                    "type": "none"
                }
            }
        }
    }
}
```

### Provide Inline Claims

```json
{
    "flow": "pre_authorized_code",
    "credentialConfigurationIds": ["employee-badge"],
    "credentialClaims": {
        "employee-badge": {
            "type": "inline",
            "claims": {
                "employee_id": "EMP-99999",
                "department": "Test Department"
            }
        }
    }
}
```

## Best Practices

1. **Use descriptive IDs** – Choose IDs that indicate the purpose (e.g., `hr-employee-data`, `kyc-verification-api`)

2. **Secure your endpoints** – Always use HTTPS and configure authentication for production Attribute Providers

3. **Handle errors gracefully** – Your endpoint should return appropriate HTTP status codes:
    - `200` – Success with claims
    - `404` – User not found (will result in issuance failure)
    - `5xx` – Server error (EUDIPLO will retry or fail the issuance)

4. **Log session IDs** – Include the `session` field in your logs for debugging and correlation

5. **Test with inline webhooks** – Use offer-time webhook overrides during development and testing

## Related Documentation

- [Claims](claims.md) — Claims priority and resolution
- [Credential Offers](credential-offers.md) — Offer-level overrides
- [Architecture: Webhooks](../reference/webhooks.md) — Webhook integration patterns
