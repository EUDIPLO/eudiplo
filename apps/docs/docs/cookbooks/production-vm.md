---
title: Server Setup Cookbook
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - '9. Developer Workflow' -> contributing/development-setup.md
  - 'Production Notes' (checklist) -> operate/production-checklist.md
-->

# Server Setup Cookbook

This guide is a copy-and-follow path for setting up EUDIPLO on a fresh Linux
server, or on your local machine, with the EUDIPLO CLI, a Compose runtime, and
file-based tenant configuration.

Use this cookbook when you want one EUDIPLO instance with one or more tenants
managed from local JSON config folders. For a short local demo, use
[`eudiplo demo`](foundation.md) instead.

By the end, you should have a running backend, a healthy CLI check, one tenant
configuration imported from files, and a clear next path into issuance and
presentation setup.

## What You Will Build

The steps below create a Compose-managed EUDIPLO project with:

- EUDIPLO backend
- optional web client
- SQLite and local storage for the `minimal` preset, or PostgreSQL and RustFS
  for the `standard` preset
- one mounted `config/` folder for tenants
- startup config import enabled

Tenant setup in this guide is file-based. The CLI creates tenant config folders
locally; the running backend imports them when it starts. To create tenants in a
running instance without restarting, use the Web Client or API.

## Happy Path

If you already have Docker or Podman and want the shortest successful path, run
these commands and then come back to the detailed sections when you need to
change something:

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
mkdir -p ~/eudiplo
cd ~/eudiplo

eudiplo init . --preset minimal --public-url http://localhost:3000 --start
eudiplo doctor

eudiplo config tenant create acme --name "Acme GmbH"
eudiplo config tenant validate acme
eudiplo down
eudiplo up
eudiplo doctor
```

Success looks like:

- `eudiplo doctor` reports the API and health endpoint as reachable.
- `eudiplo config tenant list` shows `acme`.
- `eudiplo logs eudiplo` does not show config-import validation errors.

## 1. Prepare the Server

Install Docker with Docker Compose v2, or Podman with Podman Compose, using the
package instructions for your Linux distribution. Then verify the runtime you
want to use:

```bash
docker --version
docker compose version
```

or:

```bash
podman --version
podman compose version
```

:::note[Using Podman instead of Docker]
The CLI-managed Compose commands (`eudiplo up`, `eudiplo down`, and
`eudiplo logs`) can use Docker or Podman. Docker is preferred by default;
if Docker is not found, the CLI tries Podman. To force one runtime, set
`EUDIPLO_CONTAINER_RUNTIME`:

```bash
export EUDIPLO_CONTAINER_RUNTIME=podman
# or
export EUDIPLO_CONTAINER_RUNTIME=docker
```

Validate the generated Compose file with your selected runtime before using
it for a shared environment.
:::

Install the standalone EUDIPLO CLI:

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
eudiplo --version
```

The standalone CLI removes the Node.js requirement. Docker or a compatible
Compose runtime is still required to run the deployment.

## 2. Choose a Public URL

Decide which URL wallets and administrators will use to reach the backend.

You can run this cookbook on your local machine as well as on a remote server.
For local testing without wallet interaction, use:

```text
http://localhost:3000
```

When EUDIPLO needs to interact with a wallet on another device, the wallet must
be able to reach the backend URL in offers, requests, and metadata. In that case,
expose your local backend with a tunnel or reverse proxy such as ngrok and use
the public tunnel URL as `PUBLIC_URL`:

```text
https://your-tunnel.example.com
```

For a real server behind DNS and TLS, use your external URL:

```text
https://eudiplo.example.com
```

The value is written to `PUBLIC_URL` and is used for OAuth, OpenID, and wallet
redirects. Configure your reverse proxy and TLS before using an HTTPS public URL
in production. The backend uses `http://127.0.0.1:3000` by default for its own
JWKS verification, so it does not require access to `PUBLIC_URL`. Set
`INTERNAL_URL` only when the backend listens at another internal address, such
as a sidecar proxy or a different port.

## 3. Initialize the EUDIPLO Project

Run the setup wizard. It asks for the project directory, preset, public URL,
authentication client, web client, and whether to start immediately.

Choose the preset based on how much infrastructure you want to run:

| Preset     | Services                                                               | Best for                                                                   |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `minimal`  | EUDIPLO backend, optional web client, SQLite, local filesystem storage | Local evaluation, small test servers, and the fewest moving parts          |
| `standard` | EUDIPLO backend, optional web client, PostgreSQL, RustFS                | Staging, longer-running test environments, and setups closer to production |

