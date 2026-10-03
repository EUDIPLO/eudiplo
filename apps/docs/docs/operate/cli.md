---
title: CLI
---

# EUDIPLO CLI

The `eudiplo` command creates and runs Compose deployments, registers existing
deployments, and checks any of them with `doctor`. This page shows how to install
it and use it; every command and option is listed in the
[CLI reference](../reference/cli.md).

## Install

**Linux (x64, arm64) and macOS (Apple silicon):**

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
eudiplo --version
```

The installer downloads the standalone binary of the latest release, checks it
against the release's `SHA256SUMS.txt` and installs it to `~/.local/bin`
(override with `EUDIPLO_INSTALL_DIR`). If that directory is not on your `PATH`,
the installer prints the line to add to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Intel Macs and other architectures:** no standalone binary is published. The
installer falls back to `npm install -g @eudiplo/cli`, which needs Node.js 22.12
or newer and npm.

**Windows, or with Node.js:** use the npm package, or the Windows x64 archive
from the [GitHub releases](https://github.com/openwallet-foundation/eudiplo/releases).

```bash
npm install -g @eudiplo/cli   # installs the `eudiplo` command
npx @eudiplo/cli --version    # one-off run without installing
```

`eudiplo version` also checks npm for a newer CLI. To uninstall, delete the
binary (`rm ~/.local/bin/eudiplo`) or run `npm uninstall -g @eudiplo/cli`;
`~/.eudiplo` holds your instance registrations.

Running Compose deployments additionally needs Docker with Compose v2 or Podman
with `podman compose`. Docker is preferred; set
`EUDIPLO_CONTAINER_RUNTIME=podman` (or `docker`) to choose explicitly.

## Instances

Every command acts on an *instance*: a registered deployment with a name, a
target and its public API URL. Instances are stored in `~/.eudiplo/config.json`
(change the directory with `EUDIPLO_CLI_HOME`, or the file with
`EUDIPLO_CLI_CONFIG`). The file never contains secrets.

| Target       | Created by                                   | Lifecycle commands                                  |
| ------------ | -------------------------------------------- | --------------------------------------------------- |
| `compose`    | `eudiplo demo`, `eudiplo init`               | `up`, `down`, `ps`, `logs`, `restart`, `pull`, `upgrade` |
| `kubernetes` | `eudiplo instance add --target kubernetes`   | `ps`, `logs`, `restart`                             |
| `external`   | `eudiplo instance add` (default target)      | none                                                |

`doctor`, `status`, `open` and the `config` commands work for every target.

```bash
eudiplo instance ls                  # list, the default is marked
eudiplo instance use production      # make it the default
eudiplo doctor --instance staging    # or pick one per command
eudiplo instance remove old-staging  # unregister (does not touch the deployment)
```

Commands that call the management API read credentials from the environment,
never from the instance file: `doctor` uses `EUDIPLO_CLIENT_ID` and
`EUDIPLO_CLIENT_SECRET` for its authenticated checks, and the `config export`,
`plan`, `import`, `operations` and `recover` commands take an access token from
`--token` or `EUDIPLO_TOKEN`.

## Demo or init

| Command          | Purpose                                         | Compose project | Credentials                | Binds to       |
| ---------------- | ----------------------------------------------- | --------------- | -------------------------- | -------------- |
| `eudiplo demo`   | Throwaway local demo with the demo tenant       | `eudiplo-demo`  | `root` / `root`            | `127.0.0.1`    |
| `eudiplo init`   | A deployment you keep and configure             | `eudiplo`       | generated client secret    | `0.0.0.0`      |

Both register the instance `local` and use ports 3000 and 4200. Stop the demo
with `eudiplo down` before you run `init`, or the new stack fails on the ports
and `init` replaces the `local` registration. Use `init --instance <name>` to
keep both registrations.

Both use the image tag `latest` unless you pass `--image-tag` or set
`EUDIPLO_IMAGE_TAG` (a release such as `9.0.0`, `main`, or `sha-<commit>`).

`init` asks for the directory, [preset](index.md#presets-and-profiles), public
URL and auth client; in scripts pass them as flags with `--no-interactive`. It
writes `.eudiplo.env` (owner-only permissions), `eudiplo.compose.yaml` and a
`config/` folder that is mounted at `/app/config` and imported on start
(`CONFIG_IMPORT_MODE=create`). The
[production VM cookbook](../cookbooks/production-vm.md) walks through it.

## Compose instances

```bash
eudiplo up                                  # docker compose up -d
eudiplo ps
eudiplo logs                                # recent logs of all services, then exit
eudiplo logs --service eudiplo --follow --tail 100 --since 10m
eudiplo restart --service eudiplo-client
eudiplo down                                # add --volumes to delete the data
```

`logs` prints and exits unless you pass `--follow`. `--service` must name a
service of the project. Arguments after the options are passed to
`docker compose`, for example `eudiplo down --volumes --remove-orphans`.

### Upgrade the application

`eudiplo upgrade` changes the backend and client images of a Compose instance,
not the CLI:

```bash
eudiplo upgrade --image-tag 9.0.0
```

It changes only the `EUDIPLO_IMAGE` and `EUDIPLO_CLIENT_IMAGE` lines of the
env file. Before asking for confirmation it shows the old and new tags, links
the upgrade guide for every major version you cross, and warns about downgrades
and tags it cannot compare, such as `latest`. It then pulls the images and
recreates the services; if the pull fails, the old tags are restored.
Non-interactive runs need `--yes`. A customized image line (another registry, a
digest) is not touched.

Migrations run when the new backend starts and cannot be undone by going back
to the old tag, so [back up](production-checklist.md#backups) first.
`eudiplo pull` downloads the configured images without changing anything.
Neither command removes volumes.

## Kubernetes instances

The CLI never applies manifests. It inspects and restarts the workloads you
deployed (see [Kubernetes](kubernetes.md)):

```bash
eudiplo instance add production \
  --target kubernetes \
  --url https://eudiplo.example.com \
  --context production \
  --namespace eudiplo

