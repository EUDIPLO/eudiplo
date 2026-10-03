---
title: KMS Configuration
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Configuration File' and the per-provider 'Configuration' schema blocks -> reference/kms-config.md (generated from kms-config.schema.ts)
-->

# Key Management System (KMS) Configuration

EUDIPLO supports pluggable KMS backends for cryptographic key storage and operations. This deep-dive covers technical configuration for each provider.

For key chain concepts and basic usage, see [Key Chains](../trust/keys-and-certificates.md).

## KMS Architecture

EUDIPLO's KMS layer abstracts key operations across multiple backends:

```text
┌───────────────────────────────────────┐
│         EUDIPLO Application            │
├───────────────────────────────────────┤
│         KMS Adapter Interface          │
├───────────────────────────────────────┤
│  DB  │ Vault │ AWS KMS │ PKCS#11 │... │
└───────────────────────────────────────┘
```

Each backend implements the same interface:

- `createKey()` — Generate a new key
- `sign()` — Produce a signature
- `deleteKey()` — Remove a key
- `health()` — Health check

## Configuration File

KMS backends are configured in `kms.json` (global configuration):

```json title="kms.json"
{
    "defaultProvider": "db",
    "providers": [
        { "id": "db", "type": "db" },
        {
            "id": "vault",
            "type": "vault",
            "description": "Production Vault",
            "url": "${VAULT_ADDR}",
            "token": "${VAULT_TOKEN}",
            "transitMount": "transit"
        }
    ]
}
```

- `defaultProvider`: The provider ID used when no explicit `kmsProvider` is specified
- `providers`: Array of available KMS backends

## Supported Providers

| Provider        | Type      | Use Case                        | Private Key Location |
| --------------- | --------- | ------------------------------- | -------------------- |
| **Database**    | `db`      | Development, testing            | Encrypted in DB      |
| **Vault**       | `vault`   | Production (self-hosted)        | Vault Transit        |
| **AWS KMS**     | `aws-kms` | Production (AWS)                | AWS KMS              |
| **PKCS#11**     | `pkcs11`  | HSM integration                 | Hardware module      |
| **HTTP**        | `http`    | Remote microservice             | Remote KMS           |
| **CSC**         | `csc`     | Cloud Signature Consortium      | CSC remote service   |

## Database Provider (`db`)

The default provider stores encrypted private keys in the database.

### Configuration

```json
{
    "id": "db",
    "type": "db"
}
```

No additional configuration needed.

### How It Works

- Keys are generated using Node.js crypto (`generateKeyPair`)
- Private keys are encrypted with AES-256-GCM before storage
- Public JWKs are cached in database for fast access
- Algorithm: **ES256 (ECDSA P-256)** only

### Pros

- ✅ Simple setup (no external dependencies)
- ✅ Fast local operations
- ✅ Suitable for development and testing

### Cons

- ⚠️ Private keys stored in database (encrypted)
- ⚠️ Not FIPS-certified
- ⚠️ Limited for high-security production use

## HashiCorp Vault Provider (`vault`)

Uses Vault's Transit Secrets Engine for key operations.

### Configuration

```json
{
    "id": "vault",
    "type": "vault",
    "url": "${VAULT_ADDR}",
    "token": "${VAULT_TOKEN}",
    "transitMount": "transit",
    "roleId": "${VAULT_ROLE_ID}",
    "secretId": "${VAULT_SECRET_ID}"
}
```

| Field          | Required | Description                                                    |
| -------------- | -------- | -------------------------------------------------------------- |
| `url`          | Yes      | Vault server URL (e.g., `https://vault.example.com:8200`)      |
| `token`        | No\*     | Vault token (either `token` or `roleId`/`secretId` required)   |
| `transitMount` | No       | Transit mount path (default: `transit`)                        |
| `roleId`       | No\*     | AppRole role ID (use with `secretId` instead of token)         |
| `secretId`     | No\*     | AppRole secret ID (use with `roleId` instead of token)         |

\*Either `token` or both `roleId` and `secretId` must be provided.

