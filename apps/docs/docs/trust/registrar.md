---
title: Registrar
---

# Registrar

Depending on the EUDI Wallet and its test or production ecosystem, one or both of these certificate types may be required:

- **Access Certificate** — Grants access to the EUDI Wallet
- **Registration Certificate** — Authorizes data requests from the EUDI Wallet

You can still use EUDIPLO without these certificates, but it may result in warnings when making requests to the EUDI Wallet.

## Prerequisites

:::warning[Role Required]
To see the **Registrar** menu in the client, your tenant must have the `registrar:manage` role assigned. When creating a tenant, make sure to select this role (or select "All roles" for a full setup).
:::

## Step 1: Configure Registrar Credentials

The integrated registrar connection currently supports the German registrar. Each tenant can configure its own German registrar connection with OIDC credentials and use different credentials for each tenant. For other wallet ecosystems, obtain the required key and certificate material from the ecosystem operator and import it into EUDIPLO; do not expect the integrated enrollment API to work with those registrars.

### Via the Web UI

1. Navigate to **Registrar** in the sidebar
2. Select a preset (e.g., "German Sandbox") or manually enter the registrar details:
    - **Registrar URL**: The base URL of the registrar API
    - **OIDC URL**: The OpenID Connect realm URL for authentication
    - **Client ID**: The OIDC client ID
    - **Client Secret**: Optional OIDC client secret
    - **Username**: Your registrar account username
    - **Password**: Your registrar account password
3. Click **Save Configuration**

:::info[Credential Validation]
When you save the configuration, EUDIPLO validates your credentials by attempting to authenticate with the registrar's OIDC endpoint. If authentication fails, you'll receive an error message and the configuration will not be saved.
:::

### Via Configuration File

You can also configure the registrar by placing a `registrar.json` file in the tenant's configuration folder:

```json title="config/{tenant-id}/registrar.json"
{
    "registrarUrl": "https://sandbox.eudi-wallet.org/api",
    "oidcUrl": "https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar",
    "clientId": "swagger",
    "username": "your-username",
    "password": "your-password",
    "registrationCertificateDefaults": {
        "privacy_policy": "https://verifier.example/privacy",
        "support_uri": "mailto:support@verifier.example"
    }
}
```

:::note[File Import Behavior]
When importing from a configuration file during startup, credentials are **not** validated (the registrar might not be reachable during initial setup). Make sure your credentials are correct before relying on the configuration.
:::

## Step 2: Create an Access Certificate

Once the registrar is configured, you can create access certificates via the Key Creation Wizard.

### Via the Key Creation Wizard

1. Navigate to **Keys** in the sidebar
2. Click **+ Create Key** to open the wizard
3. Select **Access Certificate** as the key usage
4. Select **Registrar Enrollment** as the access source
5. Enter a name for the key chain
6. Click **Create**

For the integrated German registrar workflow, the wizard will:

- Create a new key chain
- Generate a signing key
- Request an access certificate from the registrar
- Store the certificate in the key chain

### Import an Existing German Registrar Certificate

If the German registrar has already issued the access key and certificate, you can use the key wizard's import option instead. Select **Access Certificate**, choose the import source, and provide the key and certificate material. Configuring the registrar connection is not required for this path.

### Via the API

```bash
curl -X POST "https://your-eudiplo-instance/registrar/access-certificate" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"keyChainId": "your-key-chain-id"}'
```

The response includes:

- `id`: The registrar's certificate ID
- `keyChainId`: The local EUDIPLO key chain ID
- `crt`: The certificate content

## Next Steps

After obtaining access certificates, configure registration certificates for presentation requests. See [Registration Certificates](registration-certificates.md) for details.

## Related Topics

