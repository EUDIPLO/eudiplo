# Docker Compose Deployments

This directory contains Docker Compose configurations for EUDIPLO with profile-based deployment options.

## Demo

The recommended demo path is the EUDIPLO CLI. It starts EUDIPLO with the demo
tenant and keeps the tenant files editable in `config/demo/`:

```bash
npx @eudiplo/cli demo
```

To run the demo tenant with the Compose files in this directory instead, mount
the repository's `assets/` folder, which contains the demo tenant in
`config/demo/`, and enable the startup import:

```bash
cp .env.minimal.example .env
cat >> .env <<'EOF'
EUDIPLO_CONFIG_MOUNT=../../assets:/app/config
CONFIG_IMPORT_MODE=create
EOF
docker compose up -d
```

The `ghcr.io/eudiplo/eudiplo-demo` image with embedded demo config is published
only up to 9.0.

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
docker compose --profile full up -d       # Full: create the Vault key first, see below

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
| **Full**     | `docker compose --profile full up`     | + PostgreSQL, RustFS, Vault | Evaluation (dev-mode Vault) |

The component profiles `postgres`, `s3`, and `vault` can be combined directly.
The EUDIPLO CLI uses these component profiles for custom `eudiplo init`
selections.

## Configuration Matrix

| Component          | Minimal          | Standard   | Full            |
| ------------------ | ---------------- | ---------- | --------------- |
| **Database**       | SQLite           | PostgreSQL | PostgreSQL      |
| **File Storage**   | Local filesystem | RustFS (S3) | RustFS (S3)      |
| **Encryption key** | From `MASTER_SECRET` | From `MASTER_SECRET` | HashiCorp Vault (dev mode, in memory) |

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

All published ports bind to `EUDIPLO_BIND_ADDRESS` (default `0.0.0.0`). Set
`EUDIPLO_BIND_ADDRESS=127.0.0.1` when a reverse proxy on the same host serves
the backend and client; RustFS and Vault are then reachable only from the host.

## Upgrading Between Profiles

### Minimal → Standard

1. Backup any SQLite data
2. Copy `.env.standard.example` to `.env`
3. Configure database credentials
4. Start with `docker compose --profile standard up -d`
5. Run database migrations (automatic on startup)

### Standard → Full

The `full` profile adds a Vault in development mode, which keeps everything in
memory and loses the encryption key on every restart. Use it for evaluation
only. `.env.full.example` sets `ENCRYPTION_KEY_SOURCE=vault`, and nothing
creates the key; the backend does not start until it exists. Creating the key
and the restart behavior are described in
[Compose without the CLI](https://docs.eudiplo.dev/operate/docker-compose#create-the-encryption-key-for-full).

Data that the standard profile encrypted with the key derived from
`MASTER_SECRET` stays readable only if Vault holds that same key; a new random
key makes it unreadable. See
[Switch to an external key source](https://docs.eudiplo.dev/operate/encryption-keys#switch-to-an-external-key-source).

To keep signing keys in Vault as well, add a `kms.json` with a provider of type
`vault` (`"vaultUrl": "${VAULT_ADDR}"`, `"vaultToken": "${VAULT_TOKEN}"`) to
`CONFIG_FOLDER`. The KMS provider is not selected via environment variables;
see the [KMS documentation](https://docs.eudiplo.dev/operate/kms).

## Production Considerations

⚠️ **Before deploying to production:**

1. **Change all default credentials** in `.env`
2. **Use strong secrets**: `openssl rand -base64 32`
3. **Configure proper Vault setup** (not the bundled dev-mode Vault, which loses
   its data on restart)
4. **Set up TLS/HTTPS** via reverse proxy
5. **Configure backup strategies** for PostgreSQL and RustFS

For more details, see the [full documentation](https://docs.eudiplo.dev/operate/docker-compose/).

## Migrating existing MinIO storage

This Compose file deploys RustFS 1.0.0 with a separate `rustfs-data` volume.
Existing MinIO data is not migrated automatically; do not mount a MinIO data
directory into RustFS. The steps are in the
[upgrade guide](https://docs.eudiplo.dev/upgrade/8.x-to-9.0#bundled-object-storage-minio-replaced-by-rustfs).
Existing CLI projects keep their Compose file and env file; updating the CLI
does not rewrite them.

The bucket initialization job uses AWS CLI 2.37.4 and retains the previous
public-download policy (`s3:GetObject`). Review that policy for private buckets.
