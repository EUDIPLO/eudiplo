# EUDIPLO CLI

The EUDIPLO CLI provides deployment-neutral commands for inspecting an EUDIPLO
instance and deployment-driver commands for local Compose demos.

For installation, command reference, configuration validation, standalone
releases, and local development, see the [CLI documentation](../docs/docs/operate/cli.md).

## Quick Start

This package is the npm distribution of the **EUDIPLO CLI** and requires
Node.js 22.12+.

For users who do not want a local Node.js dependency, use the standalone CLI
installer instead: `curl -fsSL https://eudiplo.dev/install.sh | bash`

```bash
npx @eudiplo/cli demo ./eudiplo-demo
npx @eudiplo/cli instance add production --url https://eudiplo.example.com
npx @eudiplo/cli instance ls
npx @eudiplo/cli instance show production
npx @eudiplo/cli instance use production
npx @eudiplo/cli doctor --instance production
```

`demo` creates a local editable demo deployment, writes `.eudiplo.demo.env`,
copies canonical demo configuration into `config/demo`, and starts the
minimal `compose` stack. It always uses SQLite, local file storage,
database-backed key management, the backend, and the web client.

- Backend image: `ghcr.io/openwallet-foundation/eudiplo:<tag>`
- Client image: `ghcr.io/openwallet-foundation/eudiplo-client:<tag>`

Tag selection defaults to `latest` for both images. Use `--image-tag` (or
`EUDIPLO_IMAGE_TAG`) to select `main`, a release tag, or an immutable SHA tag.

The generated demo config remains editable after creation. Existing files are
preserved unless you pass `--force`.

The standalone CLI and this npm package are two distributions of the same
`eudiplo` command. The standalone CLI removes the Node.js requirement, but
Docker and Docker Compose, or Podman and Podman Compose, are still required for
the demo deployment. Docker is preferred by default; set
`EUDIPLO_CONTAINER_RUNTIME=podman` to force Podman.

## Package and Binary Names

The npm package is scoped as `@eudiplo/cli`, while the installed binary is
`eudiplo`. That means one-off usage should use `npx @eudiplo/cli`; after global
or project installation, run `eudiplo` directly.

```bash
npm install -g @eudiplo/cli
eudiplo status

pnpm add -D @eudiplo/cli
pnpm eudiplo status
```

## Uninstall

Use the removal path that matches how the CLI was installed:

```bash
# Standalone Linux/macOS installer
rm "${EUDIPLO_INSTALL_DIR:-$HOME/.local/bin}/eudiplo"

# npm global install
npm uninstall -g @eudiplo/cli

# project dependency
pnpm remove @eudiplo/cli
```

The CLI stores instance metadata in `~/.eudiplo/config.json` by default. Remove
`~/.eudiplo` only if you also want to delete local CLI instance registrations.

## Compose Driver Commands

Compose driver commands require a `compose` instance:

```bash
eudiplo init
eudiplo init ./eudiplo-minimal --preset minimal
eudiplo init ./eudiplo-standard --preset standard --start
eudiplo init --database postgres --storage local --kms vault
eudiplo init --preset standard --demo-tenant
eudiplo init --target compose --demo
eudiplo init --target compose --demo --image-tag main
eudiplo init --target compose --no-client
eudiplo up
eudiplo down
eudiplo ps
eudiplo logs --service eudiplo --follow --tail 100 --since 10m
eudiplo restart --service eudiplo-client
eudiplo pull
eudiplo upgrade --image-tag 8.1.0
eudiplo demo --reset --force
```

In an interactive terminal, `init` opens a wizard for the project directory,
preset, components, public URL, authentication, client, and startup choices.
For scripts and CI, the same values can be supplied with `--directory`,
`--preset`, `--database`, `--storage`, `--kms`, `--public-url`,
`--auth-client-id`, and `--auth-client-secret`. The directory can also be passed
positionally. When it is omitted, the wizard suggests `./`; non-interactive and
`--yes` runs use `./` automatically. Its absolute path is saved with the
instance, allowing later Compose commands to run from a different working
directory.

Interactive `demo` runs use the same directory prompt. Pass a positional
directory, `--directory`, or `--yes` to skip it.

`init --preset minimal` writes a local `.eudiplo.env` using SQLite and local
storage. `standard` provisions PostgreSQL and RustFS, while `full` additionally
provisions Vault. Arbitrary combinations are supported through the component
flags.

Every initialized project contains one mounted `config/` root. Global KMS
configuration is written to `config/kms.json`, while tenant configuration is
stored under `config/<tenant-id>/`. The demo tenant is excluded by default and
can be added with `--demo-tenant`.

