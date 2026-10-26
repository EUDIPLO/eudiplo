---
title: Config Bundle Format
---

# Config Bundle Format

The format of configuration documents, tenant config folders and export bundles,
as read by the startup import, the bundle API and the CLI. For the workflow
(validate, export, plan, import), see [Configuration as code](../operate/configuration-as-code.md).

## Document envelope

Every portable resource is one JSON document:

```json
{
    "$schema": "https://eudiplo.dev/schemas/v3/PresentationConfigFile.schema.json",
    "metadata": { "generation": 3, "ownership": "file-managed" },
    "spec": { "id": "age-check" }
}
```

| Field                 | Required | Meaning                                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `$schema`             | yes      | Resource type and format version. Only the canonical URLs below are accepted; they are resolved from schemas bundled with the backend and CLI, never fetched. |
| `metadata.generation` | no       | Integer ≥ 1. A bundle import whose generation is lower than the stored one is blocked (`STALE_GENERATION`); the startup import skips that resource instead. |
| `metadata.ownership`  | no       | `unmanaged` or `file-managed`. Reported on export, where a detached resource is reported as `unmanaged`; ignored on import, which always records `file-managed`. |
| `spec`                | yes      | The desired configuration, without runtime state. The ID is `spec.id`, for clients `spec.clientId`, which is unique across tenants: a client ID another tenant uses blocks the plan (`CLIENT_ID_TAKEN`). |

