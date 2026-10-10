---
title: Encryption Keys
---

# Encryption Keys

Choose where the key for data at rest comes from and keep it stable. EUDIPLO
encrypts private keys, secrets in the configuration and personal session data in
the database with AES-256-GCM under one 256-bit key, which the backend loads at
startup from `ENCRYPTION_KEY_SOURCE`.

## What is encrypted

| Table                              | Columns                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Key chains                         | `rootJwk`, `activeJwk`, `previousJwk` (private keys of `db` key chains)                  |
| Registrar configuration            | `password`, `clientSecret`                                                              |
| Webhook endpoints, attribute providers | The API key in `auth` (`config.value`)                                              |
| Issuance configuration             | The upstream client secret of chained authorization servers in `authorizationServers`  |
| Sessions                           | `credentials` (verified presentations), `credentialPayload` (offer claims), `offer`, `auth_queries`, `responseEncryptionPrivateJwk` (per-request key that decrypts the wallet response), the webhook API key in `parsedWebhook` |
| Interactive authorization sessions | `authorizationDetails`, `presentationData`, `completedStepsData`                         |
| Chained authorization sessions     | `upstreamIdTokenClaims`, `upstreamAccessTokenClaims`                                    |

In JSON columns that mix settings and secrets, only the secret value is
encrypted, so the rest of the setting stays readable in the database. Refresh
tokens, authorization codes and pre-authorized codes of the built-in and chained
authorization servers are stored as SHA-256 hashes and API client secrets as
bcrypt hashes. The pre-authorized code is still part of the encrypted `offer`,
which the wallet fetches. Public keys, certificates and the
rest of the configuration are stored in plain text. Keys in an
external [KMS](kms.md) never reach the database. Secrets stored by 8.x are
encrypted by a migration on the first start of 9.0.

The same key also derives the HMAC key for the pseudonymous subject keys of the
single-active-credential policy, so the slot of a returning user is found again
without storing their identity.

## Choose a key source

| `ENCRYPTION_KEY_SOURCE` | Key comes from                                                    | Use                                     |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `env` (default)         | Derived from `MASTER_SECRET` with HKDF-SHA256                     | Any installation, no extra service      |
| `vault`                 | A HashiCorp Vault KV v2 secret                                    | Optional, key managed in Vault          |
| `aws`                   | An AWS Secrets Manager secret                                     | Optional, on AWS                        |
| `azure`                 | An Azure Key Vault secret                                         | Optional, on Azure                      |

The default needs no secret store: keep `MASTER_SECRET` random and as protected
as the database credentials, because whoever has both `MASTER_SECRET` and a copy
of the database can decrypt the stored data. An external key source is an
optional extra step: with `vault`, `aws` and `azure` the key exists only in the
backend's memory, not in its environment, and `MASTER_SECRET` no longer protects
stored data. The key must be 32 bytes, stored as base64 (44 characters) or hex
(64 characters):

```bash
openssl rand -base64 32
```

### Vault

```env
ENCRYPTION_KEY_SOURCE=vault
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=<token with read access to the path>
VAULT_ENCRYPTION_KEY_PATH=secret/data/eudiplo/encryption-key   # default
```

```bash
vault kv put secret/eudiplo/encryption-key key="$(openssl rand -base64 32)"
```

The backend reads `<VAULT_ADDR>/v1/<VAULT_ENCRYPTION_KEY_PATH>` and expects the
key in the field `key`. `VAULT_ADDR` and `VAULT_TOKEN` can also be referenced as
`${VAULT_ADDR}`/`${VAULT_TOKEN}` from `kms.json`, but Vault as a key provider for
signing keys is configured separately in [KMS](kms.md).

### AWS Secrets Manager

```env
ENCRYPTION_KEY_SOURCE=aws
AWS_REGION=eu-central-1
AWS_ENCRYPTION_SECRET_NAME=eudiplo/encryption-key
AWS_ENCRYPTION_SECRET_KEY=key     # JSON field, default "key"
```

```bash
aws secretsmanager create-secret --name eudiplo/encryption-key \
  --secret-string "$(openssl rand -base64 32)"
```

The secret can be the plain key, a JSON object with the key in
`AWS_ENCRYPTION_SECRET_KEY`, or a 32-byte binary secret. Credentials come from
the AWS SDK default chain (IAM role, IRSA, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).

### Azure Key Vault

```env
ENCRYPTION_KEY_SOURCE=azure
AZURE_KEYVAULT_URL=https://myvault.vault.azure.net
AZURE_ENCRYPTION_SECRET_NAME=eudiplo-encryption-key
```

```bash
az keyvault secret set --vault-name myvault --name eudiplo-encryption-key \
  --value "$(openssl rand -base64 32)"
```

Credentials come from `DefaultAzureCredential` (managed identity, or
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`).

**Checkpoint:** with `LOG_LEVEL=info` (the image logs only warnings by default),
the startup log shows `Initializing encryption with key provider: <source>`,
and for `vault`, `aws` and `azure` a short key fingerprint. All replicas must
log the same fingerprint.

## Keep the key stable

There is no key rotation: the backend does not re-encrypt stored data. If the
key changes, or with `env` the `MASTER_SECRET` changes:

- private keys of `db` key chains and stored session data can no longer be
  decrypted,
- the single-active-credential policy no longer recognizes earlier subjects, so
  their existing credentials stop counting against the limit,
- with the built-in OAuth2 server, all management tokens become invalid
  (they are signed with `MASTER_SECRET`).

Store the key, or `MASTER_SECRET`, in your secret manager with versioning, and
include it in the [backup plan](production-checklist.md#backups): a database
backup is useless without it.

## Switch to an external key source

The data encrypted so far is bound to the current key. To move from `env` to
`vault`, `aws` or `azure` without losing data, the external secret must contain
the key that `env` derived from your `MASTER_SECRET`, which you can compute
offline:

```bash
node -e 'const c=require("node:crypto");console.log(Buffer.from(c.hkdfSync("sha256",process.argv[1],"","eudiplo-encryption-at-rest",32)).toString("base64"))' "$MASTER_SECRET"
```

Store the output as the key in the external source, then switch
`ENCRYPTION_KEY_SOURCE`. Test the procedure on a copy of the database first.
