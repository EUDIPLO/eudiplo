---
title: Key Management (KMS)
---

# Key Management (KMS)

Choose where the private keys of signing key chains live and configure the
provider in `kms.json`. By default every key is created by the `db` provider and
stored encrypted in the database (see [Encryption keys](encryption-keys.md)).
Every field of `kms.json` is listed in the [KMS config reference](../reference/kms-config.md).

## Choose a provider

| `type`    | Private key lives in                          | Create | Import | Delete | Use it for                                           |
| --------- | --------------------------------------------- | ------ | ------ | ------ | ---------------------------------------------------- |
| `db`      | The EUDIPLO database, encrypted               | yes    | yes    | yes    | Development, small installations                     |
| `vault`   | HashiCorp Vault Transit engine                | yes    | yes    | yes    | Self-hosted production                               |
| `aws-kms` | AWS KMS (`ECC_NIST_P256`, `ECC_NIST_P384` or `ECC_NIST_P521`, `SIGN_VERIFY`) | yes | no | yes (7-day deletion window) | Production on AWS          |
| `pkcs11`  | A hardware security module via PKCS#11        | yes    | no     | yes    | HSMs (SoftHSM, YubiHSM, CloudHSM, …)                 |
| `http`    | Your own remote signing service               | yes    | if `canImport` | yes | Custom key management                         |
| `csc`     | A Cloud Signature Consortium (CSC v2) service | yes    | no     | no     | Qualified remote signing                             |

Encryption keys for credential and response encryption always use the `db`
provider. Keys that cannot be imported must be created in the provider, so plan
the provider before you create key chains.

## Signing algorithms

A signing key chain uses one ECDSA algorithm, which also fixes its curve:
`ES256` (P-256), `ES384` (P-384) or `ES512` (P-521). It is chosen when the key
chain is created (`alg`) or, for an imported key, taken from the key's curve.
Rotation keeps it, and every signature of the key chain (credentials, status
lists, trust lists, tokens, request objects, certificates) uses it.

`ES256` is the default and the only algorithm wallets have to support (HAIP).
Choose `ES384` or `ES512` only when the wallets and relying parties you serve
accept it. This matters most for `access` key chains: they sign OID4VP
request objects and signed issuer metadata, which every wallet must validate,
and EUDIPLO does not ask the wallet which algorithms it supports. Keep access
key chains on `ES256` unless you know every wallet accepts the other algorithm.

What a provider offers for new and imported key chains is set per provider in
`kms.json`:

- `algorithms` lists the algorithms new and imported key chains may use.
  Without it, `db`, `vault` and `aws-kms` offer all three; `pkcs11`, `http` and `csc` offer only
  their `defaultAlgorithm`, because their backends may not support every curve.
  List the curves your token, service or CSC credential supports.
- `defaultAlgorithm` is used when a key chain is created without `alg`. It must
  be in `algorithms`; without it, `ES256` is used if allowed, otherwise the
  first entry of `algorithms`.

```json title="kms.json"
{
    "providers": [
        { "id": "db", "type": "db", "algorithms": ["ES256", "ES384"] },
        {
            "id": "hsm",
            "type": "pkcs11",
            "library": "${PKCS11_LIBRARY}",
            "slot": "${PKCS11_SLOT}",
            "pin": "${PKCS11_PIN}",
            "algorithms": ["ES256", "ES384"],
            "defaultAlgorithm": "ES384"
        }
    ]
}
```

