---
title: Compose without the CLI
---

# Compose without the CLI

Run EUDIPLO with the Compose file in `deployment/docker-compose` and manage it
with `docker compose` yourself. If you prefer generated files and
`eudiplo up`/`upgrade`/`doctor`, follow the
[production VM cookbook](../cookbooks/production-vm.md) instead; the CLI uses
the same Compose file.

## Before you start

- Docker with Compose v2, or Podman with `podman compose`
- A checkout of the repository, or a copy of `deployment/docker-compose/`
- A choice of [preset](index.md#presets-and-profiles): `minimal`, `standard` or `full`

## 1. Create the environment file

```bash
cd deployment/docker-compose
cp .env.standard.example .env    # or .env.minimal.example, .env.full.example
```

Replace every placeholder secret before the first start:

```bash
openssl rand -base64 32   # MASTER_SECRET
openssl rand -base64 24   # AUTH_CLIENT_SECRET, DB_PASSWORD, RUSTFS_SECRET_KEY
```

`MASTER_SECRET`, `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` have no defaults; the
backend does not start without them. In `standard` and `full`, set
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to the same values as
`RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY`. Set `PUBLIC_URL`
to the URL wallets use to reach the backend.

## 2. Start a profile

```bash
docker compose up -d                       # minimal: backend and web client
docker compose --profile standard up -d    # + PostgreSQL and RustFS
docker compose --profile full up -d        # + Vault; create the key first, see below
```

Combine single components with `--profile postgres`, `--profile s3` and
`--profile vault`. Use the same profile flags for every later `docker compose`
command, otherwise Compose ignores the profile's services.

### Create the encryption key for `full`

`.env.full.example` sets `ENCRYPTION_KEY_SOURCE=vault`, and nothing creates the
key, so the backend does not start until it exists in Vault. Before the first
start, start Vault, create the key and keep a copy:

```bash
docker compose --profile full up -d vault
KEY="$(openssl rand -base64 32)"
echo "Store this key in your password manager: $KEY"
docker compose --profile full exec \
  -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=root \
  vault vault kv put secret/eudiplo/encryption-key key="$KEY"
docker compose --profile full up -d
```

Use your `VAULT_TOKEN` instead of `root`. If `exec` fails right after the start,
Vault is not listening yet; run it again.

The bundled Vault runs in development mode and keeps everything in memory.
Every restart of the `vault` container, for example after `down`, a host
reboot or a Docker update, deletes the key. The running backend keeps working,
but it does not start again until the key is back: write the stored key with
the same `vault kv put` command. Never create a new key, because the data
encrypted so far could no longer be decrypted. Use `full` only to evaluate
Vault. In production, use a Vault with persistent storage or another
[key source](encryption-keys.md#choose-a-key-source), and back up the key.

**Checkpoint:** `curl http://localhost:3000/health` returns
`{"status":"ok",...}` and the web client opens at `http://localhost:4200`.

## Services

| Service          | Profiles                    | Ports                  | Purpose                                              |
| ---------------- | --------------------------- | ---------------------- | ---------------------------------------------------- |
| `eudiplo`        | always                      | 3000                   | Backend                                              |
| `eudiplo-client` | always                      | 4200 → 8080            | Web client. The browser calls the backend directly, at the URL entered on the login page; `API_BASE_URL` prefills it |
| `postgres`       | `postgres`, `standard`, `full` | -                   | PostgreSQL 16; set `DB_HOST=postgres` in `.env`      |
| `rustfs`         | `s3`, `standard`, `full`    | 9000 (S3), 9001 (console) | S3-compatible object storage                      |
| `rustfs-init`    | `s3`, `standard`, `full`    | -                      | Creates `S3_BUCKET` once and exits                   |
| `vault`          | `vault`, `full`             | 8200                   | HashiCorp Vault in development mode, data in memory only ([see above](#create-the-encryption-key-for-full)), token from `VAULT_TOKEN` (default `root`) |

All published ports bind to `EUDIPLO_BIND_ADDRESS`. The backend reaches
PostgreSQL, RustFS and Vault over the Compose network, and files are downloaded
through the backend, so no other host needs ports 9000, 9001 or 8200. With the
default `0.0.0.0` they are open on every interface: set
`EUDIPLO_BIND_ADDRESS=127.0.0.1` behind a reverse proxy on the same host, or
block the ports in a firewall in front of the host (Docker bypasses host
firewalls such as `ufw`).

The Compose file also reads these variables from `.env`:

| Variable                | Default                                              | Use                                                         |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `EUDIPLO_IMAGE`         | `ghcr.io/eudiplo/eudiplo:latest`        | Backend image; pin a release tag in production              |
| `EUDIPLO_CLIENT_IMAGE`  | `ghcr.io/eudiplo/eudiplo-client:latest` | Web client image; keep it on the same tag as the backend    |
| `EUDIPLO_BIND_ADDRESS`  | `0.0.0.0`                                            | Host address of all published ports (3000, 4200, 9000, 9001, 8200); `127.0.0.1` behind a local reverse proxy |
| `EUDIPLO_CONFIG_MOUNT`  | named volume `eudiplo-config:/app/config`            | What is mounted at `/app/config`                            |
| `EUDIPLO_ENV_FILE`      | `.env`                                               | Environment file passed to the backend                     |
| `API_BASE_URL`          | `http://localhost:3000`                              | Backend URL prefilled on the web client's login page; set it to the URL your browser uses for the backend |
| `CLIENT_BASE_HREF`      | `/`                                                  | Path of the web client behind a reverse proxy ([TLS and reverse proxy](tls.md#serving-the-client-from-a-subpath)) |

## Data and configuration folders

The image sets `FOLDER=/app/config` and `CONFIG_FOLDER=/app/config/config`:

- `FOLDER` holds the SQLite database (`service.db`) and, unless
  `LOCAL_STORAGE_DIR` is set, the uploaded files. The example `.env` files set
  `LOCAL_STORAGE_DIR=/app/uploads`, which is the `eudiplo-uploads` volume.
- `CONFIG_FOLDER` holds the global `kms.json` and one folder per tenant for
  [configuration import](configuration-as-code.md). Every directory in it is
  treated as a tenant folder.

To provision tenants from files, mount your config root and enable the import:

```env
EUDIPLO_CONFIG_MOUNT=./config:/app/config
CONFIG_FOLDER=/app/config
CONFIG_IMPORT_MODE=create
```

With this mount the SQLite database is written to `./config/service.db`, which
is how CLI-managed projects are laid out. Mounting the config folder at
`/app/config` without setting `CONFIG_FOLDER=/app/config` makes the backend look
for tenants in `./config/config/`.

## Day-to-day commands

```bash
docker compose --profile standard ps
docker compose --profile standard logs -f eudiplo
docker compose --profile standard restart eudiplo
docker compose --profile standard down
```

`docker compose down -v` also deletes the volumes, including the database,
uploads and RustFS data.

To upgrade, [back up](production-checklist.md#backups) the database and object
storage, set the new tag in `EUDIPLO_IMAGE` and `EUDIPLO_CLIENT_IMAGE`, then run
`docker compose --profile standard pull` and `up -d`. Database migrations run on
the first start of the new backend; read the [upgrade guide](../upgrade/index.md)
for every major version you cross.

## Migrating existing MinIO storage

Since 9.0 the bundled object storage is RustFS instead of MinIO, with new
service names, credentials and volumes; follow the
[upgrade guide](../upgrade/8.x-to-9.0.md#bundled-object-storage-minio-replaced-by-rustfs)
to move existing objects.
