---
name: regen-sdk
description: Regenerate packages/eudiplo-sdk-core (and the generated JSON schemas) after a backend endpoint or DTO change, including when port 3000 is taken and when the committed SDK has drifted from main. Use whenever a change touches an endpoint, DTO or OpenAPI description.
---

# Regenerating the SDK

`pnpm gen:sdk` runs `openapi-ts` in `packages/eudiplo-sdk-core`, which reads OpenAPI from a running backend at `http://localhost:3000/api/docs-json` (`openapi-ts.config.ts`). The generated files are `src/api/*.gen.ts` (mainly `types.gen.ts` and `schemas.gen.ts`). CI does not check SDK freshness, so a stale SDK goes unnoticed; feature PRs that change the API update it.

Run `pnpm gen:api` first when DTOs or config schemas changed: it builds `@eudiplo/config-format` and regenerates `schemas/*.schema.json` and the client's `src/app/utils/schemas.json`. Config format version bumps have their own skill, `config-format-bump`.

## Port 3000 free

Start the backend (`pnpm dev:backend`), wait for it, then `pnpm gen:sdk`. Stop the backend you started.

## Port 3000 taken

Never generate against a backend you did not start: another session's backend serves a different branch's spec.

1. In a fresh worktree: `pnpm install --frozen-lockfile`, then `pnpm --filter @eudiplo/config-format build` (else `ERR_MODULE_NOT_FOUND`).
2. `pnpm --filter @eudiplo/backend build`
3. Pick a free port (`lsof -iTCP:<port> -sTCP:LISTEN` prints nothing) and start the build from `apps/backend`, recording the PID:

   ```bash
   PORT=<port> FOLDER=<scratchpad>/sdk-data CONFIG_IMPORT_MODE=disabled DB_SYNCHRONIZE=true \
   MASTER_SECRET=<at least 32 characters> AUTH_CLIENT_ID=sdk-gen AUTH_CLIENT_SECRET=sdk-gen-secret \
   ENCRYPTION_KEY=<64 hex characters> node dist/main.js > <scratchpad>/sdk-backend.log 2>&1 &
   echo $!
   ```

   Reusing the E2E values from `apps/backend/test/vitest.config.ts` is fine.
4. Check the log for `EADDRINUSE` and that `lsof` shows your PID on the port. If another process got the port, your server died and you would generate from the wrong spec.
5. In `packages/eudiplo-sdk-core`: `pnpm exec openapi-ts -i http://localhost:<port>/api/docs-json`, then `pnpm build`.
6. Kill only the PID you recorded and delete the scratch data folder.

## Keeping the diff focused

If the regeneration shows changes unrelated to your work, the committed SDK has drifted from main. Either regenerate from main in a separate `chore` PR first, or keep only your change:

1. Save the spec: `curl -s http://localhost:<port>/api/docs-json > <scratchpad>/mine.json`.
2. Make `<scratchpad>/base.json` by removing your new paths and fields from a copy with a small script.
3. Generate both into scratch dirs: `pnpm exec openapi-ts -i <file> -o <scratchpad>/<base|mine>` in `packages/eudiplo-sdk-core`.
4. `diff -ru <scratchpad>/base <scratchpad>/mine > <scratchpad>/sdk.patch` and apply it to `src/api` with `patch -p<n>`.

## Afterwards

- Build and type-check the consumers: `pnpm --filter @eudiplo/client build` (or `pnpm exec tsc -p tsconfig.app.json --noEmit` in `apps/client`) and `pnpm --filter @eudiplo/cli build`.
- The SDK is published with the main project version. A removed or renamed endpoint or field is breaking and follows the backend's breaking-change notes (`!`, `BREAKING CHANGE:` footer, upgrade guide section).
- A change to `packages/eudiplo-sdk-core` triggers `compat-reviewer` and `docs-alignment-reviewer` (root `CLAUDE.md`).
