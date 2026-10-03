---
title: KMS Config (kms.json)
---

# KMS Config (`kms.json`)

Fields of the global `<CONFIG_FOLDER>/kms.json`, of a tenant's
`<CONFIG_FOLDER>/<tenant-id>/kms.json` and of the body of
`PUT /api/key-chain/providers/config`, generated from the backend's validation
schema. How to choose and set up a provider is described in
[Key management (KMS)](../operate/kms.md).

Every object is strict: unknown fields are rejected. String values accept
`${VAR}` and `${VAR:default}` placeholders, resolved from the backend's
environment. `defaultProvider` must match a provider `id`, and provider IDs
must be unique.

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
`auth`.

| Request                         | Body                                         | Response                                                    |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `POST {keysPath}`               | `{ "kid": "<key id>", "alg": "ES256" }`      | `200 { "publicJwk": { "kty": "EC", "crv": "P-256", … } }`   |
| `POST {keysPath}/{kid}/sign`    | `{ "data": "<base64 bytes>", "alg": "ES256" }` | `200 { "signature": "<base64url raw r‖s, 64 bytes>" }`    |
| `DELETE {keysPath}/{kid}`       | -                                            | `204`                                                       |
| `GET {healthPath}`              | -                                            | `200` (for example `{ "ok": true }`)                        |
| `POST {keysPath}/{kid}/import`  | `{ "privateJwk": { … }, "alg": "ES256" }`    | `200 { "publicJwk": { … } }`; only called with `canImport: true` |

`keysPath` defaults to `/keys`, `healthPath` to `/health`.

## Cloud Signature Consortium (`csc`)

<SchemaReference name="kms-provider-csc" />