For the smallest local or test setup, use `minimal`:

```bash
mkdir -p ~/eudiplo
cd ~/eudiplo
eudiplo init . --preset minimal --public-url http://localhost:3000
```

For a server with PostgreSQL and RustFS, use `standard`:

```bash
mkdir -p ~/eudiplo
cd ~/eudiplo
eudiplo init . --preset standard --public-url https://eudiplo.example.com
```

Recommended wizard choices:

| Prompt                     | Recommended value                                                 |
| -------------------------- | ----------------------------------------------------------------- |
| Preset                     | `minimal` for fewer services, `standard` for PostgreSQL and RustFS |
| Database                   | SQLite for `minimal`, PostgreSQL for `standard`                   |
| Storage                    | Local filesystem for `minimal`, S3 via RustFS for `standard`       |
| Key management             | Database-backed                                                   |
| Web client                 | enabled, unless you only want API access                          |
| Start after initialization | yes                                                               |

The CLI creates files similar to:

```text
~/eudiplo/
  .eudiplo.env
  eudiplo.compose.yaml
  config/
    kms.json
```

The generated environment file includes:

```env
EUDIPLO_CONFIG_MOUNT=./config:/app/config
CONFIG_FOLDER=/app/config
CONFIG_IMPORT_MODE=create
```

That means every tenant directory under `config/` is scanned during backend
startup and missing resources are imported if the folder is valid. Select
`upsert` to reconcile existing resources or `replace` to additionally prune
resources previously managed by the same tenant folder.

:::tip[Automated setup]
For non-interactive automation, pass all required values as flags:

```bash
eudiplo init ~/eudiplo \
  --preset minimal \
  --public-url http://localhost:3000 \
  --auth-client-id root \
  --auth-client-secret '<root-client-secret>' \
  --no-interactive \
  --start
```

Avoid putting real shared secrets in shell history. On shared servers, prefer
the interactive wizard or your secret-management tooling.
:::

## 4. Start or Check the Instance

If you did not start the stack during initialization, start it now:

```bash
eudiplo up
```

On a Podman-only host, force Podman before running CLI-managed lifecycle
commands:

```bash
export EUDIPLO_CONTAINER_RUNTIME=podman
eudiplo up
```

Check container status and logs:

```bash
docker compose -f ~/eudiplo/eudiplo.compose.yaml --env-file ~/eudiplo/.eudiplo.env ps
eudiplo logs
```

Run the CLI health checks:

```bash
eudiplo doctor --instance local
eudiplo status --instance local
```

You can also check the backend directly:

```bash
curl http://localhost:3000/health
```

## 5. Add the First Tenant from the CLI

Create a tenant config folder:

```bash
eudiplo config tenant create acme --name "Acme GmbH"
```

This creates:

```text
~/eudiplo/config/acme/
  info.json
  clients/
  key-chains/
  attribute-providers/
  webhook-endpoints/
  issuance/
  presentation/
  trust-lists/
  images/
```

Validate the tenant before importing it:

```bash
eudiplo config tenant validate acme
```

Restart the stack so the backend runs config import on startup:

```bash
eudiplo down
eudiplo up
```

Confirm the instance is still healthy:

```bash
eudiplo doctor --instance local
```

At this point, the basic installation is done. You have a running EUDIPLO
instance and a tenant config folder that can be extended with issuance and
presentation resources.

## 6. Add a Tenant from the Demo Template

For a faster test tenant with bundled example resources, use the demo template:

```bash
eudiplo config tenant create sample --template demo
eudiplo config tenant validate sample
eudiplo down
eudiplo up
```

The demo template is useful for onboarding and testing. Do not use bundled demo
private keys or demo credentials in production.

## 7. List Local Tenant Configurations

List tenant folders managed by this Compose instance:

```bash
eudiplo config tenant list
```

Validate every tenant folder before the next restart:

```bash
eudiplo config validate tenants ~/eudiplo/config
```

## 8. Manage the Instance Later

Common lifecycle commands:

```bash
eudiplo status
eudiplo doctor
eudiplo logs
eudiplo down
eudiplo up
```

The CLI stores the `local` instance metadata in your user-level CLI config, so
these commands can be run from any directory after initialization.

## 9. Developer Workflow

