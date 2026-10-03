---
title: Database
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Encryption at Rest' -> operate/encryption-keys.md
-->

# Database Configuration

EUDIPLO uses [TypeORM](https://typeorm.io/) for data persistence. By default, a local **SQLite** database is used, but the system also supports **PostgreSQL** and can be extended to work with other engines such as **MySQL**.

## Supported Databases

| Database   | Use Case                              | Production Ready |
| ---------- | ------------------------------------- | ---------------- |
| SQLite     | Development, testing, prototyping     | ⚠️ Limited       |
| PostgreSQL | Production, multi-instance deployments | ✅ Yes           |

## Configuration

### SQLite (Default)

When using `DB_TYPE=sqlite`, the service will store its data in a local file-based SQLite database located at the path defined by the `FOLDER` variable (`./config` by default).

```env
DB_TYPE=sqlite
FOLDER=./config
```

This setup is lightweight and ideal for:

- Development
- Testing
- Prototyping

No additional database server is required.

### PostgreSQL

To connect to a PostgreSQL instance, set the following environment variables:

```env
DB_TYPE=postgres
DB_HOST=your-hostname
DB_PORT=5432
DB_USERNAME=your-username
DB_PASSWORD=your-password
DB_DATABASE=your-database
DB_SSL=false
```

Set `DB_SSL=true` when your PostgreSQL server requires TLS encryption (for example managed cloud databases that reject non-encrypted connections). If your server accepts plaintext connections in a trusted internal network, you can keep `DB_SSL=false`.

When using private CAs or self-signed certificates, configure certificate validation explicitly:

```env
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PATH=/app/certs/postgres-ca.crt
```

Optional mutual TLS settings are also supported:

```env
DB_SSL_CERT_PATH=/app/certs/postgres-client.crt
DB_SSL_KEY_PATH=/app/certs/postgres-client.key
DB_SSL_KEY_PASSPHRASE=optional-passphrase
```

For local development only, you can disable certificate validation:

```env
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
```

:::danger
Do not use `DB_SSL_REJECT_UNAUTHORIZED=false` in production.
:::

Example for a TLS-required PostgreSQL deployment:

```env
DB_TYPE=postgres
DB_HOST=your-managed-postgres-host
DB_PORT=5432
DB_USERNAME=your-username
DB_PASSWORD=your-password
DB_DATABASE=your-database
DB_SSL=true
```

This mode is suitable for:

- Production deployments
- Multi-instance setups
- Scenarios requiring scalability and better concurrency handling

## Database Migrations

Starting from v2.0.0, EUDIPLO uses TypeORM migrations for database schema management instead of automatic synchronization. This provides:

- **Safe upgrades**: Schema changes are applied in a controlled manner
- **Rollback capability**: Migrations can be reverted if needed
- **Production safety**: No accidental schema changes in production

### How Migrations Work

By default, migrations run automatically when the service starts (`DB_MIGRATIONS_RUN=true`). The migration system detects whether you're running a fresh installation or upgrading:

- **Fresh installation**: The baseline migration creates all tables from the current entity metadata
- **Upgrading**: If application tables already exist (for example from the previous `synchronize: true` mode), the baseline leaves the schema and data untouched, and only pending incremental migrations are applied

### Configuration

| Variable            | Default | Description                       |
| ------------------- | ------- | --------------------------------- |
| `DB_MIGRATIONS_RUN` | `true`  | Run pending migrations on startup |
| `DB_SYNCHRONIZE`    | `false` | Auto-sync schema (⚠️ dev only)    |

:::warning[Production Safety]
Never set `DB_SYNCHRONIZE=true` in production. Use migrations instead to ensure controlled schema updates.
Fresh installations do not require a separate synchronization start; leave
`DB_SYNCHRONIZE=false` and `DB_MIGRATIONS_RUN=true` from the first start onward.
:::

### Manual Migration Commands

From the `apps/backend` directory:

```bash
# Generate a new migration based on entity changes
pnpm migration:generate --name=AddNewFeature

# Run pending migrations
pnpm migration:run

# Revert the last migration
pnpm migration:revert

# Show migration status
pnpm migration:show
```

### Upgrading from Pre-2.0.0

If you're upgrading from a version that used `synchronize: true`:

1. Your existing database schema is already correct
2. The baseline migration will detect existing tables and skip creation
3. Your data is preserved, and the migration history starts fresh

No action is required — just start the new version, and migrations will handle the rest.

## Encryption at Rest

EUDIPLO encrypts sensitive data at rest using **AES-256-GCM** authenticated encryption. This protects cryptographic keys and personal information stored in the database from unauthorized access, even if the database itself is compromised.

### Encrypted Fields

The following data is automatically encrypted before being written to the database:

| Entity                   | Field                  | Data Type                          |
| ------------------------ | ---------------------- | ---------------------------------- |
| `KeyEntity`              | `key`                  | Private JWK material               |
| `Session`                | `credentials`          | Verified presentation claims (PII) |
| `Session`                | `credentialPayload`    | Issuance offer data                |
| `Session`                | `auth_queries`         | Authorization query data           |
| `Session`                | `offer`                | Credential offer object            |
| `InteractiveAuthSession` | `presentationData`     | OpenID4VP presentation data        |
| `InteractiveAuthSession` | `completedStepsData`   | Step completion results            |
| `InteractiveAuthSession` | `authorizationDetails` | Authorization details              |

### Encryption Key Sources

The encryption key can be sourced from different providers, configured via `ENCRYPTION_KEY_SOURCE`:

| Source  | Description                             | Security Level | Use Case                 |
| ------- | --------------------------------------- | -------------- | ------------------------ |
| `env`   | Derived from `MASTER_SECRET` via HKDF   | Development    | Local dev, testing       |
| `vault` | Fetched from HashiCorp Vault at startup | Production     | Self-hosted, on-prem     |
| `aws`   | Fetched from AWS Secrets Manager        | Production     | AWS-native deployments   |
| `azure` | Fetched from Azure Key Vault            | Production     | Azure-native deployments |

:::tip[Security Hardening]
When using `vault`, `aws`, or `azure`, the encryption key is **only in RAM** — it's never stored in environment variables. This means a compromised container cannot retrieve the key via `env` or `/proc/*/environ` commands.
:::

#### Environment-based Key (Development)

```bash
ENCRYPTION_KEY_SOURCE=env  # default
MASTER_SECRET=your-jwt-secret  # key derived via HKDF
```

#### HashiCorp Vault

```bash
ENCRYPTION_KEY_SOURCE=vault
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=hvs.your-token
VAULT_ENCRYPTION_KEY_PATH=secret/data/eudiplo/encryption-key

# Create the key in Vault:
vault kv put secret/eudiplo/encryption-key key=$(openssl rand -base64 32)
```

#### AWS Secrets Manager

```bash
ENCRYPTION_KEY_SOURCE=aws
AWS_REGION=us-east-1
AWS_ENCRYPTION_SECRET_NAME=eudiplo/encryption-key

# Create the key in AWS:
aws secretsmanager create-secret \
  --name eudiplo/encryption-key \
  --secret-string $(openssl rand -base64 32)
```

Uses IAM roles automatically when running in EKS/ECS (no credentials needed).

#### Azure Key Vault

```bash
ENCRYPTION_KEY_SOURCE=azure
AZURE_KEYVAULT_URL=https://myvault.vault.azure.net
AZURE_ENCRYPTION_SECRET_NAME=eudiplo-encryption-key

# Create the key in Azure:
az keyvault secret set \
  --vault-name myvault \
  --name eudiplo-encryption-key \
  --value $(openssl rand -base64 32)
```

Uses Managed Identity automatically when running in Azure (no credentials needed).

### Key Requirements

The encryption key must be:

- **256 bits** (32 bytes)
- **Encoded as**: Base64 (44 characters) or Hex (64 characters)

Generate a secure key:

```bash
# Base64 (recommended)
openssl rand -base64 32

# Hex
openssl rand -hex 32
```

### Migration from Unencrypted Data

If upgrading from a version without encryption, EUDIPLO automatically handles migration:

1. **Reading**: Unencrypted data is detected and read normally
2. **Writing**: All writes use encryption

To fully encrypt existing data, update each record (e.g., via a migration script or by re-creating keys/sessions).

:::warning[Important: Key Recovery]
If you lose your encryption key, all encrypted data becomes unrecoverable. Ensure you:

- Use a secrets manager with backup/versioning
- Document the key's location for disaster recovery
- Test key rotation procedures

:::

## Extensibility

Because this service uses TypeORM, it is easy to integrate additional database engines such as:

- MySQL / MariaDB
- Microsoft SQL Server
- Oracle

To add support for a new engine:

- Install the appropriate TypeORM driver (e.g., `mysql2`)
- Set `DB_TYPE` to the corresponding engine name
- Configure the necessary connection options via environment variables

## Related Topics

- [Tenants](tenants-and-access.md) — Multi-tenant database isolation
- [KMS Configuration](kms.md) — Key management systems
- [Monitoring](monitoring.md) — Database health and performance tracking
