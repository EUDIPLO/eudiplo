---
title: CLI Reference
---

# EUDIPLO CLI Reference

The **EUDIPLO CLI** is available in two distributions:

1. **Standalone CLI** — Native executable, no Node.js required
2. **npm package** — `@eudiplo/cli`, requires Node.js 22+

Both distributions use the command name `eudiplo`.

## Installation

### Standalone CLI (Linux/macOS)

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
eudiplo --version
```

The installer downloads a release archive and verifies it against `SHA256SUMS.txt` from the same GitHub release.

**Supported release artifacts:**

- Linux x64: `eudiplo-vVERSION-linux-x64.tar.gz`
- Linux arm64: `eudiplo-vVERSION-linux-arm64.tar.gz`
- macOS arm64: `eudiplo-vVERSION-macos-arm64.tar.gz`
- Windows x64: `eudiplo-vVERSION-windows-x64.zip`

:::note[Windows Installation]
`install.sh` is for Linux/macOS shells only. On Windows, use Node.js/npm or the Windows x64 release archive.
:::

Release assets and checksums:

- [GitHub Releases](https://github.com/openwallet-foundation/eudiplo/releases)
- [SHA256SUMS.txt (latest)](https://github.com/openwallet-foundation/eudiplo/releases/latest)

### npm Package

One-off execution:

```bash
npx @eudiplo/cli --version
```

Global install:

```bash
npm install -g @eudiplo/cli
eudiplo --version
```

## Uninstall

### Standalone CLI

```bash
rm "${EUDIPLO_INSTALL_DIR:-$HOME/.local/bin}/eudiplo"
```

### npm Package

Global:

```bash
npm uninstall -g @eudiplo/cli
```

Project dependency:

```bash
pnpm remove @eudiplo/cli
```

### Remove CLI metadata

The CLI stores instance metadata in `~/.eudiplo/config.json` by default. Remove this directory only if you want to delete local CLI instance registrations:

```bash
rm -rf ~/.eudiplo
```

## Commands

### Demo Deployment

Start a local demo deployment with SQLite, local file storage, database-backed key management, and web client:

```bash
eudiplo demo ./eudiplo-demo
```

With npm:

```bash
npx @eudiplo/cli demo ./eudiplo-demo
```

**What it does:**

- Copies bundled Docker Compose deployment template
- Creates local demo assets (`.eudiplo.demo.env`, `config/kms.json`, `config/demo`)
- Starts a minimal stack using Docker Compose

:::warning[Demo Credentials]
Generated demo credentials are for local onboarding only and **must not be used in production**.
:::

**Container Runtime:**

Docker is used by default. If Docker is not found, the CLI tries Podman. Force a specific runtime:

```bash
export EUDIPLO_CONTAINER_RUNTIME=docker
# or
export EUDIPLO_CONTAINER_RUNTIME=podman
```

### Instance Management

Register and manage existing deployments (Kubernetes, Helm, standalone containers):

```bash
# Register an instance
eudiplo instance add production --url https://eudiplo.example.com

# List all instances
eudiplo instance ls

# Show instance details
eudiplo instance show production

# Set default instance
eudiplo instance use production

# Remove an instance
eudiplo instance remove old-production
```

:::tip[Instance Metadata]
Instance metadata is stored in the user's EUDIPLO CLI config directory (`~/.eudiplo/config.json`), not in the source tree. Never put secrets in this config; commands that need client credentials read `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET` from environment variables.
:::

### Deployment-Neutral Commands

These commands work with both `compose` and `external` instances without requiring Docker:

```bash
# Check instance health and connectivity
eudiplo doctor --instance production
eudiplo doctor --all       # every configured instance
eudiplo doctor --strict    # warnings count as failures

# Check deployment status
eudiplo status --instance production

# Open the web client (or the API docs) in a browser
eudiplo open --instance production
eudiplo open --docs
eudiplo open --print   # print the URL only

# Validate local configuration
eudiplo config validate