After the first setup, most local changes follow the same loop:

```bash
cd ~/eudiplo

# Edit tenant config files under config/<tenant-id>/
eudiplo config tenant validate acme

# Restart so startup config import runs again
eudiplo down
eudiplo up

# Check whether the instance is reachable and healthy
eudiplo doctor
```

Useful files and directories:

| Path                               | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `.eudiplo.env`                     | Runtime environment for the generated Compose stack             |
| `eudiplo.compose.yaml`             | Generated Compose file used by `eudiplo up`, `down`, and `logs` |
| `config/kms.json`                  | Global key-management provider configuration                    |
| `config/<tenant-id>/info.json`     | Tenant metadata imported on startup                             |
| `config/<tenant-id>/clients/`      | Tenant clients imported on startup                              |
| `config/<tenant-id>/issuance/`     | Issuance and credential configuration files                     |
| `config/<tenant-id>/presentation/` | Presentation request configuration files                        |

Useful commands while editing:

```bash
# List local tenant config folders
eudiplo config tenant list

# Validate one tenant
eudiplo config tenant validate acme

# Validate all tenants in the config root
eudiplo config validate tenants ~/eudiplo/config

# Follow backend/client logs through the selected Compose runtime
eudiplo logs

# Pass extra Compose arguments through the CLI
eudiplo logs eudiplo
eudiplo down --volumes --remove-orphans
```

If you change `.eudiplo.env`, restart the stack. If you change tenant config
JSON, validate it before restarting so import errors are caught before startup.

## 10. Register an Externally Managed Instance

If the server is managed outside the CLI, for example with Kubernetes, Helm, or
your own Compose files, register it as an external instance instead:

```bash
eudiplo instance add production --url https://eudiplo.example.com
eudiplo doctor --instance production
```

For external instances, `up`, `down`, `logs`, and local tenant folder discovery
are not available. You can still validate config folders explicitly:

```bash
eudiplo config validate tenants ./config
```

## Go Deeper

Once the cookbook works end to end, continue by defining what the tenant should
issue and verify.

Start with issuance:

- [Credential configuration](../issuance/credential-configuration.md) defines
  the credential format, claims, display metadata, and proof settings.
- [Issuance configuration](../issuance/issuance-configuration.md) defines issuer
  metadata and which credentials can be offered.
- [Credential offers](../issuance/credential-offers.md) explains how to create
  offers for wallets.

Then add presentation:

- [Presentation configuration](../presentation/configure-verification.md)
  defines what credentials to request from wallets.
- [Presentation requests](../presentation/requests.md) explains how
  to start verification flows.
- [Transaction data](../presentation/transaction-data.md) covers signed
  transaction payloads for higher-assurance flows.

Keep the same local workflow while you go deeper: edit files under
`config/<tenant-id>/`, validate the tenant, restart the stack, then check
`eudiplo doctor` and `eudiplo logs eudiplo`.

## Common Problems

| Symptom                                | What to check                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker or Podman was not found`       | Install Docker/Podman, verify it is on `PATH`, or set `EUDIPLO_CONTAINER_RUNTIME` to the runtime you want.                                               |
| Wallet cannot scan or complete a flow  | Ensure `PUBLIC_URL` is reachable from the wallet device. For local development, use a tunnel or reverse proxy and reinitialize or update `.eudiplo.env`. |
| Tenant does not appear after restart   | Run `eudiplo config validate tenants ~/eudiplo/config`, then check `eudiplo logs` for config-import messages.                                            |
| Login fails                            | Verify `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, and `MASTER_SECRET` in `.eudiplo.env`, then restart the stack.                                            |
| `eudiplo logs` follows too much output | Pass a service name, for example `eudiplo logs eudiplo`.                                                                                                 |

## Production Notes

Before exposing the instance to real users:

- Replace default or demo credentials.
- Use a strong `MASTER_SECRET` and keep it stable for the lifetime of encrypted
  data.
- Put the backend behind TLS and set `PUBLIC_URL` to the HTTPS URL.
- Back up PostgreSQL, RustFS data, and the `config/` directory.
- Use Vault or another production key-management strategy when required by your
  security model.
- Validate tenant config in CI before deploying or restarting.

More details are available in the [Docker Compose deployment guide](../operate/docker-compose.md),
[configuration model guide](../operate/configuration-as-code.md#configuration-model), and
[CLI reference](../reference/cli.md).
