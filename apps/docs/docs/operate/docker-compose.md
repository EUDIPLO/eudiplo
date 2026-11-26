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
| `eudiplo-client` | always                      | 4200 → 8080            | Web client. The browser calls the backend directly ([which addresses](#web-client-addresses)); `API_BASE_URL` prefills the login page |
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
| `API_BASE_URL`          | `http://localhost:3000`                              | Backend URL prefilled on the web client's login page; set it to the URL your browser uses for the backend. The login page asks before signing in at another instance that a link (`?apiUrl=`) chose |
| `CLIENT_BASE_HREF`      | `/`                                                  | Path of the web client behind a reverse proxy ([TLS and reverse proxy](tls.md#serving-the-client-from-a-subpath)) |

### Web client addresses

The web client runs in the browser, so the browser sends its requests, to two
addresses. It reads the discovery document and sends every API call to the
**EUDIPLO Instance** entered on the login page. For the client-credentials
login and every token refresh, it uses the token endpoint that discovery names:
`PUBLIC_URL/api/oauth2/token`, or the provider's token endpoint when `OIDC` is
set. Both addresses must be reachable from the browser, accept the web client's
origin (`CORS_ORIGINS` on the backend, the allowed web origins at the
provider), and pass any proxy or WAF in front of them. They differ when, for
example, the login page uses `http://localhost:3000` while `PUBLIC_URL` is a
tunnel or the public host name.

### Links to the login page

A link to `<web client>/login?apiUrl=<backend URL>` opens the login page with
that **EUDIPLO Instance** filled in; with `clientId` and `clientSecret` as well,
it signs in with these credentials at once. The instance receives the access
token after a single sign-on, or the client secret, so the login page asks
before it signs in at an instance that a link chose, unless `API_BASE_URL`
names it or the browser last signed in there with single sign-on or a client
secret the user entered. The web client sends the access token only to the
instance it is signed in to.

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

### Non-root user

The backend does not run as root. The image starts as root only for its
entrypoint, which picks a user, hands that user the folders the backend writes
to and then starts the backend as that user, without capabilities, with
`no_new_privs` and without supplementary groups.

| Setup | The backend runs as |
| --- | --- |
| Default start, root owns `FOLDER` or it does not exist yet (named volumes of earlier releases, new named volumes) | UID and GID `1000` (`node`) |
| Default start, another user owns `FOLDER` (a CLI project's `./config` on Linux) | that user; the group of `FOLDER`, or the user's UID as GID when the group is root |
| Started as a non-root user (`user: "1000:1000"`, `--user`, Kubernetes `runAsUser`) | that user; the entrypoint changes nothing |
| `EUDIPLO_RUN_AS_ROOT=true` | root, as before |
| Root without the capabilities `SETUID` and `SETGID` (`cap_drop: [ALL]`) | root; the entrypoint logs that it cannot change the user |
| User namespace (rootless Podman, Docker with `userns-remap`) and root owns `FOLDER` | root, which is the unprivileged host user; a bind mount stays with that user |

An explicit `user: "0"` is the same as the default start. To run the backend
as `node` under rootless Podman, hand the folder over once with
`podman unshare chown -R 1000:1000 <folder>` for a bind mount, or set
`UserNS=keep-id:uid=1000,gid=1000` in a Quadlet
(`--userns=keep-id:uid=1000,gid=1000` for `podman run`).

**Folders the entrypoint hands over.** In `FOLDER`, `CONFIG_FOLDER`,
`LOCAL_STORAGE_DIR` and, with `LOG_TO_FILE=true`, the folder of
`LOG_FILE_PATH`, files and folders that root owns are handed to the backend's
user, and so is an empty folder that `node` owns, such as a new named volume,
when the user is not `node`. The startup log says
`eudiplo-entrypoint: changed the owner of root-owned files in <folder> to <uid>:<gid>`.
Files of other users keep their owner, and a file with more than one hard link
is skipped. The entrypoint leaves a folder as it is, and logs why, when its
path contains a symbolic link or when it is neither a mount point nor
`/app/config`, `/app/uploads` or `/app/logs` of the image, for example
`FOLDER=/data/eudiplo` with the volume mounted at `/data`. On a read-only mount
it logs `could not change the owner of all root-owned files in <folder> ...`.
In these cases change the owner once yourself:

```bash
docker compose run --rm --user root --entrypoint chown eudiplo -R 1000:1000 /app/config
```

(for a bind mount on the host: `sudo chown -R 1000:1000 ./config`; replace
`/app/config` by the folder and `1000:1000` by the user from the table).

**Files the backend only reads** outside these folders must be readable by its
user. A file of mode `0600` that root owns on the host is not. This applies to
the TLS key and certificate (`TLS_*_PATH`), the files of the database
connection (`DB_SSL_*_PATH`), the mTLS certificates and keys of a KMS provider,
a PKCS#11 library and the token folder of a software HSM such as SoftHSM
(which the backend also writes), and Compose secrets. Find them with
`docker compose exec eudiplo sh -c 'ls -ln /certs /run/secrets'` (replace the
folders by your mounts), then give them to the backend's user or make them
readable by its group; a Compose `group_add` no longer applies:

```bash
sudo chown 1000:1000 ./certs/privkey.pem
```

When the backend cannot read such a file, its error names the file, the UID
and GID it runs as, and `EUDIPLO_RUN_AS_ROOT`.

**Home folder.** `HOME` is `/home/node`, or `/tmp` for another user. AWS or
Azure credentials mounted under `/root` (`/root/.aws`, `/root/.azure`) are no
longer found; mount them readable by the backend's user and set
`AWS_SHARED_CREDENTIALS_FILE` and `AWS_CONFIG_FILE`, or use environment
variables or an IAM role.

`docker exec` still runs as root, so files it writes into these folders belong
to root until the next start hands them over. An image built on
`ghcr.io/eudiplo/eudiplo` with its own `CMD` runs that command through the
entrypoint, as the same user; as with the node base image, a command that
starts with `-` or is no program runs with `node`.

`EUDIPLO_RUN_AS_ROOT=true` in the environment of the `eudiplo` service keeps the
backend running as root, as before. It is meant for the time until such files
are readable by the backend's user.

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
