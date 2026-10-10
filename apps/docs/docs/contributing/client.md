---
title: Client Development
---

# Client development

The web client (`apps/client`, package `@eudiplo/client`) is an Angular application with standalone components and Angular Material. It talks to the backend only through the generated `@eudiplo/sdk-core` client.

## Commands

Run from the repository root:

```bash
pnpm --filter @eudiplo/sdk-core build        # once, and after regenerating the SDK
pnpm dev:client                              # ng serve on http://localhost:4200
pnpm --filter @eudiplo/client build
pnpm --filter @eudiplo/client test           # unit tests (Vitest), watch mode
pnpm --filter @eudiplo/client lint           # ESLint (ng lint)
pnpm --filter @eudiplo/client format         # Prettier; format:check only checks
```

`dev`, `build`, `watch` and `test` first run `pnpm gen:api`, which regenerates `src/app/utils/schemas.json` (git-ignored). The JSON editors validate configuration against these schemas.

Sign in at `http://localhost:4200` with the backend URL and a client id and secret, for example `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` from `apps/backend/.env`.

## Calling the backend

Use the generated functions of `@eudiplo/sdk-core` (for example `tenantControllerGetTenant`); do not call `HttpClient` with hand-written URLs. `core/api.service.ts` configures the SDK client with the instance URL and the access token.

When you add or change a backend endpoint, regenerate the SDK with the backend running and rebuild it:

```bash
pnpm gen:sdk   # reads http://localhost:3000/api/docs-json and builds the SDK
```

Commit the regenerated `packages/eudiplo-sdk-core/src/api` together with the backend change.

## Folder map

```text
apps/client/src/
├── app/
│   ├── app.config.ts, app.routes.ts   # providers and top-level routes
│   ├── core/                # API service (SDK setup), OIDC service, auth interceptor
│   ├── services/            # environment, theme, version check, Grafana links, JWT helpers
│   ├── guards/              # auth.guard.ts, roles.guard.ts
│   ├── common/              # shared base list component and small utilities
│   ├── utils/               # reusable UI: editor, image field, webhook config, schema validation
│   ├── login/, dashboard/, settings/
│   ├── issuance/            # credential configs, issuance config, offers, attribute providers
│   ├── presentation/        # presentation configs and requests
│   ├── session-management/, session-config/
│   ├── key-management/, trust-list/, status-list-config/, status-list-management/
│   ├── registrar/, schema/, webhook-endpoint/, config-portability/
│   ├── tenants/, users/, admin/   # tenants and clients, users, activity log
│   └── types/
├── environments/
└── test-setup.ts            # shared unit-test setup
```

Features follow a list / show / create pattern (`*-list/`, `*-show/`, `*-create/`) with routes in a `*.routes.ts` file and a feature service that wraps the SDK calls. Forms use Reactive Forms.

## Tests

**Unit tests** use Vitest through the `@angular/build:unit-test` builder (`angular.json`: runner `vitest`, `isolate: true`, setup file `src/test-setup.ts`). Spec files sit next to the component as `*.spec.ts`. CI runs them in the Build Client job:

```bash
pnpm --filter @eudiplo/client test --watch=false
```

`src/test-setup.ts` provides in-memory `localStorage`/`sessionStorage`, a `matchMedia` stub and a never-settling `fetch` for the SDK client. To assert API calls, stub `fetch` and inspect the requests; the Angular builder cannot intercept `vi.mock('@eudiplo/sdk-core')`.

**Browser tests** use Playwright and live in `apps/client/e2e/`. They run in two modes:

- **Build mode** (`E2E_USE_BUILD=true`, used by the **E2E Tests (Client)** CI job) tests what ships. Build the backend and the client first; Playwright then runs `apps/backend/dist` against a fresh SQLite database in `apps/client/tmp/e2e-backend` (`e2e/support/start-backend.mjs`) and serves the production build with a generated `env.js`, like the client Docker image (`e2e/support/serve-dist.mjs`). The backend imports the demo tenant from `assets/config/demo` plus an external authorization server for the authorization code tests, and the tests sign in with the demo tenant's `test-client`. Imported resources are file-managed and read-only in the client, so tests that change data create their own resources.
- **Dev mode** (default) starts the backend (`pnpm run dev` in `apps/backend`) and `ng serve`, or reuses running servers. Sign-in uses a tenant client from `E2E_TENANT_CLIENT_ID` / `E2E_TENANT_CLIENT_SECRET`, read from the environment or `apps/backend/.env`; `E2E_ALLOW_ROOT_FALLBACK=true` falls back to `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`. The tests expect data like the demo tenant's.

```bash
pnpm --filter @eudiplo/config-format build && pnpm --filter @eudiplo/sdk-core build
pnpm --filter @eudiplo/backend build && pnpm --filter @eudiplo/client build
E2E_USE_BUILD=true pnpm --filter @eudiplo/client e2e
```

`e2e/cookbook.spec.ts` walks the [Issue and verify](../cookbooks/index.md) cookbook through the client, from tenant creation to the verified presentation. It signs in as root (`AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`, `root`/`root` in build mode), creates a new tenant per run, and uses the headless wallet in `e2e/support/wallet.ts` in place of the phone.

`PLAYWRIGHT_API_URL` and `PLAYWRIGHT_TEST_BASE_URL` move the backend and client off ports 3000 and 4200. CI uploads the HTML report as the `client-e2e-report` artifact.

Specs import `test` and `expect` from `e2e/support/test.ts` instead of `@playwright/test`. With `E2E_COVERAGE=true`, that fixture records Chromium's JavaScript coverage of every page, and after the run `monocart-coverage-reports` maps it back to `src/**/*.ts` through the build's source maps (`e2e/support/coverage.ts`). Files no test loaded count as uncovered; templates are not included. The HTML, LCOV and Cobertura reports land in `apps/client/coverage/e2e/`.

## Version check

After sign-in the client compares its build (`env.js`) with the backend's `GET /api/version`. Different revisions, or releases that differ in more than the patch version, show a warning banner. Local builds without version information are not checked.