`init --target compose --demo` writes demo-specific assets (`.eudiplo.demo.env`
and `config/demo`) without starting the Compose runtime. Add `--no-client`
to generate a small Compose override that skips the web client container.

`demo --reset --force` stops the managed demo stack, removes managed demo
volumes, and recreates only CLI-managed demo assets.

## Local Tenant Configuration Commands

```bash
eudiplo config tenant list
eudiplo config tenant create acme --name "Acme GmbH"
eudiplo config tenant create sample --template demo
eudiplo config tenant remove acme --force
```

The aliases `ls`, `new`, `rm`, and `delete` are also supported. These commands manage
local config-import folders only; removing a folder does not delete an already
imported tenant from a running EUDIPLO instance.

If a driver-specific command is used with an unsupported target, the CLI exits
with a clear error, for example:

```text
logs is not available for externally managed deployments
```

## Configuration

The CLI stores instance metadata outside the source tree. By default it writes to
`~/.eudiplo/config.json`. Override the location for tests or isolated runs with:

```bash
EUDIPLO_CLI_HOME=/tmp/eudiplo-cli eudiplo config validate
EUDIPLO_CLI_CONFIG=/tmp/eudiplo-cli/config.json eudiplo config validate
```

Print the resolved file path or inspect the validated configuration with:

```bash
eudiplo config path
eudiplo config show
eudiplo config show --json
```

Do not store secrets in the CLI config. Commands that need authenticated API
access read credentials from environment variables such as `EUDIPLO_CLIENT_ID`
and `EUDIPLO_CLIENT_SECRET`.

## Shell Completion

The CLI generates completion scripts for Bash, Zsh, Fish, and PowerShell. For
the current shell session, use one of:

```bash
source <(eudiplo completion bash)
source <(eudiplo completion zsh)
eudiplo completion fish | source
eudiplo completion powershell | Out-String | Invoke-Expression
```

## Single Executable Application

To produce a standalone CLI binary with Node.js SEA support, run:

```bash
pnpm --filter @eudiplo/cli build:sea
```

This writes the executable to `apps/cli/dist-sea/eudiplo` on Linux/macOS and
`apps/cli/dist-sea/eudiplo.exe` on Windows, while bundling the Compose template
as a SEA asset.

### Supported standalone platforms

The versioned release publishes archive files for the currently supported native
platforms:

- Linux x64: `eudiplo-vVERSION-linux-x64.tar.gz`
- Linux arm64: `eudiplo-vVERSION-linux-arm64.tar.gz`
- macOS arm64: `eudiplo-vVERSION-macos-arm64.tar.gz`
- Windows x64: `eudiplo-vVERSION-windows-x64.zip`

### Install and verify a release archive

Extract the archive for the matching platform and run the executable directly:

```bash
# Linux / macOS
curl -LO https://github.com/openwallet-foundation/eudiplo/releases/download/vVERSION/eudiplo-vVERSION-linux-x64.tar.gz
mkdir -p ~/.local/bin
 tar -xzf eudiplo-vVERSION-linux-x64.tar.gz -C ~/.local/bin
 ~/.local/bin/eudiplo --help

# Windows PowerShell
Invoke-WebRequest -Uri "https://github.com/openwallet-foundation/eudiplo/releases/download/vVERSION/eudiplo-vVERSION-windows-x64.zip" -OutFile "eudiplo-vVERSION-windows-x64.zip"
Expand-Archive -Path .\eudiplo-vVERSION-windows-x64.zip -DestinationPath .
.\eudiplo.exe --help
```

The release also attaches `SHA256SUMS.txt`. Verify the downloaded archive before
running it:

```bash
sha256sum -c SHA256SUMS.txt
```

The standalone binary does not replace Docker, Podman, or Compose. You still
need a container runtime to run the local deployment stack, but you do not need a
local Node.js installation just to use the CLI itself.

## Developing and Extending the CLI

The CLI uses Commander and an injectable `CommandContext`. Command definitions
are organized under `src/commands`; `src/runtime.ts` only assembles the command
tree and connects Commander output and exit handling to the current context.

### Running the CLI locally

Append CLI arguments directly after the `dev` script. `init` is a root command,
while `config` contains only configuration-related subcommands:

```bash
pnpm --filter @eudiplo/cli dev init ./eudiplo-local --yes
pnpm --filter @eudiplo/cli dev config tenant list
```

Generated Compose projects use `latest` by default and do not derive container
tags from `apps/cli/package.json`. Select `main` or an immutable SHA explicitly
when testing changes that require a different backend or client build:

