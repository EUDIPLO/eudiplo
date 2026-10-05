---
title: Contributing
---

# Contributing

This section is for people who change EUDIPLO itself. Pick the task below; the process rules (issues, pull requests, DCO sign-off, commit messages) live in [`CONTRIBUTING.MD`](https://github.com/EUDIPLO/eudiplo/blob/main/CONTRIBUTING.MD).

| I want to… | Read |
| --- | --- |
| Set up the repository and run everything locally | [Development setup](./development-setup.md) |
| Change the backend (endpoint, migration, env var, adapter) | [Backend architecture](./backend-architecture.md) |
| Change the web client | [Client development](./client.md) |
| Change the CLI | [CLI development](./cli.md) |
| Change a configuration file format | [Configuration schemas](./configuration-schemas.md) |
| Run or write tests (unit, E2E, OIDF conformance) | [Testing](./testing.md) |
| Format and lint my change | [Code quality](./code-quality.md) |
| Write or fix documentation | [Documentation](./documentation.md) |
| Cut a release | [Releases](./releases.md) |

## Quick start

```bash
pnpm install
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/sdk-core build
cp .env.example apps/backend/.env   # then set MASTER_SECRET, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET

pnpm dev:backend   # NestJS API on http://localhost:3000 (nest start --watch)
pnpm dev:client    # Angular client on http://localhost:4200
```

The backend package also has `start` (no watch) and `start:debug` (watch with the Node inspector). [Development setup](./development-setup.md) explains each step.

## Before you open a pull request

- Run the checks of the packages you touched: `pnpm run lint`, `pnpm run format:check` and the relevant tests.
- Sign off every commit (`git commit -s`) and use [Conventional Commits](https://www.conventionalcommits.org/).
- A breaking change needs a `!` or a `BREAKING CHANGE:` footer and an entry in the [upgrade guide](../upgrade/index.md) of the next major.
- Update the documentation page that owns the behavior you changed.
