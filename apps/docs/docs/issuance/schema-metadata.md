---
title: Schema Metadata (TS11)
---

Schema Metadata is a **registrar-managed artifact** that describes an attestation schema (version, supported formats, trust authorities, and rulebook references).

It is intentionally managed separately from Credential Configuration so one schema metadata entry can be reused by multiple credential configurations.

:::warning[Unstable Feature]
This feature is based on the TS11 specification, which is still in **draft status**. The schema metadata structure, API endpoints, and UI may change as the specification evolves. Please report feedback and issues to help shape the final specification.
:::

## Why It Is Separate

- **Single source of truth**: schema metadata is versioned and managed centrally.
- **Reusability**: multiple credential configurations can reference the same schema metadata.
- **Consistency**: avoids duplicated metadata drifting across credential configs.

## Why It Matters

By publishing schema metadata, **relying parties (wallets, verifiers) will use it as a root of trust** to consume your attestations. The schema metadata establishes:

- **Schema definitions**: what claims are included and their format
- **Supported formats**: which credential formats (e.g., SD-JWT, mDoc) are supported
- **Trust authorities**: which entities are authorized to issue attestations under this schema
- **Rulebook references**: business rules and validation logic for claim processing

Publishing accurate and well-maintained schema metadata ensures relying parties can correctly validate and interpret your issued credentials.

## Web Client Flow

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

### Current Import Behavior

- In the UI, Schema URIs and Trusted Authorities are selected from existing entities.
- Manual entry of schema format/URI and trust list URLs is not required in the current flow.
- On submit, EUDIPLO sends references (`credentialConfigId`, `trustListId`) and resolves details server-side.
- The backend uploads schema assets to the registrar, resolves trust list verification data, and computes integrity values during signing.
- The backend downloads the `rulebookURI` (and any schema URIs given by URL) before uploading them. These downloads follow the [outbound URL policy](../architecture/security.md#https-and-tls): HTTPS only and no private or loopback targets by default, at most 5 MB each, and every redirect is checked.

## Versioning

- Versions follow **semantic versioning**.
- The Schema Metadata list groups entries by ID and shows all versions.
- The details page supports switching between versions.

## Usage in Presentation Configurations

The schema metadata URL can also be used to configure presentation configurations, enabling wallets and verifiers to reference the same schema metadata for consistent validation rules and claim definitions.

## Usage in Issuance Registration Certificate Generation

Schema metadata entries can also be selected in issuance configuration for registration certificate generation (`registrationCertificate.mode = "generate"`).

In this mode, EUDIPLO derives provided attestations from the selected schema metadata entries and uses them when generating the registration certificate that can be published in issuer metadata (`issuer_info`).

See [Issuance Configuration](issuance-configuration.md#registration-certificate-in-issuer-metadata) for configuration details and generation timing behavior.

## Regional Availability

:::info[German Registrar Only]
This feature is currently only available for companies participating with the **German registrar**. Support for additional registrars may be added in future releases.
:::

## Notes for Integrators

Schema Metadata helps with interoperability, but is usually not sufficient alone for full issuance integration. Issuer-specific business rules, claim sourcing, and operational settings still need to be configured in issuance-related components.

## Related Documentation

- [Credential Configuration](credential-configuration.md) — Credential structure and field definitions
- [Issuance Configuration](issuance-configuration.md) — Registration certificate generation with schema metadata