### Setup Vault

```bash
# Enable Transit engine
vault secrets enable transit

# Create a key
vault write -f transit/keys/my-key type=ecdsa-p256
```

### How It Works

- Keys are generated inside Vault Transit engine
- Private keys **never leave Vault**
- EUDIPLO stores only the key name and cached public JWK
- Signing requests are sent to Vault's `/transit/sign` endpoint

### Pros

- ✅ Private keys never leave Vault
- ✅ Centralized key management
- ✅ Audit logging built-in
- ✅ Key rotation support

### Cons

- ⚠️ Network latency for each signature operation
- ⚠️ Requires Vault infrastructure

## AWS KMS Provider (`aws-kms`)

Delegates key operations to AWS Key Management Service.

### Configuration

```json
{
    "id": "aws",
    "type": "aws-kms",
    "region": "${AWS_REGION}",
    "accessKeyId": "${AWS_ACCESS_KEY_ID}",
    "secretAccessKey": "${AWS_SECRET_ACCESS_KEY}"
}
```

| Field             | Required | Description                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `region`          | Yes      | AWS region where KMS keys will be created (e.g., `us-east-1`)                 |
| `accessKeyId`     | No       | AWS access key ID (optional — uses SDK credential chain if not provided)      |
| `secretAccessKey` | No       | AWS secret access key (optional — uses SDK credential chain if not provided) |

### Authentication

If `accessKeyId` and `secretAccessKey` are not provided, the adapter uses the [AWS SDK default credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), which supports:

- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Shared credentials file (`~/.aws/credentials`)
- IAM roles for EC2/ECS/Lambda
- Web identity tokens (EKS IRSA)

This is the recommended approach for production deployments.

### Key Creation

Keys are created as **asymmetric ECC_NIST_P256** keys with `SIGN_VERIFY` usage. Each key is tagged with:

- `TenantId` — the tenant identifier
- `LocalKeyId` — the local key ID stored in the database
- `ManagedBy` — set to `eudiplo`

### Key Deletion

When deleting a key, AWS KMS schedules it for deletion with a **7-day pending window** (the minimum allowed by AWS). The local database reference is removed immediately.

### Pros

- ✅ HSM-backed keys (FIPS 140-2 Level 3)
- ✅ AWS native integration
- ✅ CloudTrail audit logging
- ✅ Fine-grained IAM policies

### Cons

- ⚠️ Cannot import EC keys (use `create` only)
- ⚠️ Network latency
- ⚠️ AWS-specific

## PKCS#11 (HSM) Provider (`pkcs11`)

Integrates with Hardware Security Modules via PKCS#11.

### Configuration

```json
{
    "id": "hsm",
    "type": "pkcs11",
    "library": "/usr/lib/softhsm/libsofthsm2.so",
    "slot": 0,
    "pin": "${HSM_PIN}",
    "readOnly": false
}
```

| Field      | Required | Description                                                                                                                                                     |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library`  | Yes      | Absolute path to the vendor-provided PKCS#11 shared library (`.so` on Linux, `.dylib` on macOS, `.dll` on Windows)                                              |
| `slot`     | Yes      | Either the numeric slot index (e.g. `0`) **or** a token label string (e.g. `"eudiplo-token"`) — the adapter resolves labels via `C_GetTokenInfo`               |
| `pin`      | Yes      | User PIN used for `C_Login(CKU_USER, …)`. Use environment-variable placeholders to keep it out of the config file                                               |
| `readOnly` | No       | If `true`, the session is opened without `CKF_RW_SESSION`. Defaults to `false`. Set to `true` only when you do not need to create/delete keys |

### Native Dependency

The adapter is built on [`pkcs11js`](https://www.npmjs.com/package/pkcs11js), which is a native (N-API) Node.js binding. It is part of the regular backend dependencies and is built automatically on `pnpm install`.

You still need the **vendor's PKCS#11 library** (`.so` / `.dylib` / `.dll`) installed on the host where the backend runs.

### Examples

**SoftHSM2** (local dev / CI):

```bash
softhsm2-util --init-token --slot 0 \
    --label eudiplo --pin 1234 --so-pin 1234
