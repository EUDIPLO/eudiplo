---
title: KMS Config (kms.json)
---

# KMS Config (`kms.json`)

Fields of the global `<CONFIG_FOLDER>/kms.json`, of a tenant's
`<CONFIG_FOLDER>/<tenant-id>/kms.json` and of the body of
`PUT /api/key-chain/providers/config`, generated from the backend's validation
schema. How to choose and set up a provider is described in
[Key management (KMS)](../operate/kms.md).

Every object is strict: unknown fields are rejected. In the two files, string
values accept `${VAR}` placeholders (upper-case letters, digits and `_`),
resolved from the backend's environment; a file that references an unset or
empty variable is rejected. So is a file that references a variable it may not
use: a tenant file resolves only the variables listed in
`KMS_TENANT_VARIABLES` and never in `defaultProvider` or the `id` of a
provider, and neither file resolves the variables of EUDIPLO
itself, apart from a few
([variables a file can use](config-bundle-format.md#variables-a-file-can-use)).
The body of `PUT /api/key-chain/providers/config` accepts no new placeholders
([placeholders in a tenant `kms.json`](../operate/kms.md#placeholders-in-a-tenant-kmsjson)).
A tenant file can also name a PKCS#11 `library` or an mTLS file only if
`KMS_TENANT_FILES` lists it, and its `aws-kms` providers need `accessKeyId` and
`secretAccessKey` unless `KMS_TENANT_AWS_DEFAULT_CREDENTIALS` is set
([files and AWS credentials in a tenant `kms.json`](../operate/kms.md#files-and-aws-credentials-in-a-tenant-kmsjson)).
The servers of its providers must pass the outbound URL policy
([servers in a tenant `kms.json`](../operate/kms.md#servers-in-a-tenant-kmsjson)).
Unlike configuration import files, `kms.json` has no `${VAR:default}` syntax. `defaultProvider` must match a provider `id`, and
provider IDs must be unique.

Both files are either the bare content below or a `KmsConfig` document with
`$schema` (`https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json`, older
versions are migrated) and the content in `spec`; see
[Document envelope](config-bundle-format.md#document-envelope). A document of
another kind is rejected.

import SchemaReference from "@site/src/components/SchemaReference";

## File

<SchemaReference name="kms-config" maxDepth={1} />

Each entry of `providers` has one of the shapes below, selected by `type`.

## Database (`db`)

<SchemaReference name="kms-provider-db" />

## HashiCorp Vault (`vault`)

<SchemaReference name="kms-provider-vault" />

## AWS KMS (`aws-kms`)

<SchemaReference name="kms-provider-aws-kms" />

## PKCS#11 (`pkcs11`)

<SchemaReference name="kms-provider-pkcs11" />

## Remote HTTP service (`http`)

<SchemaReference name="kms-provider-http" />

### HTTP provider API

A service used as `http` provider implements these endpoints relative to
`baseUrl`. Bodies are JSON; requests carry the authentication configured in
`auth`. A reference service that keeps keys in memory and supports only `ES256`, for
development only, is in [EUDIPLO/examples](https://github.com/EUDIPLO/examples/tree/main/kms-reference).

| Request                         | Body                                         | Response                                                    |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `POST {keysPath}`               | `{ "kid": "<key id>", "alg": "ES256" }`      | `200 { "publicJwk": { "kty": "EC", "crv": "<curve of alg>", … } }` |
| `POST {keysPath}/{kid}/sign`    | `{ "data": "<base64 bytes>", "alg": "ES256" }` | `200 { "signature": "<base64url raw r‖s, 64, 96 or 132 bytes>" }`    |
| `DELETE {keysPath}/{kid}`       | -                                            | `204`                                                       |
| `GET {healthPath}`              | -                                            | `200` (for example `{ "ok": true }`)                        |
| `POST {keysPath}/{kid}/import`  | `{ "privateJwk": { … }, "alg": "ES256" }`    | `200 { "publicJwk": { … } }`; only called with `canImport: true` |

`keysPath` defaults to `/keys`, `healthPath` to `/health`. Both must be paths
on the server of `baseUrl`, as must `apiPath` of a `csc` provider
([Key management](../operate/kms.md#files-and-aws-credentials-in-a-tenant-kmsjson)).

`alg` is `ES256`, `ES384` or `ES512`; the provider's `algorithms` decide which
ones EUDIPLO sends for new and imported keys (only `defaultAlgorithm`, `ES256`
unless set, if `algorithms` is missing). The returned `publicJwk` must be on the matching curve
(P-256, P-384 or P-521), otherwise the key is refused. `sign` hashes `data` with
SHA-256, SHA-384 or SHA-512 and returns the raw `r‖s` of 64, 96 or 132 bytes.

## Cloud Signature Consortium (`csc`)

<SchemaReference name="kms-provider-csc" />
