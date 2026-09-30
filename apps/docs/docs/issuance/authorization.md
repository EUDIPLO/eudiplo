---
title: Authorization Servers
---

Authorization servers define how wallets authenticate before receiving credentials. EUDIPLO supports four types: `external`, `oid4vp`, `chained`, and `built-in`.

## Overview

The `authorizationServers` array in [Issuance Configuration](issuance-configuration.md) manages all available authorization server options for a tenant. Each entry defines a distinct authentication method that can be selected at offer creation time.

**Key Concepts:**

- Define one or more authorization servers in the issuance configuration
- Reference a specific server by `id` when creating an offer
- Each server type has its own configuration requirements and behavior
- Authorization servers can be enabled/disabled without removal

## Authorization Server Types

| Type       | Purpose                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `external` | Uses a remote OAuth/OIDC AS via issuer URL discovery.                                         |
| `oid4vp`   | Creates a tenant-local AS facade at `/issuers/{tenant}/authorization-servers/{id}`.           |
| `chained`  | Creates a tenant-local chained AS facade at `/issuers/{tenant}/chained-as` via upstream OIDC. |
| `built-in` | Uses issuer-local authorization endpoints provided by EUDIPLO.                                |

## Common Fields

These fields apply to all authorization server types:

| Field                   | Type    | Required                | Description                                                                             |
| ----------------------- | ------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `id`                    | string  | Yes                     | Unique identifier used to reference this AS in offer requests (`authorization_server`). |
| `type`                  | string  | Yes                     | One of `external`, `oid4vp`, `chained`, `built-in`.                                     |
| `label`                 | string  | No                      | Optional UI label.                                                                      |
| `enabled`               | boolean | No                      | Enables/disables this entry. Default `true`.                                            |
| `requireDPoP`           | boolean | No (`oid4vp`/`chained`) | Require DPoP proofs on token requests for this AS.                                      |
| `token.lifetimeSeconds` | number  | No (`oid4vp`/`chained`) | Access token lifetime for this AS.                                                      |
| `token.signingKeyId`    | string  | No (`oid4vp`/`chained`) | Key used to sign AS-issued tokens.                                                      |

:::note
The `id` values `built-in` and `chained-as` are reserved and cannot be used for custom authorization servers.
:::

## External Authorization Server

External authorization servers delegate authentication to a remote OAuth 2.0 or OpenID Connect provider.

### Configuration

```json
{
    "type": "external",
    "id": "external-corp-idp",
    "label": "Corporate IdP",
    "enabled": true,
    "issuer": "https://auth.example.com",
    "sessionBinding": {
        "method": "access_token_claim",
        "claim": "issuer_state"
    }
}
```

### Type-Specific Fields

| Field                   | Type   | Required | Description                                           |
| ----------------------- | ------ | -------- | ----------------------------------------------------- |
| `issuer`                | string | Yes      | External AS issuer URL.                               |
| `sessionBinding`        | object | Yes\*    | Session correlation configuration (see below).        |
| `sessionBinding.method` | string | Yes      | Must be `access_token_claim`.                         |
| `sessionBinding.claim`  | string | Yes      | Access-token claim containing the EUDIPLO session ID. |

\*Required for external token-backed issuance.

### Session Binding

External access tokens must be bound to the issuance session created for the credential offer. The configured claim in the access token must contain the EUDIPLO issuance session ID.

**For standard authorization-code flow**, this is the `issuer_state` value from the credential offer. The external authorization server must copy that value into the access token without modification.

**Validation Behavior:**

1. EUDIPLO validates the access token signature and expiration
2. Verifies the issuer matches the configured `issuer` URL
3. Reads the configured claim value
4. Resolves exactly one existing issuance session

**Tokens are rejected when:**

- The configured claim is missing or empty
- The claim value points to an unknown session
- The session belongs to a different tenant or authorization server

:::warning[Important]
EUDIPLO does not create a new issuance session from an external token and does not implicitly use the token `sub` claim for session correlation. The configured claim must explicitly contain the EUDIPLO session ID.
:::

### Usage in Offers

When creating an offer with an external authorization server, reference it by `id`:

```json
{
    "response_type": "uri",
    "flow": "authorization_code",
    "credentialConfigurationIds": ["pid"],
    "authorization_server": "external-corp-idp"
}
```

## OID4VP Authorization Server

OID4VP authorization servers use OpenID for Verifiable Presentations (OID4VP) as the authentication mechanism. The wallet presents existing credentials to prove identity instead of traditional username/password authentication.

### Configuration