- [Registration Certificates](registration-certificates.md) — Authorization for credential requests
- [Key Chains](keys-and-certificates.md) — Managing certificates and keys
- [Certificates](keys-and-certificates.md#certificates) — Certificate types and lifecycle

## Schema Metadata (TS11)

Schema Metadata is a **registrar-managed artifact** that describes an attestation schema (version, supported formats, trust authorities, and rulebook references).

It is intentionally managed separately from Credential Configuration so one schema metadata entry can be reused by multiple credential configurations.

:::warning[Unstable Feature]
This feature is based on the TS11 specification, which is still in **draft status**. The schema metadata structure, API endpoints, and UI may change as the specification evolves. Please report feedback and issues to help shape the final specification.
:::

### Why It Is Separate

- **Single source of truth**: schema metadata is versioned and managed centrally.
- **Reusability**: multiple credential configurations can reference the same schema metadata.
- **Consistency**: avoids duplicated metadata drifting across credential configs.

### Why It Matters

By publishing schema metadata, **relying parties (wallets, verifiers) will use it as a root of trust** to consume your attestations. The schema metadata establishes:

- **Schema definitions**: what claims are included and their format
- **Supported formats**: which credential formats (e.g., SD-JWT, mDoc) are supported
- **Trust authorities**: which entities are authorized to issue attestations under this schema
- **Rulebook references**: business rules and validation logic for claim processing

Publishing accurate and well-maintained schema metadata ensures relying parties can correctly validate and interpret your issued credentials.

### Web Client Flow

1. Create or update your credential configuration in **Issuance → Credential Configs**.
2. Go to **Schema Metadata** in the sidebar.
3. Click **Create**.
4. Fill in:
    - `version` (semantic version, e.g. `1.0.0`)
    - `rulebookURI`
    - `attestationLoS`
    - `bindingType`
    - Select one or more **credential configs** in **Schema URIs**
    - Select one or more **trust lists** in **Trusted Authorities**
5. Submit and review the created entry.

If you start creation from a linked credential configuration, EUDIPLO can associate the created schema metadata with that credential configuration using the registrar-assigned ID.

#### Current Import Behavior

- In the UI, Schema URIs and Trusted Authorities are selected from existing entities.
- Manual entry of schema format/URI and trust list URLs is not required in the current flow.
- On submit, EUDIPLO sends references (`credentialConfigId`, `trustListId`) and resolves details server-side.
- The backend uploads schema assets to the registrar, resolves trust list verification data, and computes integrity values during signing.
- The backend downloads the `rulebookURI` (and any schema URIs given by URL) before uploading them. These downloads follow the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS only and no private or loopback targets by default, at most 5 MB each, and every redirect is checked.

### Versioning

- Versions follow **semantic versioning**.
- The Schema Metadata list groups entries by ID and shows all versions.
- The details page supports switching between versions.

### Usage in Presentation Configurations

The schema metadata URL can also be used to configure presentation configurations, enabling wallets and verifiers to reference the same schema metadata for consistent validation rules and claim definitions.

### Usage in Issuance Registration Certificate Generation

Schema metadata entries can also be selected in issuance configuration for registration certificate generation (`registrationCertificate.mode = "generate"`).

In this mode, EUDIPLO derives provided attestations from the selected schema metadata entries and uses them when generating the registration certificate that can be published in issuer metadata (`issuer_info`).

See [Issuance Configuration](../issuance/issuance-configuration.md#registration-certificate-in-issuer-metadata) for configuration details and generation timing behavior.

### Regional Availability

:::info[German Registrar Only]
This feature is currently only available for companies participating with the **German registrar**. Support for additional registrars may be added in future releases.
:::

### Notes for Integrators

Schema Metadata helps with interoperability, but is usually not sufficient alone for full issuance integration. Issuer-specific business rules, claim sourcing, and operational settings still need to be configured in issuance-related components.

### Related Documentation

- [Credential Configuration](../issuance/credential-configuration.md) — Credential structure and field definitions
- [Issuance Configuration](../issuance/issuance-configuration.md) — Registration certificate generation with schema metadata
