---
title: CLI Development
---

# CLI development

The CLI (`apps/cli`, package `@eudiplo/cli`) is built with Commander. Each command is a module directory whose `index.ts` declares the grammar and whose `action.ts` holds the workflow; root commands are registered in `src/runtime.ts`. The conventions are in `apps/cli/src/commands/README.md` and the package README. Using the CLI is covered in [Operate: CLI](../operate/cli.md).

## Build, test, lint

Run from the repository root (`@eudiplo/config-format` must be built first):

```bash
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/cli build
pnpm --filter @eudiplo/cli test
pnpm --filter @eudiplo/cli lint
pnpm --filter @eudiplo/cli format:check
```

## Run source changes directly

The `dev` script runs the CLI through `tsx` with `apps/cli` as working directory, so you can try a change without building or installing. It needs the bundled assets, so run `assets:sync` once (a build does it too):

```bash
pnpm --filter @eudiplo/cli assets:sync
pnpm --filter @eudiplo/cli dev config validate tenant ../../assets/config/demo
pnpm --filter @eudiplo/cli dev config validate tenants ../../assets/config --format json
```

Validating the checked-in demo tenant is a quick smoke test for schema and validator changes.

## Test the standalone executable

Build the Node.js single executable (SEA) and run it before a release:

```bash
pnpm --filter @eudiplo/cli build:sea
apps/cli/dist-sea/eudiplo config validate tenant assets/config/demo
```

`build:publish` produces the bundled npm package instead; CI packs it and runs it outside the workspace.

## Bundled assets

Every build first runs `assets:sync` and `assets:check`, which copy these canonical sources into `apps/cli/templates/`:

- `deployment/docker-compose/docker-compose.yml` → the Compose template written by `eudiplo init`
- `assets/config/demo/**` → the `eudiplo demo` tenant
- `schemas/*.schema.json` → the schemas used by `config validate`

Edit the canonical files, not the copies. After changing a backend import schema, run `pnpm gen:api` first so the schemas are current. A change to the Compose template only reaches new projects: existing projects keep their `eudiplo.compose.yaml`, and `eudiplo upgrade` only rewrites the image tags in `.eudiplo.env`.

The command reference on [Reference: CLI](../reference/cli.md) is generated from the Commander program, so the `description()` and option texts are the documentation.