```json
{
    "type": "oid4vp",
    "id": "pid-auth",
    "label": "PID Authentication",
    "enabled": true,
    "presentationConfigId": "pid-verification",
    "immediateWalletRedirect": true,
    "requireDPoP": true,
    "token": {
        "lifetimeSeconds": 3600,
        "signingKeyId": "default"
    }
}
```

### Type-Specific Fields

| Field                     | Type    | Required | Description                                     |
| ------------------------- | ------- | -------- | ----------------------------------------------- |
| `presentationConfigId`    | string  | Yes      | Presentation config used for the VP flow.       |
| `immediateWalletRedirect` | boolean | No       | Redirect browser immediately to wallet request. |

### Behavior

When a wallet initiates the authorization flow with an OID4VP authorization server:

1. EUDIPLO exposes a tenant-local AS facade at `/issuers/{tenant}/authorization-servers/{id}`
2. The wallet is redirected to the OID4VP presentation flow using the referenced presentation configuration
3. After successful presentation verification, EUDIPLO issues an access token for credential issuance
4. The claims from the presented credentials are sent to the Attribute Provider in the `credentials` field (see [Presentation-Based Authorization](attribute-provider.md#presentation-based-authorization))

This flow is commonly used for higher-assurance issuance where the user must prove they already hold a trusted credential (such as a PID) before receiving a new credential.

## Chained Authorization Server

Chained authorization servers federate authentication through an upstream OpenID Connect provider while maintaining a tenant-local token endpoint.

### Configuration

```json
{
    "type": "chained",
    "id": "chained-auth",
    "label": "Enterprise SSO",
    "enabled": true,
    "upstream": {
        "issuer": "https://keycloak.example.com/realms/eudiplo",
        "clientId": "eudiplo-chained-as",
        "clientSecret": "your-client-secret",
        "scopes": ["openid", "profile", "email"]
    },
    "requireDPoP": true,
    "token": {
        "lifetimeSeconds": 3600,
        "signingKeyId": "default"
    }
}
```

### Type-Specific Fields

| Field                   | Type   | Required | Description                             |
| ----------------------- | ------ | -------- | --------------------------------------- |
| `upstream.issuer`       | string | Yes      | Upstream OIDC issuer URL.               |
| `upstream.clientId`     | string | Yes      | Client ID at upstream provider.         |
| `upstream.clientSecret` | string | No       | Client secret for confidential clients. |
| `upstream.scopes`       | array  | No       | Scopes requested upstream.              |

### Behavior

When enabled, EUDIPLO:

1. Exposes a tenant-local chained AS at `/{tenant}/chained-as/*`
2. Publishes this issuer in the `authorization_servers` metadata
3. Redirects authentication to the upstream OIDC provider
4. Exchanges the upstream authorization code for tokens
5. Merges claims from the upstream ID token and access token
6. Issues a tenant-local access token for credential issuance

**Identity Context:**

Attribute Providers receive merged claims from both the upstream ID token and access token in the `identity.token_claims` field.

## Built-in Authorization Server

The built-in authorization server uses EUDIPLO's internal authentication system. This is primarily intended for testing and development scenarios.

### Configuration

```json
{
    "type": "built-in",
    "id": "local-dev-auth",
    "label": "Local Development",
    "enabled": true
}
```

### Behavior

Built-in authorization servers use EUDIPLO's internal user authentication. This mode is not recommended for production deployments and is primarily used for:

- Local development and testing
- Demo environments
- Proof-of-concept implementations

For production deployments, use external, OID4VP, or chained authorization servers.

## Selecting Authorization Server for Offers

At offer creation time, set `authorization_server` to an enabled authorization server `id`:

```json
{
    "response_type": "uri",
    "flow": "authorization_code",
    "credentialConfigurationIds": ["pid"],
    "authorization_server": "pid-auth"
}
```

**Selection Rules:**

- The `authorization_server` value must match the `id` of an enabled entry in `authorizationServers`
- If omitted, EUDIPLO uses the first enabled authorization server
- For pre-authorized flows (`flow: "pre_authorized_code"`), the `authorization_server` field is ignored

## Migration from Legacy Configuration

:::warning[Migration Note]
`authServers` and `chainedAs` are legacy fields from version 4.x. New configurations should use `authorizationServers` only.

For migration guidance, see [Migrating from 4.x to 5.0](../migration/4.x-to-5.0.md).
:::

## Related Documentation

- [Issuance Configuration](issuance-configuration.md) — Parent configuration structure
- [Credential Offers](credential-offers.md) — Creating offers with authorization server selection
- [Attribute Providers](attribute-provider.md) — Identity context from authorization flows