```bash
pnpm --filter @eudiplo/cli dev demo ./eudiplo-demo --image-tag main
```

Install the JSON Schemas bundled with the CLI into a VS Code workspace and
associate them with the local tenant configuration tree:

```bash
eudiplo config editor setup . --config-directory ./config
```

The command merges `.vscode/settings.json` without removing unrelated settings
or JSONC comments and can safely be rerun after a CLI upgrade.

List the complete command tree or render the same reference as Markdown:

```bash
eudiplo commands
eudiplo commands --format markdown
```

The documentation prebuild uses the Markdown renderer directly, keeping the
published command reference synchronized with Commander definitions.

Use a new project directory or add `--force` when regenerating an existing
project, because the CLI preserves managed environment files by default. The
`version` command still reports the CLI package version, but that value is not
used for container image selection.

```text
src/
├── runtime.ts                 # creates the root Commander program
├── commands/
│   ├── demo/
│   │   ├── index.ts           # command registration and options
│   │   └── action.ts          # demo workflow
│   ├── init/
│   │   ├── index.ts           # command registration and wizard options
│   │   └── action.ts          # initialization workflow
│   ├── instance/
│   │   ├── index.ts           # command group and its subcommands
│   │   └── action.ts          # instance persistence
│   └── config/
│       ├── index.ts           # config group
│       ├── editor/            # VS Code schema setup command module
│       ├── validate/          # validation command module
│       └── tenant/            # tenant-config command module
├── services/
│   ├── cli-config.ts          # persisted CLI instance configuration
│   ├── compose-project.ts     # generated Compose assets
│   ├── deployment-drivers.ts  # Compose and external drivers
│   └── diagnostics.ts         # deployment health checks
└── types.ts                   # injectable context and shared CLI types
```

### Adding a root command

Create a directory for the command with `index.ts` as its public entrypoint and
`action.ts` for its workflow. Declare arguments, options, validation,
descriptions, and aliases in `index.ts` so generated help remains the source of
truth.

```ts
// commands/example/index.ts
import { Command } from 'commander';
import type { CommandContext } from '../../types.js';
import type { SetExitCode } from '../shared.js';
import { runExample } from './action.js';

export function createExampleCommand(
  context: CommandContext,
  setExitCode: SetExitCode,
): Command {
  return new Command('example')
    .description('Describe what the command does')
    .requiredOption('--input <path>', 'input file')
    .action(async (options) => {
      setExitCode(await runExample(options.input, context));
    });
}
```

```ts
// commands/example/action.ts
import type { CommandContext } from '../../types.js';

export async function runExample(
  input: string,
  context: CommandContext,
): Promise<number> {
  context.stdout.write(`Processing ${input}\n`);
  return 0;
}
```

Register the factory once in `createProgram` in `src/runtime.ts`. Do not add a
root dispatch switch or manually maintained help text.

### Adding nested commands

Create a parent `Command`, add independently configured child modules with
`addCommand`, and return the parent from its factory. Each nested command gets
the same `index.ts` plus `action.ts` structure. `config/tenant` and
`config/validate` are the reference patterns.

Keep these boundaries when extending the command tree:

- A command module owns its registration, options, action, and command-specific
  helpers.
- `services/` is only for infrastructure shared by multiple command modules,
  such as config persistence, Compose generation, and instance selection.
- Load CLI state lazily inside actions that require it; help must work without a
  valid local configuration.
- Write through `CommandContext.stdout` and `CommandContext.stderr`; do not call
  `console.log` or `process.exit` from a command.
- Throw normal errors for operational failures. Let Commander handle unknown
  options, required arguments, choices, aliases, and contextual help.
- Prefer a coherent command structure over preserving accidental parser
  behavior. Document intentional breaking syntax changes in the user guides.

Runtime dependencies are welcome when they materially improve usability or
maintainability. They must support ESM, Node.js 22.12+, TypeScript, and the
single-executable bundle. Avoid dependencies that require spawning separate
subcommand executables, because the released CLI is also packaged as one SEA
binary.

### Testing a command change

Exercise commands through `runCli(args, context)` so tests cover the real
Commander tree while keeping output, environment variables, prompts, and
network access injectable. Add coverage for successful execution, invalid
arguments or options, and the relevant help level.

Run the complete CLI verification before submitting a change:

```bash
pnpm --filter @eudiplo/cli test
pnpm --filter @eudiplo/cli lint
pnpm --filter @eudiplo/cli build
pnpm --filter @eudiplo/cli build:sea:bundle
```
