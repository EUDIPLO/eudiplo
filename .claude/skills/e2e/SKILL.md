---
name: e2e
description: Run EUDIPLO backend (vitest) or client (Playwright) E2E tests, including when another session already holds port 3000, 4200 or another port. Use whenever you need to run, rerun or debug E2E suites in apps/backend/test or apps/client/e2e.
---

# Running E2E tests

Other sessions often run EUDIPLO dev servers or containers on 3000, 3100, 4200 or spare ports like 3199. Never stop a process you did not start. Check a port before using it:

```bash
lsof -iTCP:<port> -sTCP:LISTEN
```

In a fresh worktree run `pnpm install --frozen-lockfile` and `pnpm --filter @eudiplo/config-format build` first; without it the backend fails with `ERR_MODULE_NOT_FOUND`.

## Backend (apps/backend/test)

`test/global-setup.ts` aborts the whole run when 3000 is taken, and the suites bind the backend to 3000 (`PUBLIC_URL` is `http://localhost:3000`).

**Port 3000 free:** in `apps/backend`, run `pnpm test:e2e:local` or one file with `pnpm exec vitest run --config ./test/vitest.config.ts test/<path>.e2e-spec.ts`. `E2E_SKIP_CONTAINERS=true` skips the Postgres, Vault and S3 suites.

**Port 3000 taken, supertest-only suites** (they only call `app.init()`, for example `test/config-portability/*`): run them with a scratchpad config that drops the port guard. The file must be `.mts` (a `.ts` file outside the package is bundled as CJS and fails), must not import `vitest/config` (not resolvable from the scratchpad), and must keep `coverage` (`undefined` crashes vitest):

```ts
// <scratchpad>/vitest.e2e.mts
import base from "<worktree>/apps/backend/test/vitest.config.ts";
export default { ...base, test: { ...base.test, globalSetup: [], reporters: ["default"] } };
```

For Testcontainers suites, point `globalSetup` at a scratch file that only calls `project.provide("containerRuntimeAvailable", true)` instead of `[]`.

**Port 3000 taken, suites that listen on it** (`test/presentation/*` via `setupPresentationTestApp`; status lists are fetched from `PUBLIC_URL` with no rewrite): run the suite in a throwaway container (about 4 to 7 minutes):

1. `rsync -a --exclude node_modules --exclude dist --exclude .git --exclude tmp <worktree>/ <scratchpad>/e2e-copy/`
2. `docker run --rm -v <scratchpad>/e2e-copy:/repo -w /repo node:26 bash -c '<script>'` with the script
   `npm i -g pnpm@<version from packageManager in package.json>` (node:26 has no corepack), `pnpm install --frozen-lockfile`, `pnpm --filter @eudiplo/config-format build`, `cd apps/backend`, `E2E_SKIP_CONTAINERS=true npx vitest run --config ./test/vitest.config.ts --exclude 'test/oidf/**'`.
3. Delete the copy afterwards (about 1 GB).

### Backend gotchas

- Delete `<worktree>/tmp/service.db` between runs. Suites that set `process.env.FOLDER` in `beforeAll` (for example `test/trust-list/wallet-provider-trust.e2e-spec.ts`) still write there, and a rerun fails in `beforeAll` on stale data.
- `test/utils.ts` imports `AppModule` statically. In a suite that sets `CONFIG_FOLDER`/`CONFIG_IMPORT_MODE` in `beforeAll` and imports AppModule dynamically afterwards, importing anything from `../utils.js` disables the startup config import; failures then look unrelated (empty metadata, `EntityNotFoundError` for tenant `demo`). Fetch tokens inline in such suites.
- Routes have no `/api` prefix (`/issuer/credentials`), except `/api/oauth2/token`.
- `getTenantAdminToken` for the same tenant with new roles revokes earlier tokens; order tests accordingly.
- Spec files are not type-checked by vitest (SWC). For the source, use `pnpm exec tsc --noEmit -p tsconfig.build.json`; `tsconfig.json` stops at TS6059 rootDir errors and hides real ones.
- To compare against HEAD: `git worktree add --detach <scratchpad>/head-wt HEAD`, then `pnpm install --frozen-lockfile --offline` and the config-format build there. Don't use the shared stash.

## Client (apps/client, Playwright)

Build mode starts its own backend (fresh SQLite, demo tenant from `assets/config/demo`) and serves the production build, so it never reuses another session's servers. Pick two free ports, then:

```bash
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/sdk-core build
pnpm --filter @eudiplo/backend build
pnpm --filter @eudiplo/client build
```

```bash
cd apps/client && E2E_USE_BUILD=true PLAYWRIGHT_API_URL=http://127.0.0.1:3199 PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:4299 pnpm exec playwright test e2e/<spec> --reporter=list
```

- Playwright aborts if a URL already answers. Webservers from the previous run can linger a few seconds ("…/health is already used"); wait and retry.
- Imported resources are file-managed and read-only, so specs that change data create their own resources. `test-client` has `clients:manage` and can create clients via `POST /api/client` with a token from `/api/oauth2/token`.
- `appConfigManaged` swallows clicks while its ownership lookup runs (`aria-busy="true"`). Wait for `not.toHaveAttribute('aria-busy', 'true')` before clicking, or the spec flakes under load.

## Client unit tests (ng test)

- `ng test` needs the gitignored `src/app/utils/schemas.json` from `pnpm gen:api` (the `pretest` script runs it).
- Under heavy machine load, unrelated specs time out at 5000 ms. Rerun them alone before treating them as failures.
- `ng test` only compiles code reachable from specs; also run `pnpm exec tsc -p tsconfig.app.json --noEmit` or `ng build`.
- `ng lint` ends with a blank line, so `| tail -1` hides failures.