# Set up JSON schema validation for editors
eudiplo config editor setup

# Version information
eudiplo --version   # CLI version only
eudiplo version     # CLI version + update check
```

**What they do:**

- `doctor` — Runs production-readiness checks and prints one line per check with a summary. Each check reports `PASS`, `WARN`, `FAIL` or `SKIP`; `SKIP` means the check could not run here (for example no client URL, or an HTTP-only instance), and skipped checks never fail the command. `--all` checks every configured instance, `--strict` turns warnings into failures. Exit code is 1 when anything failed

  Checks: public URL (HTTPS), API reachability, `/health`, TLS certificate expiry (warns within 30 days), authentication configuration, CLI/backend version compatibility, KMS provider health, client connectivity, plus deployment-specific checks. For Compose instances those are the container runtime, whether its Compose provider works, the presence of the Compose files, and the state and health of the project's containers; for Kubernetes, `kubectl`, cluster scope, namespace, workloads and service endpoints

  The version and KMS checks call authenticated endpoints, so they need `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET`. Without them both checks are skipped rather than failed. Tokens, credentials and raw provider error text are never printed
- `open` — Opens the instance's web client, or the management API docs with `--docs`. When no browser is available (SSH, containers, CI, non-interactive shells) it prints the URL instead. Inside WSL it uses `wslview` when installed, and `$BROWSER` is honoured when set to a plain command
- `config validate` — Parses local CLI config, validates instance targets and HTTP(S) URLs
- `config path` — Prints the resolved CLI config file path
- `config show` — Inspects validated config contents (use `--json` for scripts)
- `config editor setup` — Installs JSON Schemas and merges associations into `.vscode/settings.json` for completion and validation

### Shell Completion

Generate command, option, and enumerated-value completion:

```bash
# Bash
source <(eudiplo completion bash)

# Zsh
source <(eudiplo completion zsh)

# Fish
eudiplo completion fish | source

# PowerShell
eudiplo completion powershell | Out-String | Invoke-Expression
```

:::tip[Persist Completion]
Save the generated script in your shell's completion directory to load it automatically in future sessions.
:::

### Compose Driver Commands

These commands are **only available for `compose` instances**:

```bash
# Initialize new deployment
eudiplo init
eudiplo init ./eudiplo-minimal --preset minimal
eudiplo init ./eudiplo-standard --preset standard --start
eudiplo init --database postgres --storage local --kms vault
eudiplo init --preset standard --public-url https://eudiplo.example.com
eudiplo init --preset standard --demo-tenant

# Manage containers
eudiplo up       # Start services
eudiplo down     # Stop services
eudiplo ps       # List containers and their state
eudiplo logs     # Print recent logs
eudiplo logs --service eudiplo --follow --tail 100 --since 10m
eudiplo restart --service eudiplo-client
eudiplo restart  # Restart every service in the project
eudiplo pull     # Download the configured images, configuration unchanged
eudiplo upgrade --image-tag 8.1.0        # Preview, confirm, then upgrade
eudiplo upgrade --image-tag 8.1.0 --yes  # Skip the confirmation (automation)

# Reset demo
eudiplo demo --reset --force
```

**Interactive wizard:**

When run in an interactive terminal, `init` opens a wizard for:

- Project directory
- Deployment preset
- Database (SQLite/PostgreSQL)
- Storage (local/S3)
- Key management (DB/Vault)
- Public URL
- Authentication client
- Web client
- Auto-start option

**Deployment presets:**

| Preset     | Database   | Storage            | Key Management  |
| ---------- | ---------- | ------------------ | --------------- |
| `minimal`  | SQLite     | Local filesystem   | Database-backed |
| `standard` | PostgreSQL | S3 via local RustFS | Database-backed |
| `full`     | PostgreSQL | S3 via local RustFS | Vault           |

Override preset choices with `--database`, `--storage`, and `--kms` flags.

**Non-interactive mode:**

Use `--yes` or `--no-interactive` to suppress the wizard. For automation:

```bash
eudiplo init --preset standard \
  --public-url https://eudiplo.example.com \
  --auth-client-id myapp \
  --auth-client-secret mysecret \
  --yes