eudiplo ps --instance production
eudiplo logs --instance production --service backend --follow --tail 100
eudiplo restart --instance production --service backend
```

- `--context` and `--namespace` are passed explicitly to every `kubectl` call,
  so a command never acts on your current kubeconfig context.
- The workloads default to `backend=deployment/eudiplo` and
  `client=deployment/eudiplo-client`. Override them with
  `--workload backend=deployment/eudiplo-api,client=deployment/eudiplo-web`.
  `logs` and `restart` need `--service` when more than one workload is
  configured.
- `restart` prints workload, namespace and context, runs
  `kubectl rollout restart` and waits for the rollout (`--no-wait` returns
  immediately).
- `--read-only` registers an instance on which `restart` is refused.
- Set `EUDIPLO_KUBECTL` to use a `kubectl` binary that is not on the `PATH`.

`eudiplo doctor` checks the permissions with `kubectl auth can-i`. A Role for
the CLI:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: eudiplo-cli
  namespace: eudiplo
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "patch"]   # drop patch for --read-only instances
```

## Check an instance with doctor

```bash
export EUDIPLO_CLIENT_ID=root EUDIPLO_CLIENT_SECRET='<secret>'
eudiplo doctor --instance production --strict
```

`doctor` checks the public URL (HTTPS), API reachability, `/health`, TLS
certificate expiry (warning within 30 days), authentication, CLI/backend
version compatibility, KMS provider health and web client reachability, plus
the driver: the container runtime, Compose files and container health for
Compose; `kubectl`, namespace, permissions, workloads and service endpoints for
Kubernetes.

Each check reports `PASS`, `WARN`, `FAIL` or `SKIP`. The exit code is 1 if a
check failed; `--strict` also fails on warnings, `SKIP` never fails. `--all`
checks every registered instance.

The CLI gets its token from the built-in `POST /api/oauth2/token`. Without
`EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET`, the authentication check warns
(which fails `--strict`) and the version and KMS checks are skipped. With an
external OIDC provider that endpoint is disabled, so the authenticated checks
fail when the variables are set.

## Environment variables

| Variable                                     | Effect                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `EUDIPLO_CLI_HOME`                           | Directory of `config.json` (default `~/.eudiplo`)                              |
| `EUDIPLO_CLI_CONFIG`                         | Path of the CLI config file; overrides `EUDIPLO_CLI_HOME`                     |
| `EUDIPLO_CLIENT_ID`, `EUDIPLO_CLIENT_SECRET` | Client credentials for the authenticated `doctor` checks                      |
| `EUDIPLO_TOKEN`                              | Access token for `config export`, `plan`, `import`, `operations`, `recover`   |
| `EUDIPLO_IMAGE_TAG`                          | Image tag for `demo` and `init` (default `latest`)                            |
| `EUDIPLO_CONTAINER_RUNTIME`                  | `docker` or `podman` for Compose instances                                    |
| `EUDIPLO_KUBECTL`                            | Path of the `kubectl` binary for Kubernetes instances                         |
| `EUDIPLO_INSTALL_DIR`                        | Install directory used by `install.sh` (default `~/.local/bin`)               |

## Shell completion

```bash
source <(eudiplo completion bash)     # zsh: eudiplo completion zsh
eudiplo completion fish | source
```

Save the output in your shell's completion directory to load it permanently.