Tenant, KMS, registrar and issuance settings exist once per tenant and have no ID.
In tenant config folders, the importer also accepts *bare* files (only the
`spec` content) at the known paths and wraps them; a document with an unknown
`$schema` or a newer version than the backend supports is rejected. A bare file
names no version, so it is read as version 1, except key chain and KMS files
([format versions](#resource-types-and-versions)): prefer documents, which
`GET /api/config-bundles/resources/:kind/:id/document` and the Web Client's
download buttons write ([single resources](#single-resources)).

## Resource types and versions

The URL is `https://eudiplo.dev/schemas/v<version>/<File>.schema.json`. Older
versions are migrated on import and by `eudiplo config upgrade`; a backend
rejects versions newer than its own.

| Kind                 | `<File>`                      | Current version | Singleton |
| -------------------- | ----------------------------- | --------------- | --------- |
| `Tenant`             | `TenantConfigFile`            | 3               | yes       |
| `Client`             | `ClientConfigFile`            | 2               |           |
| `KmsConfig`          | `KmsConfigFile`               | 2               | yes       |
| `KeyChain`           | `KeyChainConfigFile`          | 3               |           |
| `RegistrarConfig`    | `RegistrarConfigFile`         | 2               | yes       |
| `IssuanceConfig`     | `IssuanceConfigFile`          | 5               | yes       |
| `CredentialConfig`   | `CredentialConfigFile`        | 2               |           |
| `PresentationConfig` | `PresentationConfigFile`      | 3               |           |
| `AttributeProvider`  | `AttributeProviderConfigFile` | 1               |           |
| `WebhookEndpoint`    | `WebhookEndpointConfigFile`   | 1               |           |
| `TrustList`          | `TrustListConfigFile`         | 1               |           |
| `FederationTrustAnchor` | `FederationTrustAnchorConfigFile` | 1         |           |
| `StatusList`         | `StatusListConfigFile`        | 1               |           |

IssuanceConfig v2 and PresentationConfig v2 and v3 were introduced with EUDIPLO
9.0; 8.x cannot read them:

- **IssuanceConfig v2** adds the optional `offerLifetimeSeconds`. A v1 document
  is migrated unchanged.
- **PresentationConfig v2** replaces `registration_cert.body.provided_attestations`
  with the registrar's `provides_attestations` (a list of credential type
  identifiers). The migration removes `provided_attestations` with the warning
  `PROVIDED_ATTESTATIONS_REMOVED`; set `provides_attestations` yourself.
- **PresentationConfig v3** accepts integer and boolean DCQL claim `values`
  besides strings and requires them to be non-empty. A v2 document is migrated
  unchanged; an empty `values` array stops the migration with a validation
  error.

**IssuanceConfig v3** came after 9.0. It adds the optional `verifierKeyPem`
(PEM public key of the list signer) to `walletProviderTrustLists` entries. A v2
document is migrated unchanged; releases that only know v2, such as 9.0, cannot
read v3 files.

**IssuanceConfig v4** came with EUDIPLO 10.0. It adds the optional
`walletAttestationStatusCheckMode` (`strict`, `best_effort` or `disabled`) to the
issuance configuration and its `built-in`, `chained` and `oid4vp` authorization
servers. A v3 document is migrated unchanged; 9.x cannot read v4 files.

**IssuanceConfig v5** came with EUDIPLO 10.0. It adds the optional `federation`
fields for the published entity configuration (`entityTypes`,
`authorityHints`, `entityKeyChainId`, `entityConfigurationLifetimeSeconds`,
`trustMarks`, `entityMetadata`, `includeTrustChain`) and requires a non-empty
`federation.entityId` to be an `https` or `http` URL with a host and without
query, fragment, credentials or whitespace, written as the URL it stands for.
When the document is applied, the server refuses `http` unless
`OUTBOUND_URL_ALLOW_HTTP=true` ([OpenID Federation](../trust/federation.md#configure-federation-for-issuance)).
A v4 document with a valid or empty `entityId` is migrated unchanged. Another
value stops the migration with the required input
`FEDERATION_ENTITY_ID_INVALID` at `/spec/federation/entityId`; the value is not
rewritten, and nothing is written until you set it.

**CredentialConfig v2** came with EUDIPLO 10.0. It accepts `x509` as
`frameworkType` of `schemaMeta.trustedAuthorities` entries, with the root
certificate in `value`. A v1 document is migrated unchanged; 9.x cannot read v2
files.

**KeyChain v2** came with EUDIPLO 10.0. It adds the optional `type`
(`standalone` or `internalChain`), which exports write. For a `private-jwk` key
source without `activeJwk` it says whether `jwk` is the signing key or a CA key
under which the import creates a new signing key, as `type` does for
[`POST /api/key-chain/import`](../trust/keys-and-certificates.md#import-a-key-and-certificate).
For `regenerate` it is the type of the new key chain, like
`keySource.keyChainType`; without either, a document with `activeCertificate`
becomes an internal chain. For the other key sources, and for a `regenerate`
key source with both, it must match the key chain they describe, or the plan
reports `KEY_CHAIN_TYPE_MISMATCH`. A v1 document is migrated unchanged;
9.x cannot read v2 files. A bare key chain file with `type`, as
`GET /api/key-chain/{id}/export` writes it, is read as v2.

**Tenant v3** came with EUDIPLO 10.0 as well. It adds the optional
`defaultKeyChains`, the tenant's key chain per usage type, used where no
configuration names one. So far it has one entry, `access`: the
[default access key chain](../trust/keys-and-certificates.md#default-access-key-chain).
Unlike the other fields of `info.json`, leaving `defaultKeyChains` out of a
document that is applied removes the stored entries, so the tenant picks its
key chains by rule again. The plan of a bundle reports
`MISSING_RESOURCE_REFERENCE` when an entry names a key chain that is neither
stored nor in the bundle, and `KEY_CHAIN_USAGE_MISMATCH` when the key chain's
usage type is not the entry's; a config folder checks the entries at startup
instead
([Default access key chain](../trust/keys-and-certificates.md#default-access-key-chain)). A bare
`info.json` with `defaultKeyChains` is read as v3. A v1 document is migrated
unchanged. Tenant v2, which development builds of 10.0 wrote, had the flat
`defaultAccessKeyChainId`; the v2 to v3 step moves it to
`defaultKeyChains.access`. 9.x cannot read v2 or v3 files.

**Client v2** came with EUDIPLO 10.0 as well. It accepts the roles
`audit:read`, `sessions:read`, `credentials:status` and `keys:manage`. A v1
document is migrated unchanged; 9.x cannot read v2 files.

**KmsConfig v2** came with EUDIPLO 10.0 as well. It adds the optional
`algorithms` and `defaultAlgorithm` of a provider, which limit the
[signing algorithms](../operate/kms.md#signing-algorithms) of new and imported
key chains, including `KeyChain` documents of a bundle. A bare `kms.json` with
`algorithms` or `defaultAlgorithm` on a provider is read as v2. A
v1 document is migrated unchanged; 9.x cannot read v2 files.

**RegistrarConfig v2** came with EUDIPLO 10.0 as well. It adds the optional
`relyingPartyContact`, sent when EUDIPLO registers the relying party at the
registrar ([Registrar](../trust/registrar.md#relying-party)). A bare
`registrar.json` with `relyingPartyContact` is read as v2. A v1 document is
migrated unchanged; 9.x cannot read v2 files.

## Tenant folder layout

Startup import reads `CONFIG_FOLDER` (`/app/config/config` in the image). Every
directory in it, including symlinked ones, is a tenant folder; a tenant that
does not exist yet is created only if its folder contains `info.json`.

```text
<CONFIG_FOLDER>/
├── kms.json                    global KMS providers
└── <tenant-id>/
    ├── info.json               Tenant (name, description, session and status-list defaults, default access key chain)
    ├── kms.json                tenant KMS providers, merged over the global file
    ├── registrar.json
    ├── clients/<id>.json
    ├── key-chains/<id>.json
    ├── attribute-providers/<id>.json
    ├── webhook-endpoints/<id>.json
    ├── trust-lists/<id>.json
    ├── federation-trust-anchors/<id>.json
    ├── issuance/
    │   ├── issuance.json       IssuanceConfig
    │   ├── credentials/<id>.json
    │   └── status-lists/<id>.json
    ├── presentation/<id>.json
    └── images/<file>           logos and credential images, referenced by file name
```

File names are not significant; the ID comes from the document.

## Bundle layout

An export is a ZIP archive or the same content as one JSON object
(`{ "manifest": …, "documents": [ … ], "assets": [ … ] }`, assets base64-encoded).
The ZIP uses the folder layout above for one tenant, with two differences:
the files sit at the root of the archive, and the issuance settings are stored as
`issuance/config.json`.

`manifest.json` contains:

| Field           | Content                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `format`        | `eudiplo.config-bundle`                                                                  |
| `formatVersion` | `2` for new bundles; version 1 bundles are still read                                    |
| `sourceVersion`, `exportedAt`, `tenant` | Origin of the export                                             |
| `resources[]`   | `kind`, `id`, `$schema`, `path`, `sha256`, `ownership`, `generation` per document        |
| `assets[]`      | `path`, `contentType`, `sha256` per binary file                                          |
| `requirements[]`| Values the target must supply: `code`, `resource`, `path`, `message`, `placeholder`      |
| `warnings[]`    | Migration warnings                                                                       |

**Integrity and limits.** Backend and CLI verify that resource identities, paths
and SHA-256 checksums match the manifest. Duplicate resources, unsafe paths and
ZIP entries not listed in the manifest are rejected. A ZIP may have at most
50 MiB compressed, 100 MiB expanded and 10,000 entries.

## Secret and key policy

Bundle exports (`GET /api/config-bundles/export`) never contain secret values
or database-held private keys. The document of a single key chain is the one
exception ([single resources](#single-resources)).

| Value                                                                 | In the export                                                | Requirement code         | On import                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| Retrievable secrets (KMS, registrar, webhook and attribute-provider credentials, upstream client secrets of chained authorization servers) | `${…}` placeholder | `SECRET_REQUIRED`        | Set the environment variable or replace the value                    |
| Client secrets (stored as bcrypt hash)                                | `${…}` placeholder                                           | `CLIENT_SECRET_REQUIRED` | Supply a secret, or `"secret": "!generate"` to get a new one once in `generatedSecrets` |
| Private keys of `db` key chains                                       | `keySource: { "type": "required", "publicJwk": … }`          | `PRIVATE_KEY_REQUIRED`   | Supply `private-jwk`, or `{ "type": "regenerate" }` for new key material |
| Keys in an external KMS                                               | `keySource: { "type": "external-reference", provider, externalKeyId, publicJwk }` | -  | The target provider must reach the same key; checked by signing a challenge |
| Sessions, status values, caches                                       | not exported                                                 | -                        | -                                                                     |

A secret that is not set, such as the client secret of a registrar account without one, is left out of the export and adds no requirement.

`regenerate` keeps the key chain ID but creates a new cryptographic identity:
certificates and anything bound to the old key must be renewed.

A `private-jwk` key source takes one of two forms:

- With only `jwk`, the document is imported like
  [`POST /api/key-chain/import`](../trust/keys-and-certificates.md#import-a-key-and-certificate)
  and accepts only that request's fields. To restore an exported internal
  chain, put its root CA key from `GET /api/key-chain/{id}/export` into `jwk`,
  remove `activeCertificate` and keep `"type": "internalChain"`: EUDIPLO keeps
  the root CA certificate and creates a new signing key under it. Without
  `type` and rotation, the root CA key itself becomes the signing key.
- With `activeJwk` as well, it stores an internal chain as given, in the
  database: `jwk` is the root CA key and `crt` holds exactly its certificate,
  `activeJwk` is the signing key and `activeCertificate` its certificate,
  which may be followed by the root certificate. Both certificates must be
  PEM and match their keys, the root certificate must be a CA certificate,
  and `kmsProvider` must be `db` or left out; the plan blocks the resource
  otherwise. Bundle exports and `GET /api/key-chain/{id}/export` never contain
  the signing key of an internal chain
  ([key chain export](../trust/keys-and-certificates.md#import-a-key-and-certificate));
  `GET /api/config-bundles/resources/KeyChain/{id}/document` writes this form
  ([single resources](#single-resources)).

**Placeholders.** Any string value can be `${VAR}` or `${VAR:default}`
(uppercase letters, digits, `_`; an empty variable counts as unset). Values are
substituted once and not interpreted again. In tenant folders, unresolved
placeholders are handled according to `CONFIG_VARIABLE_STRICT`:

| Value                    | Effect                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `skip` (default), `abort`, `true` | Error; the import of this tenant fails, other tenants continue |
| `ignore`, `false`        | Warning; the placeholder stays as literal text                         |

## Import modes and plan actions

| Mode      | Existing resource                        | Resource missing from the bundle                                   |
| --------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `create`  | `skip` (warning `RESOURCE_EXISTS`)       | kept                                                               |
| `upsert`  | `update` or `unchanged`                  | kept                                                               |
| `replace` | `update` or `unchanged`                  | `delete`, only if it was imported earlier from the same source     |

| Plan action | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `create`    | The resource will be created                                                                |
| `update`    | The resource will change; the plan lists its field changes, secrets redacted               |
| `unchanged` | Already matches, or a key chain or `!generate` client document this source already applied (see below); only ownership metadata may be updated |
| `skip`      | Exists and is left alone: in `create` mode (`RESOURCE_EXISTS`), in a startup import when the resource was detached from that folder (`RESOURCE_DETACHED`) or has a newer stored generation (`STALE_GENERATION`), or because it is the tenant's encryption key chain (`KEY_CHAIN_ID_RESERVED`) |
| `delete`    | Will be removed (`replace` mode)                                                            |
| `blocked`   | Cannot be applied, for example `STALE_GENERATION`, `MISSING_RESOURCE_REFERENCE`, `STATUS_LIST_LAYOUT_IMMUTABLE`, `REGISTRATION_CERTIFICATE_REFUSED` for an imported registration certificate that fails its checks, for example because it is expired or does not cover the DCQL query ([Validation and caching](../trust/registration-certificates.md#validation-and-caching)), a missing secret or key, `UNSUPPORTED_KEY_ALGORITHM` for a key chain whose key uses an algorithm its KMS provider does not offer ([Signing algorithms](../operate/kms.md#signing-algorithms)), `TRUST_LIST_IN_USE` on a trust list that `replace` would delete while a configuration still references it ([Delete a trust list](../trust/trust-lists.md#delete-a-trust-list)), `MISSING_RESOURCE_REFERENCE` on a presentation configuration that names, or the issuance configuration that adds, an OpenID Federation trust anchor neither the tenant nor the bundle registers, `FEDERATION_TRUST_ANCHOR_IN_USE` on a trust anchor that the import would delete or give another entity ID while a configuration still names it ([Delete a trust anchor](../trust/federation.md#delete-a-trust-anchor)), `KEY_CHAIN_IN_USE` on a key chain that `replace` would delete while a configuration still names it ([Delete a key chain](../trust/keys-and-certificates.md#delete-a-key-chain)), or `KEY_CHAIN_USAGE_MISMATCH` on a tenant whose `defaultKeyChains` entry names a key chain of another usage type ([Default access key chain](../trust/keys-and-certificates.md#default-access-key-chain)). One blocked item blocks the whole plan |

An `update` item lists its field changes in `changes`: the `path` in the document, the stored value as `before` and the value after the import as `after`. Without `before`, the import adds the field; without `after`, it removes the stored value. Entries with `redacted: true` hide the values: a secret reads `[redacted]`, and a value that changes between an object, a list and a plain value reads `[changed]` on both sides.

A `KmsConfig` or `RegistrarConfig` document replaces the stored resource: fields it leaves out are removed, and the plan lists their removal. A `KeyChain` document replaces the stored key material, and also the type, description and rotation policy:

- The plan lists `type` as the import creates it, also for a document without `type` ([KeyChain v2](#resource-types-and-versions)).
- A `description` it leaves out is removed.
- Without `rotationPolicy`, rotation is disabled.
- A rotation value it leaves out or sets to `null` is not set. Exception: a `private-jwk` key source without `activeJwk` is imported like `POST /api/key-chain/import`, so with rotation enabled a missing `intervalDays` becomes 90 and a missing `certValidityDays` 365, and with rotation disabled no intervals are stored.

The plan lists these values as they will be stored. For the other kinds, a top-level field the document leaves out keeps its stored value.

A `KeyChain` document that is identical to the one last applied from the same source (the same config folder, or bundles whose manifest names the same tenant) plans `unchanged` while the key chain is `file-managed`, without comparing it with the stored key chain: importers add key IDs, EUDIPLO creates the signing key of a CA key, and rotation or registrar enrollment replace keys and certificates later. These changes stay, so certificates EUDIPLO created during the import are only renewed by rotation. Reattaching always applies the folder version. To apply an unchanged document again, for example to regenerate a key, raise `metadata.generation`; in a bundle, also update the document's `sha256` in `manifest.json`.

The same rule covers a `Client` document with `"secret": "!generate"`, since applying it generates a new secret: once this source applied it, the client keeps its secret while the document stays the same. A changed document, a raised `metadata.generation`, another source or reattaching generates a new secret, returned once in `generatedSecrets`. Other `Client` documents are compared field by field. With Keycloak (`OIDC` set), every `Client` document is applied on every import, because the plan cannot see changes made in Keycloak; a `!generate` client applied as it is keeps its secret.

The tenant's encryption key chain is managed by EUDIPLO and is not configuration: exports leave it out, and plans neither change nor delete it. A `KeyChain` document with its ID, such as the one exports of earlier versions contain, is skipped (warning `KEY_CHAIN_ID_RESERVED`).

The import pipeline is: decode, verify checksums, migrate to the current
versions, validate, check references and external keys, plan, apply in
dependency order (for example key chains before issuance configs), record
`file-managed` ownership. Applying needs the `planFingerprint` of the reviewed
plan; a changed bundle, mode or target state fails with `CONFIG_PLAN_STALE`.
Status lists keep their capacity and bit size: import a new list ID for a
different layout.

## Management API

All endpoints act on the tenant of the access token and accept `tenant:admin` or
`tenants:manage` ([roles](roles.md)), except where noted below.

| Endpoint                                                          | Purpose                                   |
| ----------------------------------------------------------------- | ----------------------------------------- |
| `GET /api/config-bundles/export?format=zip\|json`                  | Export the tenant (default `json`)        |
| `POST /api/config-bundles/plan?mode=…`                            | Plan a JSON bundle                        |
| `POST /api/config-bundles/plan/archive?mode=…`                    | Plan a ZIP bundle (multipart field `bundle`) |
| `POST /api/config-bundles/import?mode=…&planFingerprint=…`        | Apply a JSON bundle; `replace` also needs `confirmReplace=true` |
| `POST /api/config-bundles/import/archive?mode=…&planFingerprint=…` | Apply a ZIP bundle; `replace` also needs `confirmReplace=true` |
| `POST /api/config-bundles/documents/upgrade`                      | Upgrade one document to the current version |
| `GET /api/config-bundles/operations`, `GET …/operations/:id`      | Latest 50 operation reports, or one report |
| `POST /api/config-bundles/operations/:id/acknowledge-interruption?confirmWorkerStopped=true` | Release the lock of an interrupted operation |
| `GET /api/config-bundles/resources`                               | Ownership and generation of every resource |
| `GET /api/config-bundles/resources/:kind`                         | Ownership and generation of one kind's resources |
| `GET /api/config-bundles/resources/:kind/:id/document`            | Export one resource as a document ([single resources](#single-resources)) |
| `POST /api/config-bundles/resources/:kind/:id/detach`             | Make a `file-managed` resource `detached`  |
| `POST /api/config-bundles/resources/:kind/:id/reattach/plan`      | Plan resetting a resource to its version in `CONFIG_FOLDER` |
| `POST /api/config-bundles/resources/:kind/:id/reattach?planFingerprint=…` | Apply that plan and make the resource `file-managed` again |

Exports of bundles and single resources, imports, detach and reattach actions are recorded in the tenant audit log.

`GET /api/config-bundles/resources/:kind` also accepts the roles that change
resources of that kind, so screens can lock file-managed resources for them:

| Kind                                                                    | Also readable with                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `Tenant` (session and status list settings, default access key chain)   | `issuance:manage`, `presentation:manage`, `keys:manage` |
| `KeyChain`                                                              | `issuance:manage`, `presentation:manage`, `keys:manage` |
| `WebhookEndpoint`, `TrustList`, `FederationTrustAnchor`                 | `issuance:manage`, `presentation:manage`                |
| `IssuanceConfig`, `CredentialConfig`, `AttributeProvider`, `StatusList` | `issuance:manage`                                       |
| `PresentationConfig`                                                    | `presentation:manage`                                   |
| `Client`                                                                | `clients:manage`                                        |
| `RegistrarConfig`                                                       | `registrar:manage`                                      |
| `KmsConfig`                                                             | no other role                                           |

### Single resources

`GET /api/config-bundles/resources/:kind/:id/document` returns one resource as
a document in the current format version: the content of its file in a
[tenant folder](#tenant-folder-layout) or a bundle. Save it as
`<directory>/<id>.json` (for the singletons `info.json`, `kms.json`,
`registrar.json` and `issuance/issuance.json`) and, once its `${…}`
placeholders are set, the next import plans it as `unchanged`. The singletons use their fixed IDs `tenant`, `kms`, `registrar`
and `issuance`; the tenant's encryption key chain is not configuration and
answers `404`. The **Download configuration** buttons of the Web Client save
this document as `<id>.json`, and the import of **Settings > Config
Portability** accepts it in place of a bundle.

Secrets are `${…}` placeholders as in a bundle export
([secret and key policy](#secret-and-key-policy)); with the default
`CONFIG_VARIABLE_STRICT=skip`, a folder import fails for that tenant until the
environment variables are set. The Web Client names them after the download.
Image references name
the file, which has to be in the folder's `images/` or already stored on the
target instance. Unlike a bundle, a `KeyChain` document of a key held in the
database keeps its private keys as `keySource: { "type": "private-jwk" }`,
for an internal chain with the signing key in `activeJwk`, so its import
restores the same keys. A `KeyChain` document therefore needs `tenant:admin` or
`tenants:manage`; the other kinds also accept the roles in the table above,
except `keys:manage` for the `Tenant` document, which also holds the session
and status list settings.