```

:::warning[Secret Security]
Avoid exposing secrets in shared shell history when using `--auth-client-secret` in automation.
:::

**Lifecycle commands:**

`ps`, `logs`, and `restart` run through whichever Compose runtime the CLI selected, so they behave the same with `docker compose` and `podman compose`. `--service` is checked against the services the project defines (`compose config --services`) before anything runs, and `--since` accepts a duration such as `10m` or `2h30m`, or a timestamp such as `2026-09-01T12:00:00Z`. `logs` prints and exits unless `--follow` is passed. `restart` is refused for instances registered with `--read-only`.

:::note[Podman]
`podman compose` delegates to an external provider (`docker-compose` or `podman-compose`). Flag support depends on that provider, so keep it up to date.
:::

### Upgrading: CLI vs. Application

Three different things can be upgraded, and each has its own command:

| What | How | Affects |
| ---- | --- | ------- |
| The CLI itself | Re-run the installer, or `npm install -g @eudiplo/cli@latest`. `eudiplo version` checks for a newer CLI | Only the `eudiplo` command on your machine. Running deployments are untouched |
| The EUDIPLO application (Compose) | `eudiplo upgrade --image-tag <tag>` | The backend and web client images of the selected instance |
| Tenant configuration files | `eudiplo config upgrade <bundle>` | Exported configuration bundles, see [Configuration Model](../architecture/configuration-model.md) |

`eudiplo upgrade` only changes the two image lines the CLI manages in the instance env file (`EUDIPLO_IMAGE` and `EUDIPLO_CLIENT_IMAGE`). Everything else in the env file and all Compose files are left exactly as they are. The command:

1. Shows the current and new tag for each image, and links the [migration guide](../migration/index.md) for every major version crossed. It warns about downgrades, and about tags such as `latest` that cannot be compared.
2. Asks for confirmation, unless `--yes` is passed. Non-interactive runs require `--yes`.
3. Updates the image tags, pulls the new images and recreates the services. If pulling fails, the previous tags are restored.

If an image line has been customised (another registry, a digest, or no tag), `upgrade` refuses to touch it; update it yourself instead. Back up your database before upgrading across major versions. Database migrations run automatically when the new backend starts and cannot be undone by going back to an older tag.

`pull` and `upgrade` never remove volumes or other persistent data.

### Tenant Configuration Commands

Scaffold and manage local config-import folders:

```bash
# List tenants
eudiplo config tenant list   # or: ls

# Create new tenant
eudiplo config tenant create acme --name "Acme GmbH"   # or: new

# Create from demo template
eudiplo config tenant create sample --template demo

# Remove tenant
eudiplo config tenant remove acme --force   # or: rm, delete
```

**What `create` does:**

- Generates `info.json`
- Creates supported resource subdirectories
- With `--template demo`, copies bundled demo resources

**Config root selection:**

- Default: Uses selected Compose instance's config root
- `--instance <name>` — Select another instance
- `--config-directory <path>` — Work with a config root directly

:::warning[Remove Behavior]
`remove` deletes only local files; it does **not** delete an already imported tenant from a running backend.
:::

## Full Command Reference

For a compact list of every nested command:

```bash
eudiplo commands
```

For the complete reference in Markdown format:

```bash
eudiplo commands --format markdown
```

This generates the same command documentation embedded below, straight from the CLI's own command definitions.

import CliCommandReference from "@site/docs/generated/cli-reference.md";

<CliCommandReference />

## Related Topics

- [CLI Deployment Guide](../deployment/cli.md) — Setup and usage guide
- [Docker Compose Deployment](../deployment/docker-compose.md) — Deploy with Docker Compose
- [Kubernetes Deployment](../deployment/kubernetes.md) — Deploy on K8s