```

```json
{
    "id": "softhsm",
    "type": "pkcs11",
    "library": "/usr/lib/softhsm/libsofthsm2.so",
    "slot": "eudiplo",
    "pin": "${SOFTHSM_PIN}"
}
```

**YubiHSM 2** (via yubihsm-pkcs11):

```json
{
    "id": "yubihsm",
    "type": "pkcs11",
    "library": "/usr/local/lib/pkcs11/yubihsm_pkcs11.dylib",
    "slot": 0,
    "pin": "${YUBIHSM_PIN}"
}
```

**AWS CloudHSM** (via the CloudHSM PKCS#11 SDK):

```json
{
    "id": "cloudhsm",
    "type": "pkcs11",
    "library": "/opt/cloudhsm/lib/libcloudhsm_pkcs11.so",
    "slot": 0,
    "pin": "${CLOUDHSM_USER}:${CLOUDHSM_PASSWORD}"
}
```

### Pros

- ✅ FIPS-certified hardware protection
- ✅ Private keys never leave HSM
- ✅ Vendor-neutral standard

### Cons

- ⚠️ Only ES256 supported
- ⚠️ Requires hardware or VM-based HSM
- ⚠️ Cannot import keys (generate only)

## HTTP Remote KMS Provider (`http`)

Delegates key operations to a remote microservice.

### Configuration

```json
{
    "id": "remote-kms",
    "type": "http",
    "baseUrl": "${KMS_SERVICE_URL}",
    "apiKey": "${KMS_API_KEY}",
    "keysPath": "/keys",
    "healthPath": "/health",
    "canImport": false
}
```

### Remote Service API Contract

The remote microservice must implement:

#### `POST {keysPath}` — generate a key

Request:

```json
{ "kid": "my-key-id", "alg": "ES256" }
```

Response:

```json
{ "publicJwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } }
```

#### `POST {keysPath}/{kid}/sign` — produce a signature

Request:

```json
{ "data": "<base64-encoded bytes>", "alg": "ES256" }
```

Response:

```json
{ "signature": "<base64url-encoded raw r‖s (64 bytes for P-256)>" }
```

#### `DELETE {keysPath}/{kid}` — delete a key

Response: `204 No Content`

#### `GET {healthPath}` — health check

Response:

```json
{ "ok": true }
```

### Pros

- ✅ Fully custom backend
- ✅ No EUDIPLO source modifications

### Cons

- ⚠️ You must implement the remote service

## CSC (Cloud Signature Consortium) Provider (`csc`)

Integrates with remote signing services via CSC v2 API.

### Configuration

```json
{
    "id": "csc-main",
    "type": "csc",
    "baseUrl": "${CSC_URL}",
    "apiPath": "/csc/v2",
    "tokenUrl": "${CSC_TOKEN_URL}",
    "clientId": "${CSC_CLIENT_ID}",
    "clientSecret": "${CSC_CLIENT_SECRET}",
    "scope": "service",
    "userId": "${CSC_USER_ID}",
    "credentialId": "${CSC_CREDENTIAL_ID}",
    "useAuthorizeEndpoint": true,
    "authorizeAuthData": [{ "id": "PIN", "value": "${CSC_PIN}" }]
}
```

### Pros

- ✅ Qualified remote signing
- ✅ CSC-compliant providers

### Cons

- ⚠️ External dependencies
- ⚠️ CSC credentials managed externally

## Provider Selection

When creating or importing a key, specify `kmsProvider`:

```bash
curl -X POST https://your-eudiplo-instance/keys \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "vault-backed-key",
    "usage": "attestation",
    "kmsProvider": "vault"
  }'
```

If omitted, the `defaultProvider` from `kms.json` is used.

## Related Topics

- [Key Chains](../trust/keys-and-certificates.md) — Unified key management
- [Certificates](../trust/keys-and-certificates.md#certificates) — Certificate lifecycle
- [Database](database.md) — Data storage and encryption
