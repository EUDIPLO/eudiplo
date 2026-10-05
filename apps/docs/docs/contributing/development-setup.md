---
title: Development Setup
---

# Development setup

This page gets the repository running from source: backend, web client and documentation. To run a released version instead, follow the [Foundation cookbook](../cookbooks/foundation.md).

## Prerequisites

- **Node.js 22.22.3 or newer** (the backend's `engines` field; CI and the Docker images use Node 26).
- **pnpm** in the version pinned by `packageManager` in the root `package.json`. Enable it with `corepack enable`. Node 25 and newer no longer ship Corepack: run `npm install -g corepack` first.
- **Git**.
- **Docker** (optional): needed for the PostgreSQL, Vault and S3 E2E suites, the OIDF conformance tests and the Compose setup.

No local Node.js? Use the [dev container](#dev-container).

## 1. Install

```bash
git clone https://github.com/openwallet-foundation/eudiplo.git
cd eudiplo
corepack enable
pnpm install
```

`pnpm install` also installs the Husky Git hooks described in [Code quality](./code-quality.md#git-hooks).

## 2. Build the shared packages

The backend and the CLI import `@eudiplo/config-format`, the client imports `@eudiplo/sdk-core`. Both are consumed from their `dist/` build:

```bash
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/sdk-core build
```

Rebuild a package after you change it.

## 3. Configure the backend

The backend reads `.env` from its working directory. For `pnpm dev:backend` that is `apps/backend/.env`:

```bash
cp .env.example apps/backend/.env
```

Set `MASTER_SECRET` (for example `openssl rand -base64 32`), `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET`. The defaults use SQLite and local file storage. Every variable is listed in the [environment variable reference](../reference/environment-variables.md).

Settings you often need locally:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | URL wallets use to reach the backend (`.env.example`: `http://localhost:3000`). A wallet on a phone needs a public HTTPS URL; the [Foundation cookbook](../cookbooks/foundation.md) shows how to get one with a tunnel. |
| `OUTBOUND_URL_ALLOW_HTTP=true`, `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true` | Webhooks, attribute providers, metadata imports, schema metadata downloads, trust lists, status lists, federation entities and external or upstream authorization servers reject HTTP and private or loopback targets by default. Enable both to call services on your machine. The dev container sets both. |
| `CONFIG_IMPORT_MODE=upsert` | Imports the tenant configuration in `CONFIG_FOLDER` (default: `assets/config`, the demo tenant) on every start. The default is `disabled`. |
| `SKIP_*` | Turn off a check of the normal flow for interoperability testing. Active flags are logged as warnings on startup. See [skip flags](../reference/environment-variables.md#skip-flags). |

## 4. Run the applications

| Command | Starts | URL |
| --- | --- | --- |
| `pnpm dev:backend` | Backend (`nest start --watch`) | `http://localhost:3000`, Swagger UI at `/api/docs` |
| `pnpm dev:client` | Web client (`ng serve`; runs `gen:api` first) | `http://localhost:4200` |
| `pnpm --filter test-rp dev` | Example webhooks and attribute provider (Cloudflare Worker) | `http://localhost:8787` |
| `pnpm --filter kms-reference dev` | Reference service for the HTTP KMS adapter | `http://localhost:8788` |
| `pnpm --filter @eudiplo/docs start` | Documentation with live reload ([run `prebuild` once first](./documentation.md#run-it-locally)) | `http://127.0.0.1:3003` |

`pnpm dev` starts every package that has a `dev` script in parallel (backend, client, both workers and the SDK in watch mode). Other backend scripts: `start` (no watch), `start:debug` (watch with the Node inspector), `start:prod` (runs `dist/main.js`).

To run the published images instead of your source, use the root `docker-compose.yml` (`docker compose up -d`); it reads the root `.env` and mounts `./assets` as configuration.

## 5. Regenerate generated code

| Command | Regenerates | When |
| --- | --- | --- |
| `pnpm gen:api` | JSON schemas from the backend Zod/DTO schemas: `schemas/*.schema.json`, the client's `utils/schemas.json`, the CLI validator registry and `.vscode/settings.json` | After changing a configuration or import schema. Runs automatically before the client's `dev`, `build` and `test`. Does not need a running backend. |
| `pnpm gen:sdk` | `packages/eudiplo-sdk-core/src/api` from `http://localhost:3000/api/docs-json`, then builds the SDK | After changing a management endpoint or DTO. **Needs a running backend.** |
| `pnpm gen:all` | Both, in that order | |

Commit the regenerated files with the change that caused them. Format snapshots under `schemas/v*/` are not regenerated; see [Configuration schemas](./configuration-schemas.md).

## Database migrations

The backend applies pending migrations on startup (`DB_MIGRATIONS_RUN=true`, the default). To work with migrations manually, run from `apps/backend`:

```bash
pnpm migration:generate --name=AddMyColumn   # from entity changes
pnpm migration:create --name=AddMyColumn     # empty migration
pnpm migration:run
pnpm migration:revert                        # reverts the last migration
pnpm migration:show
```

The TypeORM CLI reads `apps/backend/.env` and the root `.env` (`src/database/data-source.ts`). How to write a migration that works on SQLite and PostgreSQL: [Backend architecture](./backend-architecture.md#a-database-migration).

## Iterate on tenant configuration

Against the backend from source:

1. Edit the files under `CONFIG_FOLDER/<tenant-id>/` (for example `assets/config/demo/`).
2. Validate them with the CLI from source:

    ```bash
    pnpm --filter @eudiplo/cli assets:sync   # once; the CLI bundles the schemas
    pnpm --filter @eudiplo/cli dev config validate tenant ../../assets/config/demo
    ```

3. Restart the backend so the startup import runs again (`CONFIG_IMPORT_MODE=upsert` applies changed files).

Against an instance managed by the CLI (`eudiplo init`), the loop is:

```bash
eudiplo config tenant validate acme   # files in config/acme/
eudiplo down && eudiplo up            # restart so the startup import runs again
eudiplo doctor                        # reachability and health
eudiplo logs --follow                 # backend and client logs
```

The CLI project keeps its runtime environment in `.eudiplo.env`, the Compose file in `eudiplo.compose.yaml` and the configuration in `config/` (`config/kms.json`, `config/<tenant-id>/…`). Restart after changing `.eudiplo.env`. Command details: [CLI](../operate/cli.md).

## Dev container

The repository ships a VS Code dev container (`.devcontainer/`) with Node.js, pnpm, Git and the recommended extensions. Open the folder in VS Code and run **Dev Containers: Reopen in Container**; `pnpm install` runs automatically. GitHub Codespaces uses the same configuration. The container sets `PUBLIC_URL`, `MASTER_SECRET`, `AUTH_CLIENT_SECRET` and both `OUTBOUND_URL_ALLOW_*` flags and forwards ports 3000 and 4200. Details: [`.devcontainer/README.md`](https://github.com/openwallet-foundation/eudiplo/blob/main/.devcontainer/README.md).

## Repository layout

```text
.
├── apps/
│   ├── backend/        # @eudiplo/backend: NestJS API and protocol implementation
│   ├── client/         # @eudiplo/client: Angular web client
│   ├── cli/            # @eudiplo/cli: the eudiplo command-line tool
│   ├── docs/           # @eudiplo/docs: this documentation site (Docusaurus)
│   ├── webhook/        # test-rp: example webhooks and attribute provider (Cloudflare Worker)
│   ├── kms-reference/  # kms-reference: reference service for the HTTP KMS adapter
│   └── website/        # @eudiplo/website: eudiplo.dev, CLI installer and published config schemas
├── packages/
│   ├── eudiplo-config-format/  # @eudiplo/config-format: config envelope, format versions, migrations
│   └── eudiplo-sdk-core/       # @eudiplo/sdk-core: generated API client and helpers (published to npm)
├── schemas/            # generated JSON schemas; schemas/v*/ holds the published, immutable snapshots
├── assets/config/demo/ # demo tenant configuration (startup import, `eudiplo demo` template)
├── deployment/         # Docker Compose and Kubernetes examples
├── monitor/            # Prometheus, Grafana, Loki and Tempo stack
└── scripts/            # schema generation, release and CI helpers
```

Add a dependency to the package that uses it (`pnpm --filter @eudiplo/backend add <name>`). The root `package.json` only holds tooling shared by several packages.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Backend exits with a configuration validation error | A required variable is missing in `apps/backend/.env`; the message names it. |
| `Cannot find module '@eudiplo/config-format'` or `@eudiplo/sdk-core` | Build the shared packages ([step 2](#2-build-the-shared-packages)). |
| Webhook or attribute provider on `localhost` is rejected | Set both `OUTBOUND_URL_ALLOW_*` flags. |
| `pnpm gen:sdk` fails to fetch the spec | Start the backend first; the generator reads `http://localhost:3000/api/docs-json`. |
| Port 3000 is busy | Stop the other backend or Compose stack; E2E tests also need the port. |
