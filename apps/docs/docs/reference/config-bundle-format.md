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
    "$schema": "https://eudiplo.dev/schemas/v2/PresentationConfigFile.schema.json",
    "metadata": { "generation": 3, "ownership": "file-managed" },
    "spec": { "id": "age-check" }
}
```

| Field                 | Required | Meaning                                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `$schema`             | yes      | Resource type and format version. Only the canonical URLs below are accepted; they are resolved from schemas bundled with the backend and CLI, never fetched. |
| `metadata.generation` | no       | Integer ≥ 1. An import whose generation is lower than the stored one is blocked (`STALE_GENERATION`).      |
| `metadata.ownership`  | no       | `unmanaged` or `file-managed`. Reported on export; ignored on import, which always records `file-managed`. |
| `spec`                | yes      | The desired configuration, without runtime state. The ID is `spec.id`, for clients `spec.clientId`.       |

Tenant, KMS, registrar and issuance settings exist once per tenant and have no ID.
In tenant config folders, the importer also accepts *bare* files (only the
`spec` content) at the known paths and wraps them; a document with an unknown
`$schema` or a newer version than the backend supports is rejected.

## Resource types and versions

The URL is `https://eudiplo.dev/schemas/v<version>/<File>.schema.json`. Older
versions are migrated on import and by `eudiplo config upgrade`; a backend
rejects versions newer than its own.

| Kind                 | `<File>`                      | Current version | Singleton |
| -------------------- | ----------------------------- | --------------- | --------- |
| `Tenant`             | `TenantConfigFile`            | 1               | yes       |
| `Client`             | `ClientConfigFile`            | 1               |           |
| `KmsConfig`          | `KmsConfigFile`               | 1               | yes       |
| `KeyChain`           | `KeyChainConfigFile`          | 1               |           |
| `RegistrarConfig`    | `RegistrarConfigFile`         | 1               | yes       |
| `IssuanceConfig`     | `IssuanceConfigFile`          | 2               | yes       |
| `CredentialConfig`   | `CredentialConfigFile`        | 1               |           |
| `PresentationConfig` | `PresentationConfigFile`      | 2               |           |
| `AttributeProvider`  | `AttributeProviderConfigFile` | 1               |           |
| `WebhookEndpoint`    | `WebhookEndpointConfigFile`   | 1               |           |
| `TrustList`          | `TrustListConfigFile`         | 1               |           |
| `StatusList`         | `StatusListConfigFile`        | 1               |           |

Version 2 was introduced with EUDIPLO 9.0; 8.x cannot read it:

- **IssuanceConfig v2** adds the optional `offerLifetimeSeconds`. A v1 document
  is migrated unchanged.
- **PresentationConfig v2** replaces `registration_cert.body.provided_attestations`
  with the registrar's `provides_attestations` (a list of credential type
  identifiers). The migration removes `provided_attestations` with the warning
  `PROVIDED_ATTESTATIONS_REMOVED`; set `provides_attestations` yourself.

## Tenant folder layout

Startup import reads `CONFIG_FOLDER` (`/app/config/config` in the image). Every
directory in it, including symlinked ones, is a tenant folder; a tenant that
does not exist yet is created only if its folder contains `info.json`.

```text
<CONFIG_FOLDER>/
├── kms.json                    global KMS providers
└── <tenant-id>/
    ├── info.json               Tenant (name, description, session and status-list defaults)
    ├── kms.json                tenant KMS providers, merged over the global file
    ├── registrar.json
    ├── clients/<id>.json
    ├── key-chains/<id>.json
    ├── attribute-providers/<id>.json
    ├── webhook-endpoints/<id>.json
    ├── trust-lists/<id>.json
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

Exports never contain secret values or database-held private keys:

| Value                                                                 | In the export                                                | Requirement code         | On import                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| Retrievable secrets (KMS, registrar, webhook and attribute-provider credentials) | `${…}` placeholder                              | `SECRET_REQUIRED`        | Set the environment variable or replace the value                    |
| Client secrets (stored as bcrypt hash)                                | `${…}` placeholder                                           | `CLIENT_SECRET_REQUIRED` | Supply a secret, or `"secret": "!generate"` to get a new one once in `generatedSecrets` |
| Private keys of `db` key chains                                       | `keySource: { "type": "required", "publicJwk": … }`          | `PRIVATE_KEY_REQUIRED`   | Supply `private-jwk`, or `{ "type": "regenerate" }` for new key material |
| Keys in an external KMS                                               | `keySource: { "type": "external-reference", provider, externalKeyId, publicJwk }` | -  | The target provider must reach the same key; checked by signing a challenge |
| Sessions, status values, caches                                       | not exported                                                 | -                        | -                                                                     |

`regenerate` keeps the key chain ID but creates a new cryptographic identity:
certificates and anything bound to the old key must be renewed.

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
| `update`    | The resource will change; the plan lists redacted field changes                            |
| `unchanged` | Already matches; only ownership metadata may be updated                                     |
| `skip`      | Exists and is left alone (`create` mode)                                                    |
| `delete`    | Will be removed (`replace` mode)                                                            |
| `blocked`   | Cannot be applied, for example `STALE_GENERATION`, `MISSING_RESOURCE_REFERENCE`, `STATUS_LIST_LAYOUT_IMMUTABLE` or a missing secret or key. One blocked item blocks the whole plan |

The import pipeline is: decode, verify checksums, migrate to the current
versions, validate, check references and external keys, plan, apply in
dependency order (for example key chains before issuance configs), record
`file-managed` ownership. Applying needs the `planFingerprint` of the reviewed
plan; a changed bundle, mode or target state fails with `CONFIG_PLAN_STALE`.
Status lists keep their capacity and bit size: import a new list ID for a
different layout.

## Management API

All endpoints act on the tenant of the access token and accept `tenant:admin` or
`tenants:manage` ([roles](roles.md)).

| Endpoint                                                          | Purpose                                   |
| ----------------------------------------------------------------- | ----------------------------------------- |
| `GET /api/config-bundles/export?format=zip\|json`                  | Export the tenant (default `json`)        |
| `POST /api/config-bundles/plan?mode=…`                            | Plan a JSON bundle                        |
| `POST /api/config-bundles/plan/archive?mode=…`                    | Plan a ZIP bundle (multipart field `bundle`) |
| `POST /api/config-bundles/import?mode=…&planFingerprint=…`        | Apply a JSON bundle                       |
| `POST /api/config-bundles/import/archive?mode=…&planFingerprint=…` | Apply a ZIP bundle; `replace` also needs `confirmReplace=true` |
| `POST /api/config-bundles/documents/upgrade`                      | Upgrade one document to the current version |
| `GET /api/config-bundles/operations`, `GET …/operations/:id`      | Latest 50 operation reports, or one report |
| `POST /api/config-bundles/operations/:id/acknowledge-interruption?confirmWorkerStopped=true` | Release the lock of an interrupted operation |
| `GET /api/config-bundles/resources`                               | Ownership and generation of every resource |
| `POST /api/config-bundles/resources/:kind/:id/detach`             | Make a `file-managed` resource `unmanaged` |

Exports, imports and detach actions are recorded in the tenant audit log.
