# Docker Compose Deployments

This directory contains Docker Compose configurations for EUDIPLO with profile-based deployment options.

## Demo Image (Embedded Config)

This is the Docker-only path. The recommended onboarding path is
`npx @eudiplo/cli demo`.

The demo backend image contains embedded demo config and bootstraps it
automatically when `/app/config` is empty.

Pull from GHCR (recommended):

```bash
cp .env.minimal.example .env
echo 'EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo-demo:latest' >> .env
docker compose up -d
```

Or build locally:

```bash
docker build --target eudiplo-demo -t eudiplo-demo:local ../..
cp .env.minimal.example .env
echo 'EUDIPLO_IMAGE=eudiplo-demo:local' >> .env
docker compose up -d
```

Notes:

- Keep `EUDIPLO_CONFIG_MOUNT` unset to use the default named volume.
- On first startup, the demo image seeds config once (when config folder is empty).
- If you already have data/config in the volume, bootstrap is skipped.

## Quick Start

```bash
# Copy the appropriate environment file
cp .env.minimal.example .env   # For minimal setup
# OR
cp .env.standard.example .env  # For standard setup with Postgres + RustFS
# OR
cp .env.full.example .env      # For full setup with Vault

# Edit .env - MASTER_SECRET, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET are required
nano .env
# Generate a secure MASTER_SECRET: openssl rand -base64 32

# Start services
docker compose up -d                      # Minimal (default)
docker compose --profile standard up -d   # Standard
docker compose --profile full up -d       # Full

# Components can also be enabled independently
docker compose --profile postgres --profile s3 up -d
```

## Config Mounting

By default, EUDIPLO mounts `/app/config` from a named Docker volume.

- Default behavior (persistent named volume):
  - `EUDIPLO_CONFIG_MOUNT` unset
  - Compose uses `eudiplo-config:/app/config`
- Use repository config files (useful for load tests and config import):
  - Set `EUDIPLO_CONFIG_MOUNT=../../assets:/app/config`

The image reads tenant folders and `kms.json` from `CONFIG_FOLDER`, which
defaults to `/app/config/config` (the `config/` folder inside the mount, next to
the SQLite database). If you mount a folder that directly contains the tenant
folders (for example `../../assets/config:/app/config`), also set
`CONFIG_FOLDER=/app/config`.

When using the demo image (`EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo-demo:latest` or `EUDIPLO_IMAGE=eudiplo-demo:local`), you typically do not need a bind mount for config import.

Example:

```bash
cp .env.standard.example .env
echo 'EUDIPLO_CONFIG_MOUNT=../../assets:/app/config' >> .env
docker compose --profile standard up -d
```

Note: paths are resolved relative to this directory (`deployment/docker-compose`).

## k6 Load Test Env

For load testing, use `k6.env` in this directory as a single config source for
startup and test import data.

```bash
cd ../../
bash scripts/load-test/run-all.sh
# fast feedback (one iteration per scenario)
bash scripts/load-test/run-all.sh --once
```

By default the runner starts compose with:

- `--env-file deployment/docker-compose/k6.env`
- `--profile standard`

You can override this behavior with:

- `START_STACK=false` to skip compose startup
- `K6_ENV_FILE=/absolute/path/to/env` to use a different env file
- `COMPOSE_PROFILE=minimal|standard|full` to change the profile

## Deployment Profiles

| Profile      | Command                                | Components                 | Use Case                  |
| ------------ | -------------------------------------- | -------------------------- | ------------------------- |
| **Minimal**  | `docker compose up`                    | EUDIPLO only               | Local dev, quick testing  |
| **Standard** | `docker compose --profile standard up` | + PostgreSQL, RustFS        | Staging, small production |
| **Full**     | `docker compose --profile full up`     | + PostgreSQL, RustFS, Vault | Enterprise production     |

The component profiles `postgres`, `s3`, and `vault` can be combined directly.
The EUDIPLO CLI uses these component profiles for custom `eudiplo init`
selections.

## Configuration Matrix

| Component          | Minimal          | Standard   | Full            |
| ------------------ | ---------------- | ---------- | --------------- |
| **Database**       | SQLite           | PostgreSQL | PostgreSQL      |
| **File Storage**   | Local filesystem | RustFS (S3) | RustFS (S3)      |
| **Key Management** | DB-backed        | DB-backed  | HashiCorp Vault |

## Environment Files

- `.env.minimal.example` - Configuration for minimal deployment
- `.env.standard.example` - Configuration for standard deployment
- `.env.full.example` - Configuration for full deployment

## Service Access

After deployment, access the services at:

| Service               | URL                                     |
| --------------------- | --------------------------------------- |
| **Backend API**       | <http://localhost:3000>                 |
| **Client Web UI**     | <http://localhost:4200>                 |
| **API Documentation** | <http://localhost:3000/api/docs>        |
| **RustFS Console**     | <http://localhost:9001/rustfs/console/> (standard/full) |
| **Vault UI**          | <http://localhost:8200> (full)          |

## Upgrading Between Profiles

### Minimal → Standard

1. Backup any SQLite data
2. Copy `.env.standard.example` to `.env`
3. Configure database credentials
4. Start with `docker compose --profile standard up -d`
5. Run database migrations (automatic on startup)

### Standard → Full

1. Stop services: `docker compose --profile standard down`
2. Update `.env` with Vault configuration:

   ```
   VAULT_ADDR=http://vault:8200
   VAULT_TOKEN=your-token
   ENCRYPTION_KEY_SOURCE=vault
   ```

3. To keep signing keys in Vault as well, add a `kms.json` with a provider of
   type `vault` (`"vaultUrl": "${VAULT_ADDR}"`, `"vaultToken": "${VAULT_TOKEN}"`)
   to `CONFIG_FOLDER`. The KMS provider is not selected via environment
   variables; see the [KMS documentation](https://docs.eudiplo.dev/operate/kms).
4. Start with `docker compose --profile full up -d`

## Production Considerations

⚠️ **Before deploying to production:**

1. **Change all default credentials** in `.env`
2. **Use strong secrets**: `openssl rand -base64 32`
3. **Configure proper Vault setup** (not dev mode)
4. **Set up TLS/HTTPS** via reverse proxy
5. **Configure backup strategies** for PostgreSQL and RustFS

For more details, see the [full documentation](https://docs.eudiplo.dev/operate/docker-compose/).

## Migrating existing MinIO storage

These templates now deploy RustFS 1.0.0 with a separate `rustfs-data` volume
(or PVC). Existing MinIO data is not migrated automatically. Keep the old
volumes and backups; do not mount a MinIO data directory directly into RustFS.

1. Start RustFS with an empty volume alongside the existing storage service.
2. Copy buckets and objects through the S3 API using a migration tool that
   preserves the metadata, versions, and policies your deployment requires.
3. Verify object counts, contents, and application reads before switching
   `S3_ENDPOINT` to `http://rustfs:9000`.
4. Replace `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` with `RUSTFS_ACCESS_KEY` /
   `RUSTFS_SECRET_KEY`, and use the same values for `S3_ACCESS_KEY_ID` /
   `S3_SECRET_ACCESS_KEY`. Bucket initialization now uses `S3_BUCKET`.
5. Keep the old service and data available for rollback until the migration
   is verified. Existing CLI projects need their Compose file and `.env`
   updated as well; updating the CLI alone does not rewrite them.

The bucket initialization job uses AWS CLI 2.34.0 and retains the previous
public-download policy (`s3:GetObject`). Review that policy for private buckets.
