---
title: E2E Testing
---

# E2E Testing

Backend E2E tests are stored in `apps/backend/test/`. They verify the assembled application, including protocol flows and integrations with external services.

## Running E2E Tests Locally

Run the whole suite with one command:

```bash
pnpm --filter @eudiplo/backend run test:e2e:local
```

It builds `@eudiplo/config-format` and runs all suites except the [OIDF conformance tests](./conformance-testing.md) without collecting coverage.

Prerequisites:

- **Free port 3000.** The suites start the backend on `http://localhost:3000`. Stop a running `pnpm dev:backend` or `docker compose up` first. The run aborts with a clear error when the port is taken. Do not run two E2E runs in parallel on one machine.
- **Docker (optional).** The PostgreSQL, HashiCorp Vault, and S3 (RustFS) suites start containers through [Testcontainers](https://testcontainers.com/). Without a container runtime, these suites are skipped with a warning and everything else still runs. Set `E2E_SKIP_CONTAINERS=true` to skip them on purpose. In CI (`CI` is set), a missing runtime fails the run instead.

You do not need a `.env` file, a `/etc/hosts` entry, or the `test-rp` webhook server (`apps/webhook`):

- The suites ignore `apps/backend/.env`. Settings such as `PUBLIC_URL` from your development setup cannot leak into test runs. Test defaults come from `apps/backend/test/vitest.config.ts`.
- Outgoing webhook and trust list calls to `localhost:8787` are mocked with `nock`.
- The `host.testcontainers.internal` host entry is only required for the OIDF conformance tests.

Configuring the app under test: capability settings such as the public and internal URLs are read once when the Nest module is compiled. Set them through the `env` block of the Vitest config or `vi.stubEnv` before the module is created. `ConfigService.set()` after compilation does not affect them.

## Running E2E Tests in CI

The following command runs the E2E tests and also provides a coverage report:

```bash
pnpm --filter @eudiplo/backend run test:e2e
```

During test development, you can use watch mode to automatically re-run tests on file changes:

```bash
pnpm --filter @eudiplo/backend run test:e2e:watch
```

## Test Organization

E2E tests live in `apps/backend/test/*.e2e-spec.ts` files (not co-located with source code).

Common test categories include:

- **Protocol flows** — OID4VCI and OID4VP end-to-end scenarios
- **Configuration portability** — Import/export and startup config tests
- **Integration tests** — Database, KMS, and external service integration

## Coverage

Coverage reports are generated in the `/coverage` folder and are also available via [codecov](https://app.codecov.io/github/openwallet-foundation/eudiplo/tree/main).

## Playwright E2E (Future)

A `playwright/` directory exists at the repository root for potential browser-based E2E tests. This infrastructure is planned for future client UI testing.
