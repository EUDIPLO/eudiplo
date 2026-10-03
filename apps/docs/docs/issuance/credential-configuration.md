---
title: Credential Configuration
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Basic Structure', 'Configuration Fields' (field reference) -> reference/credential-configuration.md (generated from Zod)
  - 'Guided setup in the Web Client' (UI steps) -> cookbooks
  - 'Configuring Fields' claim sources/validation duplicates -> issuance/claims.md
  - 'Notification Webhook Endpoint' -> issuance/notifications.md
  - 'Key Attestation' -> trust/attestation.md
  - 'Single Active Credential > Fingerprints and Revocation Procedure' (internals) -> concepts/issuance.md
-->

Credential configurations define the structure and behavior of individual credentials. Each credential type has its own configuration.

## Guided setup in the Web Client

New credential configurations start with five steps:

1. **Basics** — enter the ID, description, format, and credential type (VCT or mDOC document type).
2. **Claims** — add the fields you will issue, including their types and mDOC namespaces. Defaults follow the field type: enter plain text for strings, `true` or `false` for booleans, numbers for numeric types, and JSON for objects or arrays.
3. **Appearance** — choose the wallet display name, description, and locale. Colors and images are optional.
4. **Settings** — review the lifetime, signing key, holder binding, status management, and proof defaults. Expand a section to change signing, trust, reuse policies, authorization actions, or integrations.
5. **Review** — check the resulting configuration before creating it.

Press Enter in a single-line field or choose **Continue** to advance. Missing fields are highlighted when you continue. **Show all settings** enables direct tab navigation; existing configurations open this way. Both modes use the same form, preserve your changes, and support templates and JSON editing.

## Basic Structure

Each credential configuration is a JSON object that defines how a specific credential type should be issued. The configuration includes metadata, display information, field definitions (`fields[]`), and optional features like key binding and status management.