The list also limits every import: `POST /api/key-chain/import`, key-chain
files in the config folder and `KeyChain` documents in a configuration bundle
(private keys, internal chains with private keys, which go into the `db`
provider, and external key references), including an import that replaces an
existing key chain. `POST /api/key-chain/import` refuses a key outside it with
400. A bundle plan checks against the KMS configuration in place and reports
such a key as the blocking issue `UNSUPPORTED_KEY_ALGORITHM`, so the apply
answers 400 `CONFIG_APPLY_BLOCKED` and applies nothing. If the bundle also
contains a `KmsConfig`, the plan only warns with `KMS_PREFLIGHT_DEFERRED`; the
apply checks the key against the new configuration and, when the key is
outside its list, stops at that key chain with `CONFIG_APPLY_FAILED` while
earlier steps, such as the new `KmsConfig`, stay applied
([recovery](./configuration-as-code.md#plans-locks-and-recovery)). An existing key chain
keeps signing and rotating with its algorithm after you remove it from
`algorithms`.
`GET /api/key-chain/providers` returns each provider's offer as
`capabilities.supportedAlgs` and `capabilities.defaultAlg`.

## Configure `kms.json`

The global file is `<CONFIG_FOLDER>/kms.json` (`/app/config/config/kms.json` in
the image, `config/kms.json` in CLI projects). It is read at startup:

```json title="kms.json"
{
    "defaultProvider": "vault",
    "providers": [
        { "id": "db", "type": "db" },
        {
            "id": "vault",
            "type": "vault",
            "description": "Production Vault",
            "vaultUrl": "${VAULT_ADDR}",
            "vaultToken": "${VAULT_TOKEN}"
        }
    ]
}
```

Without the file, only the `db` provider exists. `defaultProvider` (default
`db`) must match a provider `id`; provider IDs must be unique. Write secrets as
`${VAR}` placeholders and set the variables in the backend's environment; an
unset variable stops the startup. The schema is strict, so unknown fields are
rejected.

**Checkpoint:** `GET /api/key-chain/providers` lists the providers and the
default; `GET /api/key-chain/providers/health` reports `ok` for each, and
`eudiplo doctor` includes the same check.

## Provider notes

**Vault.** Only `vaultUrl` and `vaultToken` are supported; there is no AppRole
login. Keys are created in the Transit engine mounted at `transit`, which the
backend enables if it is missing; the mount path is not configurable. Give the
token permissions on `transit/*` (and on `sys/mounts/transit` for the automatic
mount). Since 9.0, Vault holds signing keys only through `kms.json`; the old
`KM_TYPE`, `VAULT_NAMESPACE` and `VAULT_MOUNT_PATH` variables have no effect.
The encryption key for data at rest is a separate setting
([Encryption keys](encryption-keys.md#vault)).

**AWS KMS.** Omit `accessKeyId` and `secretAccessKey` to use the AWS SDK
default credential chain (IAM role, IRSA). The backend calls `CreateKey` (with a
tag, so `kms:TagResource` is needed as well), `GetPublicKey`, `Sign`,
`ScheduleKeyDeletion` and, for the health check, `ListKeys`.

**PKCS#11.** The vendor's PKCS#11 library must be available in the backend
container; `slot` is the slot index or the token label. `readOnly: true` opens a
read-only session, which cannot create or delete keys. Keys are created with
`CKM_EC_KEY_PAIR_GEN` on the curve of the key chain's algorithm and sign with
`CKM_ECDSA` over the matching SHA-2 digest.

**CSC.** A CSC credential holds one key on one curve, so set `algorithms` to
the algorithm of that curve, for example `["ES384"]` for a P-384 credential.
Creating a key chain with another algorithm fails. Without `hashAlgorithmOid`
and `signAlgorithmOid`, the OIDs follow the algorithm (SHA-256/384/512 and
ecdsa-with-SHA256/384/512).

**HTTP.** EUDIPLO calls your service for key generation, signing, deletion and
health. Authenticate it with `auth` of type `bearer`, `oauth2-client-credentials`
or `mtls` (or `none` on a trusted network). The endpoints your service must
implement are specified in the
[reference](../reference/kms-config.md#http-provider-api).

## Create a key in a provider

Choose the provider per key chain with `kmsProvider`; without it the
`defaultProvider` is used:

```bash
curl -X POST https://eudiplo.example.com/api/key-chain \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "usageType": "attestation",
    "type": "standalone",
    "kmsProvider": "vault",
    "alg": "ES256",
    "description": "Credential signing key"
  }'
```

`usageType` is one of the [usage types](../trust/keys-and-certificates.md#usage-types)
of a signing key chain; `type` is `standalone` or `internalChain`; `alg` is one
of the provider's [signing algorithms](#signing-algorithms) and defaults to its
`defaultAlgorithm`. Certificates,
rotation and key import are covered in [Keys and certificates](../trust/keys-and-certificates.md).
A key chain stays with its provider; to move it, create a new key chain in the
target provider and switch the configurations that reference it.

## Per-tenant providers

A tenant can add or override providers without touching the global file. Its
`kms.json` is stored at `<CONFIG_FOLDER>/<tenant-id>/kms.json` and merged over
the global one: providers with the same `id` replace the global entry, and the
tenant's `defaultProvider` wins. A tenant created before 10.0 whose ID is no
folder name has no tenant file and always uses the global configuration; `PUT`
and `DELETE` below answer `400` for it
([upgrade guide](../upgrade/9.x-to-10.0.md#tenants-ids-must-be-a-folder-name)).
Manage it through the API (roles
`tenant:admin` or `tenants:manage`, because the configuration contains provider
credentials):

| Request                                     | Effect                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/key-chain/providers/config`       | `tenantConfig` (the tenant file or `null`) and `effectiveConfig` (merged) |
| `PUT /api/key-chain/providers/config`       | Validate and write the tenant file, body as in `kms.json`                 |
| `DELETE /api/key-chain/providers/config`    | Remove the tenant file; the global configuration applies again            |

The API never returns credentials (`vaultToken`, `secretAccessKey`, `pin`,
`auth.token`, `auth.clientSecret`, `clientSecret`, `sad` and
`authorizeAuthData[].value`); it returns `<redacted>` instead. In
`tenantConfig`, a credential stored as a `${ENV_VAR}` placeholder is returned as
the placeholder. Providers of the global file appear in `effectiveConfig` with
their non-secret settings only.

A `PUT` replaces the whole tenant file. To keep a stored credential, send
`<redacted>` back unchanged: it is replaced by the stored value of the provider
with the same `id` and `type`. Any other value, including a placeholder,
replaces the credential. `<redacted>` for a credential the tenant file does not
store, for example of a global provider copied from `effectiveConfig`, is
rejected with `400`.

A stored credential is also kept only while the setting that says where it is
sent stays the same: `vaultUrl` for `vaultToken`, `baseUrl` for an `http`
bearer `token` and for the CSC `sad` and `authorizeAuthData` values,
`auth.tokenUrl` and `tokenUrl` for OAuth client secrets, and `library` for the
PKCS#11 `pin`. A `PUT` that changes one of these settings must send the
credential again; with `<redacted>` it is rejected with `400`, so that nobody
who may edit the configuration can redirect a credential they cannot read. The
AWS secret access key only signs requests and is kept when `region` changes.

The API needs `CONFIG_FOLDER` to be writable. The tenant `kms.json` is also part
of [configuration bundles](configuration-as-code.md), with secrets exported as
placeholders.
