---
title: Testing
---

# Testing

EUDIPLO uses Vitest for colocated unit tests and backend end-to-end (E2E) tests. Run focused unit tests while developing, then add the relevant E2E suite when a change affects module wiring, persistence, or a protocol flow.

## Running Tests Locally

To run all workspace unit tests locally:

```bash
pnpm run test
```

To target the backend or use watch mode:

```bash
pnpm --filter @eudiplo/backend run test
pnpm --filter @eudiplo/backend run test:watch
```

This uses [Vitest](https://vitest.dev) under the hood, which is configured for NestJS.

## Test Structure

Unit tests are located next to their implementation files:

```bash
src/
  service/
    my.service.ts
    my.service.spec.ts  <-- Test file
```

Architecture and dependency-boundary tests also use the `.spec.ts` suffix, so they run with the same backend unit-test command.

## Linting

Before pushing code, check linting rules and fix them:

```bash
pnpm run lint
```

The repository's Git pre-push hook also runs the Knip check automatically:

```bash
pnpm run knip
```

Install dependencies with `pnpm install` to enable the Husky hooks locally.

## GitHub Actions

Tests run automatically on every push to `main` or pull request via GitHub Actions.

You can find the workflow config in `.github/workflows/ci-and-release.yml`.

## Test Coverage

Coverage is generated when running the E2E tests. See [E2E Testing](#e2e-testing) for details.

This generates a report in the `/coverage` folder. Open `coverage/index.html` in your browser to view it.

Coverage is also accessible via [codecov](https://app.codecov.io/github/openwallet-foundation/eudiplo/tree/main).

## Code Quality (SonarCloud)

Static analysis and code quality metrics are tracked on [SonarCloud](https://sonarcloud.io/project/overview?id=openwallet-foundation_eudiplo).

:::info[Scope]
The SonarCloud analysis focuses on the **backend** (`apps/backend`). The Angular client is excluded from coverage reporting as it is considered optional and does not have E2E test coverage yet.
:::

## E2E Testing

Backend E2E tests are stored in `apps/backend/test/`. They verify the assembled application, including protocol flows and integrations with external services.

### Running E2E Tests Locally

Run the whole suite with one command:

```bash
pnpm --filter @eudiplo/backend run test:e2e:local
```

It builds `@eudiplo/config-format` and runs all suites except the [OIDF conformance tests](#oidf-conformance-testing) without collecting coverage.

Prerequisites:

- **Free port 3000.** The suites start the backend on `http://localhost:3000`. Stop a running `pnpm dev:backend` or `docker compose up` first. The run aborts with a clear error when the port is taken. Do not run two E2E runs in parallel on one machine.
- **Docker (optional).** The PostgreSQL, HashiCorp Vault, and S3 (RustFS) suites start containers through [Testcontainers](https://testcontainers.com/). Without a container runtime, these suites are skipped with a warning and everything else still runs. Set `E2E_SKIP_CONTAINERS=true` to skip them on purpose. In CI (`CI` is set), a missing runtime fails the run instead.

You do not need a `.env` file, a `/etc/hosts` entry, or the `test-rp` webhook server (`apps/webhook`):

- The suites ignore `apps/backend/.env`. Settings such as `PUBLIC_URL` from your development setup cannot leak into test runs. Test defaults come from `apps/backend/test/vitest.config.ts`.
- Outgoing webhook and trust list calls to `localhost:8787` are mocked with `nock`.
- The `host.testcontainers.internal` host entry is only required for the OIDF conformance tests.

Configuring the app under test: capability settings such as the public and internal URLs are read once when the Nest module is compiled. Set them through the `env` block of the Vitest config or `vi.stubEnv` before the module is created. `ConfigService.set()` after compilation does not affect them.

### Running E2E Tests in CI

The following command runs the E2E tests and also provides a coverage report:

```bash
pnpm --filter @eudiplo/backend run test:e2e
```

During test development, you can use watch mode to automatically re-run tests on file changes:

```bash
pnpm --filter @eudiplo/backend run test:e2e:watch
```

### Test Organization

E2E tests live in `apps/backend/test/*.e2e-spec.ts` files (not co-located with source code).

Common test categories include:

- **Protocol flows** — OID4VCI and OID4VP end-to-end scenarios
- **Configuration portability** — Import/export and startup config tests
- **Integration tests** — Database, KMS, and external service integration

### Coverage

Coverage reports are generated in the `/coverage` folder and are also available via [codecov](https://app.codecov.io/github/openwallet-foundation/eudiplo/tree/main).

### Playwright E2E (Future)

A `playwright/` directory exists at the repository root for potential browser-based E2E tests. This infrastructure is planned for future client UI testing.

## OIDF Conformance Testing

EUDIPLO includes dedicated tests for validating compliance with the [OpenID Foundation (OIDF) conformance suite](https://openid.net/certification/conformance/) for OID4VCI and OID4VP. These tests ensure that the implementation of OID4VCI (OpenID for Verifiable Credential Issuance) and OID4VP (OpenID for Verifiable Presentations) strictly follows the protocol specifications.

### Running Conformance Tests

The conformance tests are part of the E2E test suite and run automatically in the GitHub Actions CI pipeline for pull requests and on the `main` branch.

To run them locally:

```bash
pnpm --filter @eudiplo/backend run test:oidf
```

### Test Structure

The OIDF conformance tests are located at:

- `apps/backend/test/oidf/oidf-issuance.e2e-spec.ts` — OID4VCI issuer conformance tests
- `apps/backend/test/oidf/oidf-presentation.e2e-spec.ts` — OID4VP verifier conformance tests
- `apps/backend/test/oidf/oidf-setup.ts` — Shared OIDF test infrastructure
- `apps/backend/test/oidf/oidf-suite.ts` — OIDF suite integration client

### Environment Variables

The conformance tests can be configured with these environment variables:

- `VITE_OIDF_URL` — OIDF conformance suite URL (default: `https://localhost:8443`)
- `VITE_OIDF_DEMO_TOKEN` — Authentication token for the OIDF suite
- `VITE_OIDF_MODULES` — Comma-separated list of module filters
- `VITE_OIDF_MODULE_PATTERN` — Regular expression pattern for module filtering
- `VITE_OIDF_ENFORCE_MODULE_COVERAGE` — Fail on uncovered scenarios (default: `false`)
- `OIDF_EXPORT_LOGS` — Export OIDF test logs to `tmp/oidf-logs/` (enabled in CI)

### Test Workflow

1. **Container Setup** — The tests use containerized OIDF conformance suite instances
2. **Plan Creation** — Test plans are created for each protocol variant
3. **Test Execution** — Individual conformance modules are executed against the EUDIPLO backend
4. **Result Validation** — Test results are validated and logs are exported for failed tests
5. **Coverage Reporting** — Module coverage is tracked and reported

### Module Coverage

The tests maintain snapshot files that track which conformance modules are covered:

- `apps/backend/test/oidf/oidf-issuer-modules.snapshot.json`
- `apps/backend/test/oidf/oidf-verifier-modules.snapshot.json`

These snapshots are validated against the live OIDF plan and auto-updated when the conformance suite introduces new modules.

### Log Export

Failed test logs are automatically exported to:

- `tmp/oidf-logs/failed/{testInstanceId}/` — Individual failed test logs
- `tmp/oidf-logs/{planId}/` — Complete plan logs

These logs are uploaded as artifacts in GitHub Actions for debugging.

### CI/CD Integration

The conformance tests run in a separate job in the CI pipeline:

```yaml
test-e2e-oidf:
  name: E2E Tests (OIDF)
  runs-on: ubuntu-latest
  steps:
    - name: Run OIDF E2E tests
      run: pnpm run --filter @eudiplo/backend test:oidf
```

See `.github/workflows/ci-and-release.yml` for the complete workflow configuration.

### Certification Status

EUDIPLO is tested against the OIDF conformance suite for:

- **OID4VCI** — OpenID for Verifiable Credential Issuance
- **OID4VP** — OpenID for Verifiable Presentations

The conformance test results validate that EUDIPLO implements these protocols according to the official specifications.