For a complete configuration example, see the [Complete Configuration Example](#complete-configuration-example) section at the bottom of this page.

:::info
The data object for the import can be found in the [API Documentation](../reference/api.md)
:::

## Configuration Fields

### Required Fields

- `id`: **REQUIRED** - Unique identifier for the credential configuration that will be used to reference this credential in the issuance metadata or in the credential offer.
- `config`: **REQUIRED** - Entry for [credential_configuration_supported](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-credential-issuer-metadata:~:text=the%20logo%20image.-,credential_configurations_supported,-%3A%20REQUIRED.%20Object%20that).
    - `format`: **REQUIRED** - The format of the credential. Supported formats:
        - `dc+sd-jwt` - Selective Disclosure JWT Verifiable Credentials
        - `mso_mdoc` - Mobile Document (ISO 18013-5)
    - `display`: **REQUIRED** - Display configuration for the credential, including name, description, locale, colors, and images.
    - `docType`: **REQUIRED for mso_mdoc** - Document type identifier (e.g., `org.iso.18013.5.1.mDL`).
    - `namespace`: **OPTIONAL for mso_mdoc** - Default namespace for claims (e.g., `org.iso.18013.5.1`). If not provided, derived from docType.

### Optional Fields

- `config.proofTypesSupported`: **OPTIONAL** - Accepted credential proof types: `jwt`, `attestation`, or both. Defaults to both, preferring `attestation`. See [Key Attestation](#key-attestation).
- `config.keyAttestationsRequired`: **OPTIONAL** - Key-attestation requirements advertised for JWT proofs. See [Key Attestation](#key-attestation).
- `description`: **OPTIONAL** - Human-readable description of the credential. Will not be displayed to the end user.
- `vct`: **OPTIONAL** - [VC Type Metadata](https://www.ietf.org/archive/id/draft-ietf-oauth-sd-jwt-vc-09.html#name-sd-jwt-vc-type-metadata) provided via the `/{tenantId}/credentials-metadata/vct/{id}` endpoint. This link will be automatically added to the credential.
- `keyChainId`: **OPTIONAL** - Unique identifier for the key chain used to sign the credential. If not provided, the key chain with `attestation` usage type will be used. See [Signing Key Chain](#signing-key-chain) for details.
- `lifeTime`: **OPTIONAL** - Credential expiration time in seconds. If specified, credentials will include an `exp` claim calculated as `iat + lifeTime`. See [Credential Expiration](#credential-expiration) for details.
- `statusManagement`: **OPTIONAL** - Enable OAuth Token Status Lists for credential revocation. When `true`, credentials include a `status` claim with revocation information. See [Status Management](revocation.md) for details.
- `activeCredentials`: **OPTIONAL** - Enforce one active credential of this configuration per subject. Requires `statusManagement: true`; issuing a replacement revokes the subject's previous credential. See [Single Active Credential](#single-active-credential) for details.
- `keyBinding`: **OPTIONAL** - Enable cryptographic key binding. When `true`, credentials include a `cnf` claim with the holder's public key and require proof of possession. See [Cryptographic Key Binding](#cryptographic-key-binding) for details.
- `fields`: **REQUIRED** - Field definitions (`ClaimFieldDefinition[]`) that describe claim paths, data types, defaults, disclosure behavior, and optional display labels.
- `attributeProviderId`: **OPTIONAL** - Reference to an Attribute Provider that fetches claims dynamically. See [Attribute Providers](attribute-provider.md) for details.
- `webhookEndpointId`: **OPTIONAL** - Reference to a Webhook Endpoint for receiving notifications about the issuance process. See [Notifications](notifications.md) for details.
- `sdJwtTrustFormat`: **OPTIONAL (SD-JWT only)** - Controls trust signaling in issued SD-JWT credentials:
    - `x5c` (default): include the X.509 chain in the JWT header
    - `federation`: use federation issuer identity (`iss`) for trust resolution
- `credentialReusePolicy`: **OPTIONAL** - Publishes a PID/EAA reuse policy in the credential metadata. See [Credential Reuse Policy](#credential-reuse-policy) for details.
- `embeddedDisclosurePolicy`: **OPTIONAL** - Defines the embedded disclosure policy for the credential. See [Embedded Disclosure Policy](#embedded-disclosure-policy) for details.
- `iaeActions`: **OPTIONAL** - Sequence of Interactive Authorization actions required before credential issuance. See [Interactive Authorization Actions](#interactive-authorization-actions) for details.

:::info[Schema Metadata is managed separately]
Schema Metadata is managed in the dedicated Schema Metadata flow, not in the Credential Configuration editor. Use [Schema Metadata](../trust/registrar.md#schema-metadata-ts11) to create and version schema metadata entries.
:::

## Configuring Fields

In the current configuration model, claim content is configured through `fields[]`. Each entry can describe either:

- a leaf claim (for example `path: ["given_name"]`), or
- a container claim (`object`/`array`) with nested `children`.

Nested child paths can be defined in two ways:

- relative to the parent path (recommended), or
- as a full absolute path (also supported).

For arrays, use a wildcard item path. In the form editor, write `*` (for example
`nationalities.*`). In JSON configuration, the equivalent path segment is `null`:

```json
{
    "path": ["nationalities"],
    "type": "array",
    "children": [
        {
            "path": [null],
            "type": "string"
        }
    ]
}
```

:::info[Claims Priority System]
EUDIPLO supports multiple ways to provide claims (configuration-level and offer-level), with a priority system that determines which claims are used. For a complete explanation of the claims priority order and when to use each method, see [Claims](claims.md).
:::

### Static Defaults via `fields[]`

You can define defaults directly in each field using `defaultValue`:

```json
{
    "fields": [
        {
            "path": ["given_name"],
            "type": "string",
            "defaultValue": "ERIKA",
            "mandatory": true,
            "disclosable": true,
            "display": [
                { "lang": "en-US", "label": "Given Name" },
                { "lang": "de-DE", "label": "Vorname" }
            ]
        },
        {
            "path": ["family_name"],
            "type": "string",
            "defaultValue": "MUSTERMANN",
            "mandatory": true,
            "disclosable": true
        },
        {
            "path": ["address"],
            "type": "object",
            "disclosable": true,
            "children": [
                {
                    "path": ["country"],
                    "type": "string",
                    "defaultValue": "DE",
                    "mandatory": true,
                    "disclosable": true
                },
                {
                    "path": ["postal_code"],
                    "type": "string",
                    "defaultValue": "51147",
                    "disclosable": true
                }
            ]
        },
        {
            "path": ["nationalities"],
            "type": "array",
            "defaultValue": ["DE"],
            "mandatory": true,
            "disclosable": true,
            "constraints": {
                "items": {
                    "type": "string",
                    "title": "Nationality"
                }
            },
            "children": [
                {
                    "path": [null],
                    "type": "string",
                    "defaultValue": "DE",
                    "disclosable": false
                }
            ]
        }
    ]
}
```

Static field defaults are useful for:

- Default values for all credentials of this type
- Fixed metadata (e.g., issuing country, issuing authority)
- Development and testing scenarios

### Nested Field Groups (`children`)

Use `children` when you want to model grouped structures like `address`, `age_equal_or_over`, or `place_of_birth`.

- Parent node: define `path` and `type` (`object` or `array`)
- Child nodes: define claim fields under `children[]`
- Child paths: prefer relative paths (for example `"path": ["street_address"]` under parent `"path": ["address"]`)

#### Web Client Field Editor

The web client displays fields as a flat list, so use dot-separated paths to represent the
nested structure:

- Add the container first, with type `object` or `array`.
- Add each object property using its full path, such as `address.locality`.
- Add an array item using `*`, such as `nationalities.*`.
- For deeper structures, use **JSON View** and the nested `children[]` form shown above. Array
  item paths use `null` in JSON, not `0`, because the item represents any array element.

For example, the form editor entries `address` (`object`), `address.locality` (`string`), and
`nationalities` (`array`), `nationalities.*` (`string`) produce nested object and array fields
when saved.

This structure improves readability in config files and enables grouped rendering in form-based UIs.

### Claim Validation

When a configuration defines `fields`, EUDIPLO derives a schema from them and validates the final
claims right before the credential is signed. This applies to every claim source: static
defaults, inline claims passed with the offer, claims webhooks and attribute providers.

A credential is not issued if the claims:

- miss a claim marked as `mandatory`,
- contain a claim with a different `type`,
- contain a claim that is not defined in `fields` (at the top level or inside an object that
  defines `children`), or
- contain an invalid nested structure.

The wallet receives a `credential_request_denied` error whose description lists the affected claim
paths, for example `/address/street_address: must be string`. Claim values are never included.

Objects that need additional dynamic properties can opt out of the unknown-claim check with
`additionalProperties` in their `constraints`. An `object` field without `children` accepts any
properties.

```json
{
    "path": ["metadata"],
    "type": "object",
    "constraints": { "additionalProperties": true },
    "children": [{ "path": ["source"], "type": "string" }]
}
```

Configurations without `fields` are not validated.

### Attribute Provider

For dynamic claim retrieval, configure an Attribute Provider that is called during issuance:

```json
{
    "attributeProviderId": "my-claims-provider"
}
```

The Attribute Provider endpoint receives issuance context and returns claim values.

Attribute Providers are useful when:

- Claims need to be fetched from an external system or database
- Claims should be personalized based on the authentication context
- Claims depend on real-time data

For detailed information about creating Attribute Providers, request/response formats, and implementation examples, see [Attribute Providers](attribute-provider.md).

## Notification Webhook Endpoint

You can configure a webhook endpoint to receive notifications about the issuance process. This allows you to track the status of credential issuance and take appropriate actions.

Reference a pre-configured webhook endpoint by its ID:

```json
{
    "webhookEndpointId": "my-notification-webhook"
}
```

The notification webhook endpoint will be called at various stages of the issuance process, such as:

- When a credential offer is accepted
- When a credential is successfully issued
- When a credential is rejected or an error occurs

For more details about the webhook implementation and payload structure, see [Notifications](notifications.md).

:::note
When a webhook endpoint is configured on credential config level, notifications are sent to this endpoint by default. It can be overridden per issuance by setting `webhookEndpointId` on the credential offer request.
:::

## Signing Key Chain

The `keyChainId` field specifies which key chain should be used to sign the credential. If not provided, EUDIPLO uses the key chain with `attestation` usage type.

## Credential Expiration

The `lifeTime` field determines when the credential expires. When set, EUDIPLO includes an `exp` claim in the credential calculated as:

```text
exp = iat + lifeTime
```

Where:

- `iat` is the issuance timestamp
- `lifeTime` is the configured lifetime in seconds

## Cryptographic Key Binding

When `keyBinding` is enabled, EUDIPLO:

1. Validates the holder-key evidence supplied in the credential request: a JWT proof or a trusted key attestation
2. Includes a `cnf` (confirmation) claim in the credential with the wallet's public key
3. Enables verifiers to cryptographically verify that the credential presenter is the legitimate holder

## Key Attestation

A key attestation describes the holder keys and their storage or user-authentication properties. EUDIPLO verifies its signature and provider trust before issuing a credential. This is separate from wallet attestation used to authenticate the OAuth client at the authorization server.

Configure these fields inside the credential's `config` object. For example, merge this fragment into an existing credential configuration to advertise JWT proofs with a key attestation:

```json
{
    "config": {
        "proofTypesSupported": ["jwt"],
        "keyAttestationsRequired": {
            "key_storage": ["iso_18045_high"],
            "user_authentication": ["iso_18045_high"]
        }
    }
}
```

`keyAttestationsRequired` is published as `proof_types_supported.jwt.key_attestations_required` in issuer metadata. An empty object advertises a key-attestation requirement without additional storage or authentication constraints.

EUDIPLO accepts key attestations in two forms:

- `jwt`: the wallet signs a holder proof and puts `key_attestation` in its protected header. Verification checks that the signing key is among the attested keys and that the attestation provider is trusted.
- `attestation`: the wallet sends the key-attestation JWT directly in `proofs.attestation`. The current implementation requires exactly one attested key per attestation proof.

For either form, configure trusted providers in the **issuance-level** `walletProviderTrustLists`. AS-specific trust lists apply only to wallet authentication. See [Key Attestation Trust](issuance-configuration.md#key-attestation-trust) for the shared trust-list configuration and upgrade behavior.

## Credential Reuse Policy

The `credentialReusePolicy` field publishes policy information in the credential metadata about whether and how the credential can be reused.

## Single Active Credential

Use `activeCredentials` when a credential should behave as a replaceable current record rather than a collection of independently valid copies. Typical uses include a current employee badge, a credential reissued after changed claims, or a replacement for a lost or compromised credential.

The policy permits one active credential issuance per subject and credential configuration. When the same subject starts a new issuance, EUDIPLO creates the replacement first and then revokes every credential from the previously active issuance. Credentials under other configurations are unaffected.

All credential responses authorized by the same access token remain active together. This includes multiple proofs in one credential request and multiple credential-endpoint requests made by a wallet to collect a batch. For example, if a wallet retrieves 40 credentials in four requests of 10, EUDIPLO revokes neither the earlier requests nor individual credentials in that batch. Revocation occurs when a different access token for the same subject and credential configuration successfully issues its first credential.

```json
{
    "statusManagement": true,
    "activeCredentials": {
        "enabled": true,
        "tracking": "internal"
    }
}
```

### Requirements and Limitations

- The policy requires `statusManagement: true`; EUDIPLO rejects a configuration that enables the policy without it.
- The issuing authorization server must provide a durable, stable `iss` and `sub` for each person. The policy is not enforced when the flow has no durable external subject, such as a session-scoped subject from the built-in authorization server.
- The same person authenticating through a different authorization server, or with a changed subject identifier, is treated as a different subject and can receive another active credential.
- This is a one-active-credential policy. Configurations cannot set a higher active-credential limit.
- A refreshed, renewed, or otherwise replaced access token starts a new issuance set. The first credential issued with it revokes the credentials issued with the prior token for this configuration.
- The encryption root key must remain available and stable while active credentials exist. Replacing it changes the derived fingerprints and prevents EUDIPLO from locating previous active slots.

EUDIPLO stores a pseudonymous, configuration-scoped HMAC derived from the external subject instead of the raw subject identifier. This prevents the stored value from being reused to correlate the same person across credential configurations, but it still lets EUDIPLO recognize a returning subject for this policy.

### Fingerprints and Revocation Procedure

EUDIPLO derives two independent, opaque identifiers from the root key used for at-rest encryption. It derives separate 32-byte HMAC keys with HKDF-SHA-256 and distinct purpose strings, then stores only the hexadecimal HMAC digest. Neither the raw subject nor the raw access token is written to the database.

- **Subject key:** `HMAC-SHA-256(subject-key, tenantId + "|" + credentialConfigurationId + "|" + iss + "|" + sub)`. This identifies the same subject for one credential configuration without allowing correlation across configurations.
- **Issuance-set key:** `HMAC-SHA-256(issuance-set-key, accessToken)`. This identifies credential requests authorized by the same access token. It uses a different HKDF-derived key from the subject key.

For each credential request, EUDIPLO performs the following procedure:

1. It validates the access token and obtains the external authorization identity (`iss` and `sub`).
2. It derives the subject key and access-token issuance-set key in memory.
3. It allocates and records the new credential's status-list entry with the issuance-set key.
4. If no active slot exists for the subject key, EUDIPLO creates one pointing to this issuance set.
5. If the slot already points to the same issuance-set key, the request belongs to the existing batch and no revocation occurs.
6. If the slot points to a different issuance-set key, EUDIPLO moves the slot to the new set and revokes every status-list entry associated with the previous set.

The slot update is protected by a unique constraint and optimistic version check so concurrent first requests converge on one active issuance set. The new status entry is allocated before the prior set is revoked, so an allocation failure does not revoke the holder's currently active credential.

For deferred issuance, EUDIPLO persists only the opaque issuance-set key with the deferred transaction. When the credential is completed later, it uses that same key so deferred credentials remain part of the access token's original batch.

### Operational Considerations

Enable this policy only when invalidating the prior credential is the desired business outcome. A new access token that issues a credential immediately makes credentials issued with the previous token revoked, which can interrupt a holder who is still using them. An access token must remain bound to one holder; sharing a token causes the issuances it authorizes to be treated as one batch.

Revocation takes effect for relying parties that check the credential's OAuth Token Status List. A verifier operating offline, using cached status information, or not checking status at all can continue accepting a replaced credential until it refreshes the status list or changes its verification policy. See [Status Management](revocation.md) for cache and update behavior.

## Embedded Disclosure Policy

The `embeddedDisclosurePolicy` field defines rules for selective disclosure when the credential is presented.

## Interactive Authorization Actions

The `iaeActions` field defines a sequence of interactive authorization steps required before credential issuance. See the [Architecture documentation](authorization-servers.md#authorization) for details on the Interactive Authorization Endpoint (IAE).

## Complete Configuration Example

```json
{
    "id": "citizen-credential",
    "description": "Citizen credential with full features",
    "config": {
        "format": "dc+sd-jwt",
        "display": [
            {
                "name": "Citizen Credential",
                "locale": "en-US",
                "logo": {
                    "url": "/img/citizen-logo.png"
                },
                "background_color": "#12107c",
                "text_color": "#FFFFFF"
            }
        ]
    },
    "vct": "urn:citizen:credential:1",
    "keyChainId": "default-signing-key",
    "lifeTime": 31536000,
    "statusManagement": true,
    "keyBinding": true,
    "attributeProviderId": "citizen-claims-provider",
    "webhookEndpointId": "issuance-notifications",
    "fields": [
        {
            "path": ["given_name"],
            "type": "string",
            "mandatory": true,
            "disclosable": true,
            "display": [{ "lang": "en-US", "label": "Given Name" }]
        },
        {
            "path": ["family_name"],
            "type": "string",
            "mandatory": true,
            "disclosable": true
        },
        {
            "path": ["birthdate"],
            "type": "string",
            "mandatory": true,
            "disclosable": true
        }
    ]
}
```
