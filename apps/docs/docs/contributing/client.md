---
title: Client Development
---

# Client development

The web client (`apps/client`, package `@eudiplo/client`) is an Angular application with standalone components and Angular Material. It talks to the backend through the generated `@eudiplo/sdk-core` client; only the registrar configuration still uses Angular `HttpClient`, whose `core/auth.interceptor.ts` adds the token.

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

Show the backend's reason when a request fails. The SDK throws the parsed response body, not an `Error`, so build the message with `getApiErrorMessage(error, 'Failed to …')` from `utils/error-message.ts` (`getHttpErrorMessage` for an `HttpClient` call) and open it with `openErrorSnackBar` from `utils/error-snackbar.ts`, which keeps a long message on screen long enough to read. In a form, `showIssuesAtFields` from `utils/form-errors.ts` puts the issues of a `400 Validation failed` response under their fields. A page that loads several sources reports the failed ones in one snackbar with `reportSourceFailures` from `common/load-source.ts`, which names the requests the backend did not answer once. When a page cannot load its data, show `<app-load-error>` from `common/load-error.component.ts` with its Retry instead of an empty list or a form with default values; a list based on `BaseAsyncListComponent` names its `loadFailedMessage` and shows the `loadError` it sets. Give that list's page heading `#listHeading` and `tabindex="-1"`: a retry removes the error card with its focused Retry button, so after a successful retry focus moves to the heading, unless the user has moved it elsewhere meanwhile. Other screens do the same with `focusAfterRenderIfLost` from `common/focus-if-lost.util.ts`, for example to a card title with `tabindex="-1"`, and also after an action that can end with focus nowhere, for example a Save clicked in Safari, which does not focus a clicked button.

In a `@for` over the controls of a `FormArray`, track each row by its control (`track field`), not by `$index`. `formControlName` binds to its control only once, so a row that Angular reuses for another index after a removal, a reorder or a reload keeps editing a control that is no longer in the form. Do not bind an index into the `id` of a `matInput` either: it overwrites the id the `<mat-label>` points to once the row moves. When a removed row held focus, call `focusRowAfterRemoval` from `common/focus-if-lost.util.ts`: it moves focus to the row now in its place, to the new last row when the removed one was last, or to the section's Add button when none is left.

When an action cannot be used right now, keep its button focusable and say why: `disabled` with `disabledInteractive` and the reason in `matTooltip`, as on the schema list and on Reset to Defaults in the settings screens. Material does not block clicks on such a `<button>` (only on links), so the click handler checks the same condition again. `appConfigManaged` locks a Material button through its `ariaDisabled` input and so keeps the button's own `aria-disabled`.

A form's Save is not such an action while fields are missing or invalid: keep it enabled and let the submit handler mark every field touched, say in the snackbar which sections hold errors, open a collapsed section or panel that holds the first one and move focus to that field. `showFieldsToFix` from `common/field-to-fix.util.ts` does all but the opening. A form that opens an expansion panel passes it as `panel`, so that focus waits for the panel's opening transition, and `fallback` takes the focus when no field is invalid, such as an Add button for a list that must not be empty. The trust list form passes both to `focusFieldToFix` and builds its snackbar with `sectionsWithErrors` and `fieldsToFixMessage`, because it also says when no entity is listed. Disable Save only while the save runs, with `disabledInteractive` and the reason in `matTooltip`.

Give an icon-only button (`mat-icon-button`, `matIconButton`) an `aria-label`, usually its tooltip text; otherwise screen readers read the icon name ("delete"). A button repeated per row names its row, for example `[attr.aria-label]="'View tenant ' + tenant.id"`. Lint enforces the label, and it rejects `console.log`: debug output can carry tokens or wallet responses, so log only with `console.warn` or `console.error`, and never whole responses.

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
│   ├── core/                # API service (SDK setup), reaction to refused requests, OIDC service, auth interceptor
│   ├── services/            # environment, theme, version check, frontend config, session notices, role change notice, Grafana links, JWT helpers
│   ├── guards/              # auth.guard.ts, roles.guard.ts
│   ├── common/              # shared base list component, load error card, source loading, small utilities
│   ├── utils/               # reusable UI: editor, image field, schema validation; error messages
│   ├── login/, dashboard/, settings/
│   ├── issuance/            # credential configs, issuance config, offers, attribute providers
│   ├── presentation/        # presentation configs and requests
│   ├── session-management/, session-config/
│   ├── key-management/, trust-list/, status-list-config/, status-list-management/
│   ├── registrar/, schema/, webhook-endpoint/, config-portability/
│   ├── tenants/, users/, admin/   # tenants and clients, users, activity log
│   └── types/
├── styles/                  # shared Sass mixins, e.g. _a11y.scss behind the global .visually-hidden class
├── environments/
└── test-setup.ts            # shared unit-test setup
```

Features follow a list / show / create pattern (`*-list/`, `*-show/`, `*-create/`) with routes in a `*.routes.ts` file and a feature service that wraps the SDK calls. Forms use Reactive Forms.

## Tests

**Unit tests** use Vitest through the `@angular/build:unit-test` builder (`angular.json`: runner `vitest`, `isolate: true`, setup file `src/test-setup.ts`). Spec files sit next to the component as `*.spec.ts`. CI runs them in the Build Client job:

```bash
pnpm --filter @eudiplo/client test --watch=false
```

For a list on `BaseAsyncListComponent`, call `describeListStates()` from `common/base-async-list.testing.ts` in its spec. It tests the loading, empty and error states and the focus after Retry, and expects an `h2` page heading, a Create icon button whose `aria-label` matches its tooltip, a loading indicator with an `aria-label`, an empty state with a link to `create` and the item ID in the first column.

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
