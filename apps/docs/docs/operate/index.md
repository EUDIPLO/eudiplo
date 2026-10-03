---
title: Operate EUDIPLO
---

# Operate EUDIPLO

These guides cover running EUDIPLO yourself: choosing a deployment, configuring
storage, keys and access, and keeping the instance observable. Before you expose
an instance to real wallets and users, work through the
[production checklist](production-checklist.md).

## Choose a deployment

| Deployment                    | Use it when                                                                                    | What manages it                                       | Guide                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| CLI-managed Compose on one VM | You run one instance on one server and want generated config, upgrades and checks from one tool | `eudiplo init`, `up`, `upgrade`, `doctor`              | [Cookbook: Production on one VM](../cookbooks/production-vm.md) |
| Compose without the CLI       | You keep your own Compose files, for example in an existing infrastructure repository          | `docker compose` with the files in `deployment/docker-compose` | [Compose without the CLI](docker-compose.md)             |
| Kubernetes                    | You deploy to a cluster with Kustomize and bring your own database, object storage and secrets | `kubectl apply -k`, optionally the CLI for checks     | [Kubernetes](kubernetes.md)                              |

All three run the same images, `ghcr.io/openwallet-foundation/eudiplo` (backend)
and `ghcr.io/openwallet-foundation/eudiplo-client` (web client). The bundled
manifests and Compose files run one backend replica. Several replicas can share
one PostgreSQL database and one S3 bucket, but configuration changes of a tenant
are serialized by a database lock (see
[configuration as code](configuration-as-code.md#plans-locks-and-recovery)), and
the bundled PostgreSQL, RustFS and Vault services are single-instance
development services.

For a first local try, use `eudiplo demo` from the
[Foundation cookbook](../cookbooks/foundation.md) instead.

## Presets and profiles

The CLI presets, the Compose profiles in `deployment/docker-compose` and the
Kubernetes overlays in `deployment/k8s/overlays` share three names:

| Name       | Database   | Object storage      | Vault                      | CLI                 | Compose               | Kubernetes                    |
| ---------- | ---------- | ------------------- | -------------------------- | ------------------- | --------------------- | ----------------------------- |
| `minimal`  | SQLite     | Local filesystem    | -                          | `--preset minimal`  | no profile            | `overlays/minimal`            |
| `standard` | PostgreSQL | S3 (bundled RustFS) | -                          | `--preset standard` | `--profile standard`  | `overlays/standard`           |
| `full`     | PostgreSQL | S3 (bundled RustFS) | Bundled Vault in dev mode  | `--preset full`     | `--profile full`      | `overlays/full`               |

Vault serves a different purpose depending on where `full` comes from:

- **CLI `--preset full`** writes a `vault` provider to `config/kms.json` and makes
  it the default [KMS provider](kms.md) for new signing keys.
- **Compose `.env.full.example` and the Kubernetes `full` overlay** set
  `ENCRYPTION_KEY_SOURCE=vault`, so Vault holds the
  [encryption key](encryption-keys.md) for data at rest. Signing keys stay in
  the database unless you add a `kms.json`.

The CLI also accepts `--database`, `--storage` and `--kms` to mix components,
and Compose accepts the single profiles `postgres`, `s3` and `vault`. The bundled
Vault runs in development mode with the root token `root`; use your own Vault in
production.

## Configure the instance

Set these variables in every deployment. All others have defaults, listed in
the [environment variable reference](../reference/environment-variables.md).

| Variable                                    | Why                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                | The URL wallets and browsers use. It appears in offers, metadata and redirects. Default `http://localhost:3000`. |
| `MASTER_SECRET`                             | Signs management tokens of the built-in OAuth2 server and, with the default `ENCRYPTION_KEY_SOURCE=env`, derives the [encryption key](encryption-keys.md). At least 32 characters. |
| `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`      | The first management client, created with the `tenants:manage` role on the first start. Required unless you use [Keycloak SSO](keycloak.md) (`OIDC`). |

Without further settings, the backend uses SQLite and local file storage in
`FOLDER` (`/app/config` in the image). A minimal container start:

```bash
MASTER_SECRET="$(openssl rand -base64 32)"
AUTH_CLIENT_SECRET="$(openssl rand -base64 24)"
echo "Store these: MASTER_SECRET=$MASTER_SECRET AUTH_CLIENT_SECRET=$AUTH_CLIENT_SECRET"

docker run -d --name eudiplo -p 3000:3000 \
  -e PUBLIC_URL=http://localhost:3000 \
  -e MASTER_SECRET="$MASTER_SECRET" \
  -e AUTH_CLIENT_ID=root \
  -e AUTH_CLIENT_SECRET="$AUTH_CLIENT_SECRET" \
  -v eudiplo-data:/app/config \
  ghcr.io/openwallet-foundation/eudiplo:latest

curl http://localhost:3000/health
```

Keep `MASTER_SECRET` for the lifetime of the data: with the default key source
it derives the key that decrypts private keys and session data.

## Guides

| Topic                                         | Guide                                                         |
| --------------------------------------------- | ------------------------------------------------------------- |
| HTTPS, reverse proxy, web client on a subpath | [TLS and reverse proxy](tls.md)                               |
| CLI install, instances and drivers            | [CLI](cli.md)                                                 |
| Export, validate and import configuration     | [Configuration as code](configuration-as-code.md)             |
| Tenants, API clients, users and SSO           | [Tenants and access](tenants-and-access.md), [Keycloak](keycloak.md) |
| Database, migrations, session retention       | [Database](database.md)                                       |
| Encryption of data at rest                    | [Encryption keys](encryption-keys.md)                         |
| Files, images and logos                       | [Object storage](object-storage.md)                           |
| Signing keys in Vault, AWS KMS, HSM           | [Key management (KMS)](kms.md)                                |
| Logs, metrics, traces                         | [Logging](logging.md), [Monitoring](monitoring.md)            |
| Capacity tests                                | [Load testing](load-testing.md)                               |
| Upgrades between major versions               | [Upgrade](../upgrade/index.md)                                |
