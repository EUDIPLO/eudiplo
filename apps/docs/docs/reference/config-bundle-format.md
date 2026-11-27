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
    "$schema": "https://eudiplo.dev/schemas/v4/PresentationConfigFile.schema.json",
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

Tenant, KMS and issuance settings and the key chain defaults exist
once per tenant and have no ID.
In tenant config folders, the importer also accepts *bare* files (only the
`spec` content) at the known paths and wraps them; a document with an unknown
`$schema` or a newer version than the backend supports is rejected. A bare file
names no version, so it is read as version 1, except key chain, key chain
defaults, KMS, tenant and presentation files
([format versions](#resource-types-and-versions)): prefer documents, which
`GET /api/config-bundles/resources/:kind/:id/document` and the Web Client's
download buttons write ([single resources](#single-resources)).

## Resource types and versions

The URL is `https://eudiplo.dev/schemas/v<version>/<File>.schema.json`. Older
versions are migrated on import and by `eudiplo config upgrade`; a backend
rejects versions newer than its own.

| Kind                 | `<File>`                      | Current version | Singleton |
| -------------------- | ----------------------------- | --------------- | --------- |
| `Tenant`             | `TenantConfigFile`            | 4               | yes       |
| `Client`             | `ClientConfigFile`            | 3               |           |
| `KmsConfig`          | `KmsConfigFile`               | 2               | yes       |
| `KeyChain`           | `KeyChainConfigFile`          | 4               |           |
| `KeyChainDefaults`   | `KeyChainDefaultsConfigFile`  | 2               | yes       |
| `IssuanceConfig`     | `IssuanceConfigFile`          | 7               | yes       |
| `CredentialConfig`   | `CredentialConfigFile`        | 5               |           |
| `PresentationConfig` | `PresentationConfigFile`      | 5               |           |
| `AttributeProvider`  | `AttributeProviderConfigFile` | 1               |           |
| `WebhookEndpoint`    | `WebhookEndpointConfigFile`   | 1               |           |
| `TrustList`          | `TrustListConfigFile`         | 2               |           |
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

**TrustList v2** came with EUDIPLO 10.0. Entity info follows ETSI TS 119 602:
`country` and `lang` codes, an absolute `uri`, and the required e-mail address
(`contactUri`) and web site (`website`), with an optional `phone`
([Trust lists](../trust/trust-lists.md#publish-a-managed-trust-list)). v1 has no
`website`, so the v1 step only reports: it stops with the required input
`TRUST_LIST_WEBSITE_MISSING` at `/spec/entities/<index>/info/website` and names
the other values to change; rewrite the file as v2. 9.x cannot read v2 files.

**PresentationConfig v4** came with EUDIPLO 10.0. It adds the optional
`allowedOrigins`, the web origins that may request the presentation over the
Digital Credentials API ([Allowed origins](../presentation/configure-verification.md#allowed-origins-digital-credentials-api)),
and `format`, `signingCertificates` and `schemeTerritories` in `etsi_tl` values
for ETSI TS 119 612 Trusted Lists ([Trusted Lists for QEAAs](../trust/trust-lists.md#trusted-lists-for-qeaas)).
A v3 document is migrated unchanged, and a bare presentation file with
`allowedOrigins`, or with an `etsi_tl` value that has `format`, is read as v4.
9.x cannot read v4 files.

**PresentationConfig v5** came with EUDIPLO 10.0. `registration_cert` holds the
certificate (`jwt`) and the `purpose` and `privacy_policy` it is requested with
([Registration Certificates](../trust/registration-certificates.md)); `id`,
`body` and the flat `registrationCert*` form fields are removed. The v4 to v5
step moves `body.purpose` and `body.privacy_policy` up a level (from the form
fields when no `registration_cert` is set), drops `id` and the other `body`
fields with the warning `REGISTRATION_CERT_FIELD_REMOVED`, drops purposes
without language or text with `REGISTRATION_CERT_PURPOSE_INCOMPLETE`, and warns
with `REGISTRATION_CERT_NOT_REQUESTED` when the certificate was requested from
the registrar and no `jwt` is set. A bare presentation file with
`registration_cert.purpose` or `.privacy_policy` is read as v5. 9.x cannot read
v5 files.

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

**IssuanceConfig v6** came with EUDIPLO 10.0. It removes the top-level
`signingKeyId`, which only chose the key chain for the access tokens of the
built-in authorization server. Access tokens are now signed only by key chains
with usage type `authorizationServer`, which no earlier key chain has
([Authorization server key chain](../trust/keys-and-certificates.md#authorization-server-key-chain)).
The v5 to v6 step therefore drops a set value with the warning
`ISSUANCE_SIGNING_KEY_ID_REMOVED` instead of moving it; the built-in
authorization server then uses the tenant's authorization server key chain. To choose
one, set `token.signingKeyId` of its entry. A `token.signingKeyId` of an
authorization server stays and gets the warning `AUTHORIZATION_SERVER_KEY_CHAIN_REQUIRED`
at its path: from v6 on it must name a key chain with usage type `authorizationServer`,
else the plan reports `KEY_CHAIN_USAGE_MISMATCH`, as a warning when the stored
configuration already has the value. A document without either field is migrated unchanged;
9.x cannot read v6 files.

**IssuanceConfig v7** came with EUDIPLO 10.0. `registrationCertificate.mode`
and `.renewal` are removed: the issuer metadata carries the configured `jwt`
only ([Registration Certificates](../trust/registration-certificates.md#issuer-registration-certificate)).
The v6 to v7 step drops both. In `generate` mode, which was the default, a
`jwt` was not served; the step drops it too, with the warning
`ISSUER_REGISTRATION_CERTIFICATE_JWT_DROPPED`, so that it does not start to be
published. An enabled certificate in `generate` mode then without `jwt` gets the
warning `ISSUER_REGISTRATION_CERTIFICATE_NOT_GENERATED`. 9.x cannot read v7
files.

**CredentialConfig v2** came with EUDIPLO 10.0. It accepts `x509` as
`frameworkType` of `schemaMeta.trustedAuthorities` entries, with the root
certificate in `value`. A v1 document is migrated unchanged; 9.x cannot read v2
files.

**CredentialConfig v3** came with EUDIPLO 10.0 as well. Claim field
`constraints`, also those of `children`, accept only JSON Schema validation and
annotation keywords ([Constraints](../issuance/claims.md#constraints)). The v2
to v3 step removes every other key, also inside subschemas, and subschema
keywords whose value is not an object or boolean, each with the warning
`CLAIM_CONSTRAINT_KEYWORD_REMOVED` at its path, for example
`/spec/fields/0/constraints/widget`. v3 also matches claim patterns with RE2
([Constraints](../issuance/claims.md#constraints)): a `pattern` or
`patternProperties` key RE2 cannot run stops the migration with the required
input `CLAIM_PATTERN_UNSUPPORTED` at its path, for example
`/spec/fields/0/constraints/pattern`; the pattern is not rewritten, and nothing
is written until you change it.

**CredentialConfig v4** came with EUDIPLO 10.0 as well. `config.display[]`
colors must be CSS Color Level 3 numerical values (`#rgb`, `#rrggbb`, lowercase
`rgb()`, `rgba()`, `hsl()` or `hsla()` with comma-separated values, or
`transparent`), and each locale may appear once, compared case-insensitively.
The v3 to v4 step trims colors and lowercases their function names, removes an
empty color, and removes any other color with the warning
`DISPLAY_COLOR_REMOVED` at its path, for example
`/spec/config/display/0/text_color`, so wallets use their own. A second entry for
one locale stops the migration with the required input
`DISPLAY_LOCALE_DUPLICATE` at `/spec/config/display/<index>/locale`, and nothing
is written until you remove or change it. 9.x cannot read v4 files.

**CredentialConfig v5** came with EUDIPLO 10.1. It adds the optional `format`
(`date`, `date-time`) on `string` claim fields, which mDOC issuance encodes as
`full-date` (CBOR tag 1004) or `tdate` (CBOR tag 0); see
[Dates](../issuance/claims.md#dates). The v4 to v5 step changes nothing, and a
bare credential configuration file with `format` on a field, nested ones
included, is read as v5. 10.0 cannot read v5 files.

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

**KeyChain v4** came with EUDIPLO 10.0. It adds the usage type `authorizationServer`
for the key chains that sign access tokens
([Authorization server key chain](../trust/keys-and-certificates.md#authorization-server-key-chain)).
A v3 document is migrated unchanged; a bare key chain file with usage type
`authorizationServer` is read as v4.

**KeyChainDefaults v1** came with EUDIPLO 10.0. The singleton
`KeyChainDefaults/defaults` (`key-chain-defaults.json`) holds the tenant's key
chain per usage type, used where no configuration names one. v1 has one entry,
`access`: the
[default access key chain](../trust/keys-and-certificates.md#default-access-key-chain).
The document replaces all entries, so leaving `access` out of a document that is
applied removes it, and the tenant picks its access key chain by rule again. The
plan reports `MISSING_RESOURCE_REFERENCE` when an entry names a key chain that is
neither stored nor in the bundle, and `KEY_CHAIN_USAGE_MISMATCH` when the key
chain's usage type is not the entry's. An export writes the document only while
an entry is set.

**KeyChainDefaults v2** came with EUDIPLO 10.0 as well. It adds the optional
entry `authorizationServer`: the key chain with usage type `authorizationServer` that signs the
access tokens of authorization servers without `token.signingKeyId`
([Authorization server key chain](../trust/keys-and-certificates.md#authorization-server-key-chain)).
A v1 document is migrated unchanged; a bare `key-chain-defaults.json` with
`authorizationServer` is read as v2.

**Tenant v4** came with EUDIPLO 10.0 as well. Tenant v2 and v3, which only
development builds of 10.0 wrote, kept the default key chains in `info.json`
(`defaultAccessKeyChainId`, then `defaultKeyChains`); v4 moves them to
`KeyChainDefaults`. The upgrade to v4 drops the field with the warning
`DEFAULT_KEY_CHAINS_MOVED` and does not apply it; move the value to
`key-chain-defaults.json`. A v1 document is migrated unchanged. A bare
`info.json` with `defaultKeyChains` is read as v3, one with
`defaultAccessKeyChainId` as v2. 9.x cannot read v2 to v4 files.

**Client v2** came with EUDIPLO 10.0 as well. It accepts the roles
`audit:read`, `sessions:read`, `credentials:status` and `keys:manage`. A v1
document is migrated unchanged; 9.x cannot read v2 files.

**Client v3** comes with EUDIPLO 11.0. It accepts the roles `issuance:read`,
`presentation:read` and `keys:export`. Migrating a v2 document adds
`audit:read` to a client with `clients:manage` and `keys:manage` to one with
`issuance:manage` or `presentation:manage`, unless it has `tenant:admin` or
`tenants:manage`, so it keeps the access those roles had in 10.x; the
migration reports each addition as a warning
([role model](../upgrade/10.x-to-11.0.md#operators-role-model)). 10.x cannot
read v3 files.

**KmsConfig v2** came with EUDIPLO 10.0 as well. It adds the optional
`algorithms` and `defaultAlgorithm` of a provider, which limit the
[signing algorithms](../operate/kms.md#signing-algorithms) of new and imported
key chains, including `KeyChain` documents of a bundle. A bare `kms.json` with
`algorithms` or `defaultAlgorithm` on a provider is read as v2. A
v1 document is migrated unchanged; 9.x cannot read v2 files.

**RegistrarConfig** was removed in EUDIPLO 10.0 together with the sandbox
registrar integration. A `registrar.json` in a tenant folder and a
`RegistrarConfig` document in a bundle are skipped with the warning
`REGISTRAR_CONFIG_REMOVED`; the rest of the import goes on.
`eudiplo config upgrade` leaves `registrar.json` out of the upgraded folder
with a warning; run on a single `RegistrarConfig` document, it fails with the
same message, as there is no current version to upgrade it to.

## Tenant folder layout

Startup import reads `CONFIG_FOLDER` (`/app/config/config` in the image). Every
directory in it, including symlinked ones, is a tenant folder, except one whose
name contains `\` or is `kms.json`, which is skipped with a warning; a tenant
that does not exist yet is created only if its folder contains `info.json`.

```text
<CONFIG_FOLDER>/
├── kms.json                    global KMS providers
└── <tenant-id>/
    ├── info.json               Tenant (name, description, session and status-list defaults)
    ├── kms.json                tenant KMS providers, merged over the global file
    ├── key-chain-defaults.json KeyChainDefaults (default key chains: access, authorizationServer)
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

File names are not significant; the ID comes from the document. In `images/`,
the files `.gitkeep`, `.DS_Store`, `Thumbs.db` and `desktop.ini` are not
imported; every other file is an image.

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
| `warnings[]`    | Warnings of the export: migration warnings, and `CLIENT_MANAGED_BY_IDENTITY_PROVIDER` for each client record left out ([see below](#clients-with-another-identity-provider)) |

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
| Retrievable secrets (KMS, webhook and attribute-provider credentials, upstream client secrets of chained authorization servers) | `${…}` placeholder | `SECRET_REQUIRED`        | In a tenant folder set the environment variable of the backend, in a CLI folder import name it in `--allow-env`; in a bundle sent to the API replace the value ([placeholders and the API](#placeholders-and-the-api)). KMS credentials: through the API replace the value; in a tenant folder also list the variable in `KMS_TENANT_VARIABLES` ([KMS placeholders](../operate/kms.md#placeholders-in-a-tenant-kmsjson)) |
| Client secrets (stored as bcrypt hash)                                | `${…}` placeholder                                           | `CLIENT_SECRET_REQUIRED` | Supply a secret, or `"secret": "!generate"` to get a new one once in `generatedSecrets` |
| Private keys of `db` key chains                                       | `keySource: { "type": "required", "publicJwk": … }`          | `PRIVATE_KEY_REQUIRED`   | Supply `private-jwk`, or `{ "type": "regenerate" }` for new key material |
| Keys in an external KMS                                               | `keySource: { "type": "external-reference", provider, externalKeyId, publicJwk }` | -  | The target provider must reach the same key; checked by signing a challenge, in the plan (not for a key chain the plan leaves `unchanged`) and again on import; only on import (plan warning `KMS_PREFLIGHT_DEFERRED`) when the bundle contains a `KmsConfig` and that makes the provider the tenant's own or the key cannot sign with the KMS configuration in place; without a `KmsConfig` in the bundle, a key that cannot sign blocks the plan (`KMS_REFERENCE_UNAVAILABLE`). On a provider the tenant shares with other tenants, a bundle sent to the API can only name a key the tenant's key chains already hold ([shared providers](../operate/kms.md#keys-of-a-provider-that-tenants-share)) |
| Sessions, status values, caches                                       | not exported                                                 | -                        | -                                                                     |

A secret that is not set, such as the API key of a webhook endpoint without authentication, is left out of the export and adds no requirement. Exception: with Keycloak (`OIDC` set and `OIDC_PROVIDER` unset or `keycloak`), Keycloak holds the client secrets, so every client gets the placeholder and `CLIENT_SECRET_REQUIRED`.

`regenerate` keeps the key chain ID but creates a new cryptographic identity:
certificates and anything bound to the old key must be renewed. In `upsert` and
`replace` mode it does so again whenever the document changed
([which documents count as unchanged](#import-modes-and-plan-actions)).

A `private-jwk` key source takes one of two forms:

- With only `jwk`, the document is imported like
  [`POST /api/key-chain/import`](../trust/keys-and-certificates.md#import-a-key-and-certificate)
  and accepts only that request's fields; the plan blocks the resource when
  `d` is missing or does not belong to `x` and `y`. To restore an exported internal
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
substituted once and not interpreted again. `$${` is the escaped form of the
text `${` ([placeholders and the API](#placeholders-and-the-api)). In tenant folders, unresolved
placeholders are handled according to `CONFIG_VARIABLE_STRICT`:

| Value                    | Effect                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `skip` (default), `abort`, `true` | Error; the import of this tenant fails, other tenants continue |
| `ignore`, `false`        | Warning; a placeholder inside a longer value stays as literal text, and a value that is only a placeholder blocks that resource with `SECRET_REQUIRED` |

### Variables a file can use

A placeholder can name an environment variable of your own, such as `${SHOP_BACKEND_SECRET}`, with the exceptions in the table below.
The variables that configure EUDIPLO itself
([environment variables](environment-variables.md)) are not available to
configuration files, so that a file cannot hand a secret such as
`MASTER_SECRET` to a URL it names. The same holds in the files of a tenant
folder other than `kms.json` for the credentials the AWS SDK and the Azure
identity library read from the environment for the instance, unless the
operator's [secret policy](../operate/secret-references.md#placeholders-in-tenant-folders)
lists one by name:

| Variable                                   | Tenant folder files | Tenant `kms.json`                               | Global `kms.json` |
| ------------------------------------------ | ------------------- | ----------------------------------------------- | ----------------- |
| `PUBLIC_URL`                               | resolved            | resolved                                        | resolved          |
| `VAULT_ADDR`, `VAULT_TOKEN`, `AWS_REGION`  | refused             | refused                                         | resolved          |
| Every other variable of EUDIPLO            | refused             | refused                                         | refused           |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AZURE_CLIENT_SECRET`, `AZURE_CLIENT_CERTIFICATE_PASSWORD`, `AZURE_PASSWORD` | refused, unless `templates.tenant` lists it by name | resolved only if listed in `KMS_TENANT_VARIABLES` | resolved |
| Your own variables                         | resolved, or only if listed in `templates.tenant` of the [secret policy](../operate/secret-references.md#placeholders-in-tenant-folders) | resolved only if listed in `KMS_TENANT_VARIABLES` | resolved        |

A file that names a refused variable is rejected, with every value of
`CONFIG_VARIABLE_STRICT` and also for `${VAR:default}`: in a tenant folder the
import of this tenant fails, also when the file is the tenant's `kms.json`,
which in addition is not loaded for key operations
([KMS placeholders](../operate/kms.md#placeholders-in-a-tenant-kmsjson)). A
tenant `kms.json` with `${VAR:default}` fails the import in the same way:
`kms.json` has no default form. So does one with a placeholder in
`defaultProvider` or the `id` of a provider, whatever the variable. To
use the value of a refused variable, set a variable of your own to the same
value and name that one; if the secret policy sets `templates.tenant`, list
that variable there too.

### Placeholders and the API

Placeholders belong to files. A value stored through the API is text, also when
it contains `${VAR}`: nothing resolves it.

- **Escaped form.** In a configuration file, `$${` stands for the two
  characters `${` and starts no placeholder: `"Price $${AMOUNT}"` is the text
  `Price ${AMOUNT}`. An export writes every `${` of a stored value this way, also in a
  resource ID and in the file name of an uploaded image, and `info.json` is
  read the same way,
  so that the export, placed in a tenant folder, gives the text back and reads
  no variable of the backend. The placeholders the export itself writes for
  secrets ([secret and key policy](#secret-and-key-policy)) are not escaped.
  A `kms.json` has no escaped form.
- **Bundles sent to the API.** The API reads a bundle as a file but resolves
  no placeholder from the backend's environment. A value that is a
  placeholder and nothing else, also `${VAR:default}`, is planned with the
  issue `SECRET_REQUIRED`, which blocks the resource: replace it with the
  value. A placeholder inside a longer value is stored as text, with the plan
  warning `PLACEHOLDER_STORED_AS_TEXT`: replace it with the value, or write
  `$${` to say that you mean the text.
- **Requests that create or update a resource**, such as
  `POST /api/issuer/webhook-endpoints`, are no files: they store the value as
  sent, and `$${` has no meaning there. `GET /api/key-chain/{id}/export`
  and `GET /api/trust-list/{id}/export` return configuration files, so a
  value that contained `${` reads `$${` in them, and a create request
  stores that as sent. To bring such an export back through the API without
  changing it, send it as a document in a bundle, which reads the escaped
  form.
- **The KMS configuration** follows its own rule
  ([KMS placeholders](../operate/kms.md#placeholders-in-a-tenant-kmsjson)).

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
| `skip`      | Exists and is left alone: in `create` mode (`RESOURCE_EXISTS`), in a startup import when the resource was detached from that folder (`RESOURCE_DETACHED`) or has a newer stored generation (`STALE_GENERATION`), or because it is the tenant's encryption key chain (`KEY_CHAIN_ID_RESERVED`), or a client record that `replace` keeps with `OIDC_PROVIDER=generic` (`CLIENT_MANAGED_BY_IDENTITY_PROVIDER`, [see below](#clients-with-another-identity-provider)) |
| `delete`    | Will be removed (`replace` mode)                                                            |
| `blocked`   | Cannot be applied, for example `STALE_GENERATION`, `MISSING_RESOURCE_REFERENCE`, `STATUS_LIST_LAYOUT_IMMUTABLE`, `REGISTRATION_CERTIFICATE_REFUSED` for an imported registration certificate that fails its checks, for example because it is expired or does not cover the DCQL query ([Validation](../trust/registration-certificates.md#validation)), a missing secret or key, `UNSUPPORTED_KEY_ALGORITHM` for a key chain whose key uses an algorithm its KMS provider does not offer ([Signing algorithms](../operate/kms.md#signing-algorithms)), `KMS_CONFIG_FOLDER_MISSING` on a `KmsConfig` document for a tenant whose ID is no folder name ([Per-tenant providers](../operate/kms.md#per-tenant-providers)), `KMS_PLACEHOLDER_REFUSED` on a `KmsConfig` document that brings in a `${VAR}` placeholder or keeps one the tenant cannot load ([Placeholders in a tenant `kms.json`](../operate/kms.md#placeholders-in-a-tenant-kmsjson)), `KMS_SETTING_REFUSED` on a `KmsConfig` document that brings in a PKCS#11 `library` or an mTLS file, names one that is not listed in `KMS_TENANT_FILES`, brings in an `aws-kms` provider without credentials or keeps one while `KMS_TENANT_AWS_DEFAULT_CREDENTIALS` is not set, sets a `keysPath`, `healthPath` or `apiPath` that leaves the provider's `baseUrl`, names a server the outbound URL policy refuses, or names a secret reference the secret policy does not let the tenant use for that server ([Secret references in a tenant `kms.json`](../operate/kms.md#secret-references-in-a-tenant-kmsjson)) ([servers in a tenant `kms.json`](../operate/kms.md#servers-in-a-tenant-kmsjson); [Files and AWS credentials in a tenant `kms.json`](../operate/kms.md#files-and-aws-credentials-in-a-tenant-kmsjson)), `KMS_REFERENCE_REFUSED` on a `KeyChain` document that refers to a key of a shared KMS provider that no key chain of the tenant holds, `KMS_PROVIDER_IN_USE` on a `KmsConfig` document, or on the removal of the tenant's `kms.json` by `replace`, that would take a provider of the tenant's own from the key chains that use it ([Keys of a provider that tenants share](../operate/kms.md#keys-of-a-provider-that-tenants-share)), `CLIENT_MANAGED_BY_IDENTITY_PROVIDER` on a `Client` document with `OIDC_PROVIDER=generic` ([see below](#clients-with-another-identity-provider)), `TRUST_LIST_IN_USE` on a trust list that `replace` would delete while a configuration still references it ([Delete a trust list](../trust/trust-lists.md#delete-a-trust-list)), `MISSING_RESOURCE_REFERENCE` on a presentation configuration that names, or the issuance configuration that adds, an OpenID Federation trust anchor neither the tenant nor the bundle registers, `FEDERATION_TRUST_ANCHOR_IN_USE` on a trust anchor that the import would delete or give another entity ID while a configuration still names it ([Delete a trust anchor](../trust/federation.md#delete-a-trust-anchor)), `KEY_CHAIN_IN_USE` on a key chain that `replace` would delete while a configuration still names it ([Delete a key chain](../trust/keys-and-certificates.md#delete-a-key-chain)), or `KEY_CHAIN_USAGE_MISMATCH` on the key chain defaults (`KeyChainDefaults`) when an entry names a key chain of another usage type ([Default access key chain](../trust/keys-and-certificates.md#default-access-key-chain)), on the issuance configuration when a `token.signingKeyId` it sets names no `authorizationServer` key chain ([Authorization server key chain](../trust/keys-and-certificates.md#authorization-server-key-chain)), or on a trust list when an internal entity names a key chain of another usage type in `issuerKeyChainId` or `revocationKeyChainId` that the stored list does not already name there and the import does not skip the list, or when the key chain that signs a list the import writes, in `keyChainId` or kept from the stored list, has no usage type `trustList` ([Trust lists](../trust/trust-lists.md#publish-a-managed-trust-list)). `KEY_CHAIN_USAGE_MISMATCH` takes the usage type from a `KeyChain` document of the bundle that the import writes, else from the stored key chain; a `KeyChain` document the plan skips does not count. One blocked item blocks the whole plan |

An `update` item lists its field changes in `changes`: the `path` in the document, the stored value as `before` and the value after the import as `after`. Without `before`, the import adds the field; without `after`, it removes the stored value. Entries with `redacted: true` hide the values: a secret reads `[redacted]`, and a value that changes between an object, a list and a plain value reads `[changed]` on both sides.

A `KmsConfig` or `KeyChainDefaults` document replaces the stored resource: fields it leaves out are removed, and the plan lists their removal. A `KeyChain` document replaces the stored key material, and also the type, description and rotation policy:

- The plan lists `type` as the import creates it, also for a document without `type` ([KeyChain v2](#resource-types-and-versions)).
- A `description` it leaves out is removed.
- Without `rotationPolicy`, rotation is disabled.
- A rotation value it leaves out or sets to `null` is not set. Exception: a `private-jwk` key source without `activeJwk` is imported like `POST /api/key-chain/import`, so with rotation enabled a missing `intervalDays` becomes 90 and a missing `certValidityDays` 365, and with rotation disabled no intervals are stored.

The plan lists these values as they will be stored. For the other kinds, a top-level field the document leaves out keeps its stored value.

A `KeyChain` document that is identical to the one last applied from the same source (the same config folder, or bundles whose manifest names the same tenant) plans `unchanged` while the key chain is `file-managed`, without comparing it with the stored key chain: importers add key IDs, EUDIPLO creates the signing key of a CA key, and rotation or a certificate from a registrar replace keys and certificates later. These changes stay, so certificates EUDIPLO created during the import are only renewed by rotation. A document applied under an earlier format version, for example a KeyChain v1 file that 9.x applied, is still identical when its migration to the current format changes only `$schema`; a migration that rewrites `spec` or `metadata` makes it a changed document. Reattaching always applies the folder version. To apply an unchanged document again, for example to regenerate a key, raise `metadata.generation`; in a bundle, also update the document's `sha256` in `manifest.json`.

The same rule covers a `Client` document with `"secret": "!generate"`, since applying it generates a new secret: once this source applied it, the client keeps its secret while the document stays the same. A changed document, a raised `metadata.generation`, another source or reattaching generates a new secret, returned once in `generatedSecrets`. Other `Client` documents are compared field by field. With Keycloak (`OIDC` set and `OIDC_PROVIDER` unset or `keycloak`), every `Client` document is applied on every import, because the plan cannot see changes made in Keycloak; a `!generate` client applied as it is keeps its secret.

The tenant's encryption key chain is managed by EUDIPLO and is not configuration: exports leave it out, and plans neither change nor delete it. A `KeyChain` document with its ID, such as the one exports of earlier versions contain, is skipped (warning `KEY_CHAIN_ID_RESERVED`).

The import pipeline is: decode, verify checksums, migrate to the current
versions, validate, check references and external keys, plan, apply in
dependency order (for example key chains before issuance configs), record
`file-managed` ownership. Applying needs the `planFingerprint` of the reviewed
plan; a changed bundle, mode or target state fails with `CONFIG_PLAN_STALE`.
Status lists keep their capacity and bit size: import a new list ID for a
different layout. A new list holds at most 1,000,000 statuses: a
`StatusList` document that would create one with a larger `capacity` is a plan
error (`STATUS_LIST_CAPACITY_OUT_OF_RANGE`), and a `Tenant` document whose
`statusListConfig.capacity` is larger fails validation
(`CURRENT_SCHEMA_VALIDATION_FAILED`). A document for a list that already
exists keeps its size, also above the limit. A new list without `capacity`
takes the tenant default; if a stored default is above 1,000,000, applying the
list fails with `CONFIG_APPLY_FAILED`.

### Clients with another identity provider

With `OIDC_PROVIDER=generic`, the identity provider manages the clients, so bundles and config folders carry none:

- An export leaves clients out and adds the warning `CLIENT_MANAGED_BY_IDENTITY_PROVIDER` for each client record left from an earlier mode. `GET /api/config-bundles/resources/Client/:id/document` answers `501`.
- A `Client` document blocks the plan with `CLIENT_MANAGED_BY_IDENTITY_PROVIDER`. In a config folder, a file under `clients/` fails the import of its tenant until you delete it; create the client in the identity provider instead.
- `replace` keeps a client record that its source no longer has: the plan lists it as `skip` with the warning `CLIENT_MANAGED_BY_IDENTITY_PROVIDER`. Such a record only adds limits to the tokens of its client ([External OIDC provider](../operate/tenants-and-access.md#external-oidc-provider-and-human-users)).

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
resources of that kind, and the roles that include them, so screens can lock
file-managed resources for them:

| Kind                                                                    | Also readable with                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `Tenant` (session and status list settings)                            | `issuance:manage`, `presentation:manage`                |
| `KeyChain`, `KeyChainDefaults` (default key chains)                     | `keys:manage`                                           |
| `WebhookEndpoint`, `TrustList`, `FederationTrustAnchor`                 | `issuance:manage`, `presentation:manage`                |
| `IssuanceConfig`, `CredentialConfig`, `AttributeProvider`, `StatusList` | `issuance:manage`                                       |
| `PresentationConfig`                                                    | `presentation:manage`                                   |
| `Client`                                                                | `clients:manage`                                        |
| `KmsConfig`                                                             | `keys:export`                                           |

### Single resources

`GET /api/config-bundles/resources/:kind/:id/document` returns one resource as
a document in the current format version: the content of its file in a
[tenant folder](#tenant-folder-layout) or a bundle. Save it as
`<directory>/<id>.json` (for the singletons `info.json`, `kms.json`,
`key-chain-defaults.json` and `issuance/issuance.json`) and, once its `${…}`
placeholders are set, the next import plans it as `unchanged`. The singletons use their fixed IDs `tenant`, `kms`, `defaults`
and `issuance`; the tenant's encryption key chain is not configuration and
answers `404`. The **Download configuration** buttons of the Web Client save
this document as `<id>.json`, and the import of **Settings > Config
Portability** accepts it in place of a bundle.

Secrets are `${…}` placeholders as in a bundle export
([secret and key policy](#secret-and-key-policy)); with the default
`CONFIG_VARIABLE_STRICT=skip`, a folder import fails for that tenant until the
environment variables are set, and for `kms.json` listed in
`KMS_TENANT_VARIABLES`. The Web Client names them after the download.
Image references name
the file, which has to be in the folder's `images/` or already stored on the
target instance. Unlike a bundle, a `KeyChain` document of a key held in the
database keeps its private keys as `keySource: { "type": "private-jwk" }`,
for an internal chain with the signing key in `activeJwk`, so its import
restores the same keys. A `KeyChain` document therefore needs `keys:export`,
which `tenant:admin` includes; the other kinds also accept the roles in the
table above.
