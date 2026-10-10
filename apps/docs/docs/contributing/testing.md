---
title: Testing
---

# Testing

All TypeScript packages test with [Vitest](https://vitest.dev). Run the unit tests of the package you change while you work, then the E2E suites when a change affects module wiring, persistence or a protocol flow. `pnpm test` at the root runs the `test` script of every package.

| Suite | Location | Command | CI job |
| --- | --- | --- | --- |
| Backend unit and architecture | `apps/backend/src/**/*.spec.ts`, `apps/backend/test/architecture/` | `pnpm --filter @eudiplo/backend test` | Test Coverage Report |
| Backend E2E | `apps/backend/test/**/*.e2e-spec.ts` | `pnpm --filter @eudiplo/backend test:e2e:local` | E2E Tests (non-OIDF) |
| OIDF conformance | `apps/backend/test/oidf/` | `pnpm --filter @eudiplo/backend test:oidf` | E2E Tests (OIDF) |
| CLI | `apps/cli/test/**/*.test.ts`, `apps/cli/src/**/*.spec.ts` | `pnpm --filter @eudiplo/cli test` | Build CLI |
| Config format, SDK | `packages/*/src/**/*.spec.ts`, `packages/eudiplo-sdk-core/test/` | `pnpm --filter @eudiplo/config-format test`, `pnpm --filter @eudiplo/sdk-core test` | — |
| Client unit | `apps/client/src/**/*.spec.ts` | `pnpm --filter @eudiplo/client test` | Build Client |
| Client browser (Playwright) | `apps/client/e2e/` | `E2E_USE_BUILD=true pnpm --filter @eudiplo/client e2e` | E2E Tests (Client) |
| Documentation tooling | `apps/docs/scripts/` | `pnpm --filter @eudiplo/docs test` | Build Documentation |

CI is defined in `.github/workflows/ci-and-release.yml` and runs on pull requests, the merge queue and pushes to `main`.

## Backend unit tests

Unit tests sit next to the code as `*.spec.ts` and run with SWC (`apps/backend/vitest.config.ts`):

```bash
pnpm --filter @eudiplo/backend test                 # all unit tests
pnpm --filter @eudiplo/backend test:watch
pnpm --filter @eudiplo/backend exec vitest run src/session/application/session-store.spec.ts
pnpm --filter @eudiplo/backend test:debug           # with the Node inspector
```

Test use cases with fake ports, without a Nest `TestingModule`. Adapters with several implementations share a contract suite (`*.contract.ts`, for example `test/session/session-repository.contract.ts`) that runs against SQLite and PostgreSQL.

The architecture checks (`src/platform/module-boundaries.spec.ts`, `test/architecture/dependency-rules.spec.ts`) run with the unit tests. What they enforce and how to update the ratchet baseline: [Backend architecture](./backend-architecture.md#current-boundary-enforcement).

## E2E testing

Backend E2E tests start the assembled Nest application and drive it over HTTP. They live under `apps/backend/test/`, grouped by area (`issuance/`, `presentation/`, `session/`, `trust-list/`, `config-portability/`, `persistence/`, `key/`, …) with shared helpers in `utils.ts`, `utils-mdoc.ts` and `shared/`, and fixtures in `fixtures/`.

### Running E2E tests locally

```bash
pnpm --filter @eudiplo/backend test:e2e:local
```

The script builds `@eudiplo/config-format` and runs every suite except the OIDF conformance tests, without coverage. Prerequisites:

- **Port 3000 must be free.** The suites start the backend there and abort with a clear error when the port is taken. Stop `pnpm dev:backend` or a Compose stack first, and do not run two E2E runs in parallel.
- **Docker is optional.** The PostgreSQL, HashiCorp Vault and S3 (RustFS) suites start containers with [Testcontainers](https://testcontainers.com/). Without a container runtime they are skipped with a warning. Set `E2E_SKIP_CONTAINERS=true` to skip them on purpose. In CI (`CI` set) a missing runtime fails the run.

You need no `.env` file, no hosts entry and no running `test-rp` webhook:

- The suites ignore `apps/backend/.env`, so development settings cannot leak into a run. Test defaults (secrets, `DB_SYNCHRONIZE=true`, both `OUTBOUND_URL_ALLOW_*` flags) come from the `env` block of `apps/backend/test/vitest.config.ts`.
- Outgoing webhook and trust-list calls to `localhost:8787` are mocked with `nock`.

Capability settings such as the public and internal URLs are read once when the Nest module is compiled. Set them in the Vitest `env` block or with `vi.stubEnv` before the module is created; `ConfigService.set()` afterwards has no effect.

### Watch mode and coverage

```bash
pnpm --filter @eudiplo/backend test:e2e:watch   # re-run on change
pnpm --filter @eudiplo/backend test:e2e         # with coverage, as in CI
```

The CI job also adds the `host.testcontainers.internal` hosts entry and starts `test-rp`; locally neither is required.

## OIDF conformance testing

The conformance tests run the [OpenID Foundation conformance suite](https://openid.net/certification/about-conformance-suite/) locally and execute its OID4VCI issuer and OID4VP verifier test plans against EUDIPLO. Testcontainers starts the suite (MongoDB, the suite server and its nginx front end on port 8443); the tests start the backend at `https://host.testcontainers.internal:3000`. No public deployment and no hosted suite are needed.

Prerequisites:

- Docker, and free ports 3000 and 8443.
- A hosts entry so the suite containers and your machine resolve the backend the same way:

    ```bash
    echo "127.0.0.1 host.testcontainers.internal" | sudo tee -a /etc/hosts
    ```

Run them:

```bash
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/backend test:oidf
```

| File | Purpose |
| --- | --- |
| `oidf-issuance.e2e-spec.ts` | OID4VCI issuer test plans |
| `oidf-presentation.e2e-spec.ts` | OID4VP verifier test plans |
| `oidf-setup.ts` | Container lifecycle |
| `oidf-suite.ts` | Client for the suite's API, log export |
| `oidf-issuer-modules.snapshot.json`, `oidf-verifier-modules.snapshot.json` | Modules the plans contain; rewritten when the suite's plan changes, so commit the updated file |

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_OIDF_MODULES` | all | Comma-separated module filter |
| `VITE_OIDF_MODULE_PATTERN` | — | Regular expression module filter |
| `VITE_OIDF_ENFORCE_MODULE_COVERAGE` | `false` | Fail instead of warn when scenarios are not covered |
| `VITE_OIDF_URL` | `https://localhost:8443` | Suite URL |
| `VITE_OIDF_DEMO_TOKEN` | — | API token for the suite |
| `VITE_DOMAIN` | `host.testcontainers.internal:3000` | Host of the backend's `PUBLIC_URL` |
| `OIDF_EXPORT_LOGS` (or `VITE_OIDF_EXPORT_LOGS`) | on | Export suite logs; `false` speeds up local runs |
| `OIDF_TEARDOWN_PER_FILE` (or `VITE_OIDF_TEARDOWN_PER_FILE`) | on | Tear the containers down after each spec file; `false` reuses them within one run |

Logs land in `tmp/oidf-logs/<planId>/` and, for failed modules, `tmp/oidf-logs/failed/<testInstanceId>/`. CI uploads them as the `oidf-test-results` artifact. Wait thresholds (`OIDF_WAIT_*`) and how to calibrate them are described in `apps/backend/test/oidf/README.md`.

## Client tests

Unit tests run with Vitest through the Angular builder. The Playwright browser tests run in the **E2E Tests (Client)** job against the production client build and the built backend. Setup and conventions: [Client development](./client.md#tests).

## Coverage

| Report | Command | Output |
| --- | --- | --- |
| Backend unit | `pnpm --filter @eudiplo/backend exec vitest run --coverage --config ./vitest.config.ts` | `apps/backend/coverage/unit/` |
| Backend E2E | `pnpm --filter @eudiplo/backend test:e2e` | `apps/backend/coverage/e2e/` |
| Client E2E | `E2E_USE_BUILD=true E2E_COVERAGE=true pnpm --filter @eudiplo/client e2e` (after building, see [Client development](./client.md#tests)) | `apps/client/coverage/e2e/` |

The backend reports are text, LCOV (HTML under `lcov-report/`) and Cobertura; the client report is HTML (`index.html`), LCOV and Cobertura. The **Test Coverage Report** CI job runs the backend suites and uploads their Cobertura files to **GitHub Code Quality** (labels `backend-unit` and `backend-e2e`); the **E2E Tests (Client)** job does the same for the client (label `client-e2e`). Both upload for pushes and for pull requests from branches of the repository. Static analysis runs on [SonarCloud](https://sonarcloud.io/project/overview?id=EUDIPLO_eudiplo), configured in `.sonarcloud.properties` (backend and client sources; the client is excluded from coverage).
