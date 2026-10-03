---
title: Tenants and Access
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'API Authentication > Protected Endpoints' roles table -> reference/roles.md (generated from role.enum.ts)
-->

## Tenant-Based Architecture

EUDIPLO uses a **tenant-based architecture** that enables you to manage configurations and data for multiple clients or environments within a single deployment. This model is designed for **multi-tenancy**: a single EUDIPLO instance can serve multiple **organizations** (e.g., relying parties, issuers, verifiers) or **environments** (e.g., staging, testing, production) while keeping their data and configurations separate.

You do not need to deploy separate applications for each tenant; instead, all tenants are centrally managed through one deployment.

### Tenant Isolation

Each tenant is logically isolated. Isolation is currently implemented via a `tenantId` column in all database entities, with the following guarantees:

- **Separate configurations**: Tenant-specific settings stored in the database
- **Isolated database records**: All queries scoped by `tenantId`
- **Independent key management**: Cryptographic keys are bound to a tenant context
- **Dedicated session management**: Sessions are created and validated per tenant
- **Individual credential configurations**: Issuance and presentation templates can differ per tenant

> For now, separation is **row-based** via `tenantId`. Future improvements may include **per-tenant databases** or **row-level security (RLS)** enforcement for stronger isolation.

All API calls are tenant-scoped. Access control and endpoint protection are covered in the [Authentication](#api-authentication) documentation.

### Tenant Lifecycle

A tenant goes through several stages:

- **Provisioning (Create Tenant):** A tenant is initialized on first use. Default configurations (keys, session settings) are created when calling the `/client` endpoint.
- **Enable:** The tenant becomes active; sessions, keys, and credential templates can be used.
- **Suspend:** A tenant can be disabled (e.g., revoking OIDC client access). Data remains in place but is inaccessible.
- **Re-Enable:** Suspended tenants can be reactivated without data loss.
- **Delete:** A full removal workflow, including key destruction and data wiping.

### Tenant Management

When a protected endpoint is called, EUDIPLO enforces tenant isolation and role-based access control by extracting the tenant ID and user roles from the provided JWT access token. Each endpoint requires specific roles; see the [Protected Endpoints](#protected-endpoints) section in the [Authentication](#api-authentication) documentation for details.

#### Client Management via Web Client

- Clients can be either managed by EUDIPLO by storing the client secrets (securely hashed with bcrypt) in the database or by using an external OIDC provider like Keycloak.
- The web client authenticates against the OIDC provider and interacts with EUDIPLO using the provided access token.

:::note[Client ID format]
Client IDs must be non-empty and may only contain letters, numbers, and the characters `.`, `_`, `:`, and `-`. Whitespace and other special characters are rejected.
:::

From the UI you can:

- Create and delete tenants
- Manage the tenants' clients
- Manage the issuance and presentation configs of the tenants

:::note[Client secrets are hashed]
Client secrets are securely hashed before storage and cannot be retrieved later. When creating a new tenant or client, save the displayed secret immediately—it won't be shown again. If lost, use the **Rotate Secret** button to generate a new one.
:::

> Even with tenant management privileges, users will **only see tenant-scoped data**. EUDIPLO enforces tenant context based on the access token.

#### Client Management via the API

- `/tenant` endpoint allows programmatic management of tenants
- `/client` endpoint allows programmatic management of clients. Based on the access token the tenant context is extracted to perform actions on the specific tenant's clients

#### Authentication Methods

Instead of client secrets, you may use any authentication method supported by your OIDC provider. EUDIPLO only validates the **access token**; it does not care how authentication was performed. When using EUDIPLO as the OIDC provider, only clientID + clientSecret is supported for now.

### Security Considerations

- **Access control:** All API calls are validated against tenant context and roles embedded in the access token

### Related Topics

- [Authentication](#api-authentication) — OAuth2 and role-based access control
- [KMS Configuration](kms.md) — Key management per tenant
- [Database](database.md) — Data isolation and storage

## API Authentication

EUDIPLO uses OAuth 2.0 Client Credentials flow for API authentication, designed for service-to-service communication without user interaction.

### Authentication Architecture

#### Design Principles

- **Service-to-Service**: No user interaction required
- **Tenant Isolation**: JWTs are used to isolate tenant data
- **Pluggable Identity**: Support for both built-in and external OIDC providers
- **Stateless**: JWT tokens enable horizontal scaling

#### Security Model

- All management endpoints require authentication
- Tenant data is isolated using JWT subject claims
- Tokens are signed and validated for integrity
- Support for token expiration and rotation
- Endpoints are role based protected

**Related Architecture:** For multi-tenant configuration and session management, see [Tenants](tenants-and-access.md).

### OAuth2 Client Credentials Authentication

This API exclusively uses the OAuth2 client credentials flow, which is designed for service-to-service authentication where no user interaction is required.

#### Built-in OAuth2 Server (Recommended for Getting Started)

EUDIPLO includes a built-in OAuth2 server for simple deployments:

1. **Swagger UI Authentication:**
    - Navigate to the Swagger UI at `/api`
    - Click the "Authorize" button
    - Select "oauth2"
    - Enter client ID and secret (configured via environment variables)
    - Click "Authorize"

2. **Programmatic Access:**

    **Option 1: Credentials in Authorization Header (OAuth2 Standard):**

    ```bash
    curl -X POST http://localhost:3000/api/oauth2/token \
      -H "Content-Type: application/json" \
      -H "Authorization: Basic $(echo -n 'client_id:client_secret' | base64)" \
      -d '{
        "grant_type": "client_credentials"
      }'
    ```

    **Option 2: Credentials in Request Body:**

    ```bash
    curl -X POST http://localhost:3000/api/oauth2/token \
      -H "Content-Type: application/json" \
      -d '{
        "grant_type": "client_credentials",
        "client_id": "your-client-id",
        "client_secret": "your-client-secret"
      }'
    ```

#### External OIDC Provider

For enterprise deployments with existing identity infrastructure, EUDIPLO can integrate with external OIDC providers like Keycloak, Auth0, or Azure AD.

**Configuration:**

```env
OIDC=https://your-keycloak.example.com/realms/your-realm
OIDC_CLIENT_ID=your-keycloak-admin-client
OIDC_CLIENT_SECRET=your-keycloak-admin-client-secret
PUBLIC_URL=https://your-api.example.com

# Optional bootstrap root client in OIDC mode
# If both are set, EUDIPLO creates/updates this Keycloak client on startup
AUTH_CLIENT_ID=root
AUTH_CLIENT_SECRET=root-secret
```

**Authentication Flow:**

1. Use your OIDC provider's token endpoint with client credentials flow
2. Include the access token in API requests: `Authorization: Bearer <token>`
3. If `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are set, use those credentials against Keycloak to get an initial root/admin token

### Configuration

#### External OIDC Provider

```bash
# Enable external OIDC
OIDC=https://your-keycloak.example.com/realms/your-realm
OIDC_INTERNAL_ISSUER_URL=https://your-keycloak.example.com/realms/your-realm
OIDC_CLIENT_ID=your-keycloak-admin-client
OIDC_CLIENT_SECRET=your-keycloak-admin-client-secret
PUBLIC_URL=https://your-api.example.com

# Optional bootstrap root client (created in Keycloak by EUDIPLO startup)
AUTH_CLIENT_ID=root
AUTH_CLIENT_SECRET=root-secret
```

In external OIDC mode:

- EUDIPLO does not issue tokens from `/api/oauth2/token`
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are used by EUDIPLO to manage roles/clients in Keycloak
- `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` are optional; when both are set, EUDIPLO bootstraps a Keycloak client intended for initial/root login

:::note[Keycloak client_credentials behavior]
When using Keycloak with the current `@keycloak/keycloak-admin-client` startup flow, enable **Use refresh tokens for client credentials grant** on the client configured by `OIDC_CLIENT_ID`. Otherwise, startup may fail with `Cannot read properties of undefined (reading 'split')` during admin client authentication.
:::

#### Integrated OAuth2 Server

```bash
# Leave OIDC undefined for integrated OAuth2 server
# All three values below are REQUIRED
PUBLIC_URL=https://your-api.example.com
MASTER_SECRET=your-secret-key-here-minimum-32-characters
AUTH_CLIENT_ID=your-client-id
AUTH_CLIENT_SECRET=your-client-secret
```

:::tip[Security: Secrets are hashed]
Client secrets are securely hashed (bcrypt) before storage. They cannot be retrieved after creation. Use the **Rotate Secret** API endpoint or Web Client button to generate a new secret if needed.
:::

### Protected Endpoints

All administrative endpoints require OAuth2 authentication and are protected by a role based access control approach.

The following roles are available:

```typescript
enum Role {
    // Tenant management
    TENANT_MANAGE = "tenant:manage",
    TENANT_READ = "tenant:read",
    TENANT_ADMIN = "tenant:admin",

    // Issuance operations
    ISSUANCE_OFFER = "issuance:offer",
    ISSUANCE_CONFIG = "issuance:config",

    // Presentation operations
    PRESENTATION_REQUEST = "presentation:request",
    PRESENTATION_CONFIG = "presentation:config",

    // Key management
    KEY_MANAGE = "key:manage",
    KEY_READ = "key:read",

    // Registrar integration
    REGISTRAR_MANAGE = "registrar:manage",

    // Metrics access
    METRICS_READ = "metrics:read",
}
```

Each client can have multiple roles assigned, but each client can only be assigned to one tenant at maximum. The client with the tenant manage must not be assigned to any tenant since it is managing the service in general.

#### Resource-Level Access Control

In addition to role-based access control, clients can be restricted to specific presentation or issuance configurations. This allows for fine-grained control over which configurations a service account can use.

**Configuration Fields:**

- `allowedPresentationConfigs`: Array of presentation config IDs. If empty or null, the client can use any presentation config.
- `allowedIssuanceConfigs`: Array of issuance config IDs. If empty or null, the client can use any issuance config.

#### Example: Creating a Restricted Client

```bash
curl -X POST http://localhost:3000/clients \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "partner-service",
    "roles": ["presentation:request", "issuance:offer"],
    "allowedPresentationConfigs": ["age-verification", "identity-check"],
    "allowedIssuanceConfigs": ["partner-credential"]
  }'
```

This client can only:

- Create presentation requests for `age-verification` and `identity-check` configs
- Create issuance offers for `partner-credential` config

If the client attempts to use a config not in their allowed list, a `403 Forbidden` error is returned.

### Related Topics

- [Tenants](tenants-and-access.md) — Multi-tenant architecture
- [Keycloak Integration](keycloak.md) — Setting up external OIDC
