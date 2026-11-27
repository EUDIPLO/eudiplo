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
unset variable stops the startup, and so does a variable the file may not use
([variables a file can use](../reference/config-bundle-format.md#variables-a-file-can-use)).
The schema is strict, so unknown fields are rejected.

`eudiplo init` and `eudiplo demo` write it as a `KmsConfig` document with this
content in `spec` ([file forms](../reference/kms-config.md)).

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
default credential chain (IAM role, IRSA); in a tenant `kms.json` this needs
`KMS_TENANT_AWS_DEFAULT_CREDENTIALS` ([files and AWS credentials in a tenant `kms.json`](#files-and-aws-credentials-in-a-tenant-kmsjson)). The backend calls `CreateKey` (with a
tag, so `kms:TagResource` is needed as well), `GetPublicKey`, `Sign`,
`ScheduleKeyDeletion` and, for the health check, `ListKeys`.

**PKCS#11.** The vendor's PKCS#11 library must be available in the backend
container, and for a provider in a tenant `kms.json` listed in
`KMS_TENANT_FILES`. The backend's non-root user must be able to read it, and
for a software HSM such as SoftHSM also write its token folder
([Non-root user](docker-compose.md#non-root-user)); `slot` is the slot index or the token label. `readOnly: true` opens a
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
or `mtls`. A service without authentication (`none`) serves everyone who
reaches its address; [tenants are kept from the addresses of your
network](#servers-in-a-tenant-kmsjson) only while
`OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is off. The endpoints your service must
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
The backend reads a tenant file again whenever the file changed, so a file you
write yourself applies from the tenant's next key operation, without a restart
(the global `kms.json` is read at startup only). A file that is invalid or
half written applies at once too, and the tenant's key operations fail until
it is valid: write a temporary file and rename it. While the file is not JSON
or no valid KMS configuration, the tenant's key operations,
`GET /api/key-chain/providers/config` and the export and the plan of a
configuration bundle, which an import needs, answer `400` with the reason.
`PUT /api/key-chain/providers/config` replaces such a file and `DELETE`
removes it; `PUT` keeps nothing of it, so it answers `400` for `<redacted>`,
a placeholder or a file of the backend's host. For a file
that is not JSON, the reason gives the line and column where reading stopped
when the parser reports them, never text of the file, and the startup log
names the file only when the backend sees it for the first time. A file you
write while the backend runs is not in the startup log; a problem with it is
logged as a warning when the tenant next needs a key. When a tenant file changes, the
backend connects to the tenant's providers anew. For `pkcs11`, `aws-kms` and
`http` providers with mTLS, operations that already run have one minute to
finish on the earlier connections, which are then closed (for PKCS#11: the
session); one that still runs after that fails and can be retried. With
several backend replicas, mount the same `CONFIG_FOLDER` volume into all of them: a tenant file exists
only where it was written, and a replica that does not see it would use the
global provider with the same `id` for the tenant's key chains.

Manage it through the API (role `keys:export`, which `tenant:admin` and
`tenants:manage` include, because the configuration contains provider
credentials):

| Request                                     | Effect                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/key-chain/providers/config`       | `tenantConfig` (the tenant file or `null`) and `effectiveConfig` (merged) |
| `PUT /api/key-chain/providers/config`       | Validate and write the tenant file, body as in `kms.json`                 |
| `DELETE /api/key-chain/providers/config`    | Remove the tenant file; the global configuration applies again. `409` while key chains use a provider of its own ([shared providers](#keys-of-a-provider-that-tenants-share)) |

The API never returns credentials (`vaultToken`, `secretAccessKey`, `pin`,
`auth.token`, `auth.clientSecret`, `clientSecret`, `sad` and
`authorizeAuthData[].value`); it returns `<redacted>` instead. In
`tenantConfig`, a credential stored as a `${ENV_VAR}` placeholder is returned as
the placeholder, and one stored as a
[secret reference](#secret-references-in-a-tenant-kmsjson) as the reference. In `effectiveConfig`, the tenant's providers appear as in
`tenantConfig`, so a placeholder of the tenant file is never returned as the
variable's value; providers of the global file appear with their non-secret
settings only.

A `PUT` replaces the whole tenant file. To keep a stored credential, send
`<redacted>` back unchanged: it is replaced by the stored value of the provider
with the same `id` and `type`. Any other value replaces the credential.
`<redacted>` for a credential the tenant file does not store, for example of a
global provider copied from `effectiveConfig`, is rejected with `400`. So are a
`${VAR}` placeholder ([below](#placeholders-in-a-tenant-kmsjson)), a PKCS#11
`library` or mTLS file, and an `aws-kms` provider without credentials
([below](#files-and-aws-credentials-in-a-tenant-kmsjson)), and a server the
outbound URL policy refuses ([below](#servers-in-a-tenant-kmsjson)).

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
placeholders; replace them with the values before you import the bundle.

### Placeholders in a tenant `kms.json`

A placeholder makes the backend read a variable of its own environment and
send the value to the provider the file names. A tenant's administrators can
write that file through the API, so three rules keep them away from the
instance's environment:

- **Only listed variables resolve.** A tenant `kms.json` resolves your own
  variables only if `KMS_TENANT_VARIABLES` names them, for example
  `KMS_TENANT_VARIABLES=TENANT_A_VAULT_TOKEN,TENANT_B_VAULT_TOKEN`. It is empty
  by default. Variables of EUDIPLO itself cannot be listed (the backend then
  does not start); only `PUBLIC_URL` resolves without it
  ([variables a file can use](../reference/config-bundle-format.md#variables-a-file-can-use)).
  This applies to every tenant `kms.json`, whoever wrote it. A file that names
  another variable is not loaded: the tenant's key operations and
  `GET /api/key-chain/providers/config` answer `400` with the variable's name,
  the startup import of that tenant's folder and a reattach of its KMS
  configuration fail, and the backend logs the file at startup. The tenant can still replace the
  file with `PUT` or remove it with `DELETE`.
- **The API accepts no new placeholders.** `PUT /api/key-chain/providers/config`
  and the import of a configuration bundle reject a value that contains
  `${VAR}` with `400` (plan issue `KMS_PLACEHOLDER_REFUSED`), also for a listed
  variable: every tenant could otherwise use every variable on the list. Write
  placeholders to `<CONFIG_FOLDER>/<tenant-id>/kms.json` yourself, or have
  the tenant send the value. A value that the stored file
  already holds in the same field of the provider with the same `id` and
  `type` is accepted unchanged, as long as the settings that say where the
  provider's credentials are sent (listed above) stay the same and its
  variable is listed and set. This does not hold for an identifier (next
  rule).
- **No placeholder in an identifier.** `defaultProvider` and the `id` of a
  provider cannot contain a placeholder, also not for a listed variable and
  not in a file you wrote: the API returns identifiers as they are. Such a
  file is not loaded, with the same effects as for a variable that is not
  listed.

The list is not per tenant: whoever can write a tenant's `kms.json` on disk,
for example through a Git repository of tenant folders, can use every listed
variable.

### Secret references in a tenant `kms.json`

With a [secret policy](secret-references.md), a credential of a provider
(`vaultToken`; `auth.token` and `auth.clientSecret` of `http`; `clientSecret`,
`sad` and `authorizeAuthData[].value` of `csc`; `secretAccessKey` of
`aws-kms`; `pin` of `pkcs11`) can be a secret reference such
as `${vault:kv/eudiplo/acme/kms#token}`. Unlike a `${VAR}` placeholder, the
tenant may write one through the API, because the policy, not the tenant,
decides what it may name:

- The tenant chooses both the reference and the server the credential goes to,
  so only references in its own namespace are accepted. Its own secrets may go
  to any server the outbound URL policy allows. A secret of the instance or of
  another tenant is outside its namespace and is refused with `400` (plan issue
  `KMS_SETTING_REFUSED`). An operator secret it may use only for one server is
  a `bound` grant, checked against the server the credential is sent to
  (`vaultUrl`, `baseUrl`, `auth.tokenUrl`, `tokenUrl`; the region's endpoint
  for `aws-kms`). A PKCS#11 `pin` goes to a library of the host, no server, so
  it can only be a reference of the tenant's own namespace.
- A provider with a reference counts as shared, like one with a `${VAR}`
  placeholder, also without a secret policy (then the text is a literal
  credential): EUDIPLO keeps the tenant to its own keys on it
  ([shared providers](#keys-of-a-provider-that-tenants-share)).
- The reference is checked again each time the credential is used, so one in a
  file you wrote, or one the policy no longer grants, fails the key operation
  and nothing is sent.
- The value is read when the provider is used and cached for 5 minutes. When it
  changes, EUDIPLO builds the provider anew with the new value; the old one is
  closed 60 seconds later, so running operations can finish.
- `GET /api/key-chain/providers/config` shows a reference of the tenant file
  as written; a literal credential, and every credential of the global file,
  stays `<redacted>`.
- `KMS_TENANT_VARIABLES`, `KMS_TENANT_FILES`, the AWS default credentials and
  the outbound URL policy keep their rules: a reference is no `${VAR}`
  placeholder, no file of the host and no server address.

The global `kms.json` can use references too, under the policy's `instance`
grants.

### Files and AWS credentials in a tenant `kms.json`

Two kinds of settings make the backend use something of its own host or cloud
account: a path (the PKCS#11 `library`, which the backend loads as native
code, and the mTLS `certFile`, `keyFile` and `caFile` of an `http` provider,
which it reads), and an `aws-kms` provider without credentials, for which the
AWS SDK uses the credentials of the backend's environment. The global
`kms.json` can hold all of them. A tenant `kms.json` is limited, like its
placeholders:

- **Only listed files load.** A tenant `kms.json` can name a file only if
  `KMS_TENANT_FILES` lists its absolute path, for example
  `KMS_TENANT_FILES=/usr/lib/softhsm/libsofthsm2.so,/etc/certs/tenant-a.crt,/etc/certs/tenant-a.key`.
  It is empty by default, so a tenant file can hold neither a `pkcs11`
  provider nor mTLS authentication. With an entry that is not an absolute
  path, the backend does not start. The path is compared as written, after
  `.` and `..` are resolved; symbolic links are not followed, so list the path
  the file names.
- **An `aws-kms` provider needs `accessKeyId` and `secretAccessKey`.** To let
  every tenant use the instance's AWS identity, define the provider in the
  global `kms.json`. To give it to single tenants, set
  `KMS_TENANT_AWS_DEFAULT_CREDENTIALS=true` and write the provider without
  credentials to `<CONFIG_FOLDER>/<tenant-id>/kms.json` yourself. The setting
  is not per tenant: every tenant file that holds such a provider then loads.
  A tenant provider with only one of the two values is never loaded.
  All these tenants, and the tenants that use a global `aws-kms` provider,
  act as the same AWS identity; which keys of it a tenant can use is described
  [below](#keys-of-a-provider-that-tenants-share).
- **The API accepts no new file paths and no new use of the AWS identity.**
  `PUT /api/key-chain/providers/config` and the import of a configuration
  bundle reject a `library`, `certFile`, `keyFile` or `caFile` with `400`
  (plan issue `KMS_SETTING_REFUSED`), also for a listed file: every tenant
  could otherwise use every file on the list. Write the provider to
  `<CONFIG_FOLDER>/<tenant-id>/kms.json` yourself. A
  path that the stored file already holds in the same setting of the provider
  with the same `id` and `type` is accepted unchanged, as long as the file is
  still listed; for an `http` provider only while `baseUrl` stays the same,
  so the client certificate is not presented to another server.

  They reject an `aws-kms` provider without credentials in the same way, also
  with `KMS_TENANT_AWS_DEFAULT_CREDENTIALS`. One that the stored file already
  holds without credentials is accepted while the setting is on and its `id`
  and `region` stay the same.

This applies to every tenant `kms.json`, whoever wrote it. A file that breaks
one of the first two rules is not loaded. All key use of that tenant then
answers `400`, also for key chains of other providers such as `db`: issuance,
presentation and status list signing stop until the file is corrected, an
import of key chains from the tenant's folder fails, and so does
`GET /api/key-chain/providers/config`. The backend logs the file at startup,
unless the path is written as a `${VAR}` placeholder: that is checked when the
tenant first needs a key. The tenant can still replace the file with `PUT` or
remove it with `DELETE`.

Two rules hold for every `kms.json`, the global one included:

- An mTLS file is read only if it is a regular file of at most 1 MiB.
  Otherwise the provider cannot be created: key use of the tenant fails, and
  for the global file the backend does not start.
- `keysPath` and `healthPath` of an `http` provider and `apiPath` of a `csc`
  provider must be paths on the server of `baseUrl`, such as `/v1/keys`. A
  value that makes the request go to another server, such as
  `@other.example/keys`, is refused, because the provider's credentials and
  client certificate belong to `baseUrl`: the API answers `400` (plan issue
  `KMS_SETTING_REFUSED`), a stored
  tenant file with such a provider is not loaded, and a global file stops the
  startup.

### Servers in a tenant `kms.json`

A tenant's administrators choose the servers of the providers in their
`kms.json`: `vaultUrl` of a `vault` provider, `baseUrl` and `auth.tokenUrl` of
an `http` provider, `baseUrl` and `tokenUrl` of a `csc` provider. These must
pass the [outbound URL policy](../concepts/security-model.md#https-and-tls),
like a webhook URL: HTTPS, a public address, and a host on
`OUTBOUND_URL_ALLOWED_HOSTS` when that is set. The address is checked again on
every connection, and a redirect is not followed. A request to such a server
must finish within 30 seconds, and its body and answer are limited to 1 MiB
each. These requests do not use the proxy in `HTTPS_PROXY`, so the backend must
reach the server directly. A tenant can therefore not
name a KMS service, a Vault or a metadata endpoint of your network as a
provider of its own.

`PUT /api/key-chain/providers/config` and the import of a configuration bundle
answer `400` (plan issue `KMS_SETTING_REFUSED`) for a server the policy
refuses. A stored tenant `kms.json` with one is not loaded, as described
[above](#files-and-aws-credentials-in-a-tenant-kmsjson), and the backend logs
the file at startup, unless the server is written as a `${VAR}` placeholder.
A host name that resolves to a private address passes
these checks and fails when the provider is used.

With `OUTBOUND_URL_ALLOWED_HOSTS` set, add the hosts of your tenants' KMS
servers to it. Name the final address of a server: one that answers with a
redirect, such as a Vault standby node, fails. For a tenant KMS inside your
network, move the provider to the global `kms.json`, which the policy does not
apply to but which makes it a provider [every tenant
shares](#keys-of-a-provider-that-tenants-share), or set
`OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true` (and `OUTBOUND_URL_ALLOW_HTTP=true`
for a server without TLS). The two settings apply to every outbound URL of the
instance, webhooks included.

### Keys of a provider that tenants share

A key chain names its key by the provider's `id` and the key's name or ID in
that provider. A provider is shared when several tenants reach its keys with
the same credentials:

- every provider of the global `kms.json`, except a `db` provider, whose keys
  are stored with their key chain;
- a provider of a tenant `kms.json` that uses the instance's AWS identity
  (`aws-kms` without credentials), the client certificate of mTLS files, a
  value from a `${VAR}` placeholder, or a secret reference (which may name an
  operator secret other tenants are granted too).

Every other provider of a tenant `kms.json` is the tenant's own, also an
`http` provider without authentication. EUDIPLO does not notice two tenant
files that hold the same credentials: keep those apart yourself.

:::warning A KMS service without authentication, with `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true`

A tenant's administrators choose the `baseUrl` of the `http` providers in
their `kms.json`. The [outbound URL policy](#servers-in-a-tenant-kmsjson)
keeps them from the addresses of your network. If you set
`OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true`, a KMS service there that does not
authenticate the backend serves every tenant that names its address, as that
tenant's own provider, with every key it holds. Give each such service
authentication (`bearer`, `oauth2-client-credentials` or `mtls`), also one of
the global `kms.json`.

:::

On a shared provider, EUDIPLO keeps a tenant to its own keys:

- **A request names only keys the tenant already holds.** A `KeyChain`
  document with an `external-reference` key source, imported through
  `POST /api/config-bundles/import`, must name keys that key chains of the
  tenant on that provider hold. For any other key the plan is blocked
  (`KMS_REFERENCE_REFUSED`), the import answers `400`, and the key signs
  nothing. To attach a key you created in the KMS yourself, put the key chain
  file into `<CONFIG_FOLDER>/<tenant-id>/key-chains/`; the startup import and a
  [reattach](./configuration-as-code.md) of that file accept any key the
  provider reaches.
- **A tenant's own provider does not give way to a shared one under its key
  chains.** While key chains of the tenant use a provider of its own, the
  provider cannot be removed or changed into a shared one. `PUT` and
  `DELETE /api/key-chain/providers/config` answer `409`, and the plan of a
  bundle is blocked (`KMS_PROVIDER_IN_USE`). Delete the key chains first.
  Without this, the key names the tenant chose in its own provider would be
  looked up in a shared provider with the same `id`: the one of the global
  file it replaced, or one you add later. `db` providers are not concerned,
  on either side.
- **EUDIPLO chooses the names of imported keys.** A private key that a
  request imports into a shared provider, with `POST /api/key-chain/import`
  or as a `private-jwk` key source of a bundle, is stored under the name
  `<key chain id>-import-<random>`, not under the `kid` of the imported JWK.
  A standalone key chain publishes that name as its `kid`. In an internal
  chain the imported key is the CA key, and the signing key is a new key
  named `<key chain id>-active-<random>`.

On its own provider a tenant can attach every key its credentials reach. The
rules cover requests, not files: whoever writes a tenant's folder on disk can
name any key of a shared provider.
