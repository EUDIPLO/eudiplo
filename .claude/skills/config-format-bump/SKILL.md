---
name: config-format-bump
description: Bump the file format version of an EUDIPLO configuration resource (IssuanceConfig, KeyChain, Tenant, KmsConfig, RegistrarConfig and so on) when its accepted content changes, with the snapshot, migration step, docs, upgrade guide and commit classification. Use whenever a change touches a config DTO or schema, packages/eudiplo-config-format, or schemas/.
---

# Bumping a configuration format version

The procedure is in `apps/docs/docs/contributing/configuration-schemas.md` ("Bump a format version"). Read it first and follow its steps. This skill adds the decisions and pitfalls from earlier bumps.

## 1. Is a bump needed?

Bump whenever the accepted content of a resource changes, including a changed description in a published schema. `pnpm schemas:check-contract` fails when a DTO changed but the version did not.

Skipping a bump is the user's call, not yours. TrustList stayed v1 for Base64 DER certificates only because the user decided so, and the waiver text went into the PR body. Ask before waiving.

Avoid a `KeyChain` bump when another kind can carry the change: it changes the hash of every applied document, so the next `upsert`/`replace` startup applies every file-managed key chain again, with new keys for CA keys. (KmsConfig v2 added curves without a KeyChain bump for this reason.) If you do bump it, say so in the upgrade guide.

## 2. Which version number?

Look at the snapshot on main, not only your branch:

```bash
git fetch origin && git ls-tree -d --name-only origin/main schemas/ | sort -V | tail -2
git ls-tree -r --name-only origin/main schemas/v<N>/ | grep <Kind>
```

- If `schemas/v<N>/<Kind>File.schema.json` exists on `origin/main`, it is published and immutable, even if no release contains it yet. Add a v<N> → v<N+1> step (Tenant v2 → v3 went this way). `pnpm schemas:check-history origin/main` fails on any edit.
- If the version exists only on your branch or an unmerged stack, edit that snapshot and its step instead of adding another version. Land it before or with the PR that publishes the snapshot, or move to the next version.

## 3. Implementation checklist

1. Backend schema/DTO change; increment `version` in `CONFIG_FORMATS` (`packages/eudiplo-config-format/src/config-format.ts`).
2. Exactly one step in `CONFIG_MIGRATIONS`. When every old file is a valid new file, it is a no-op step (for example `key-chain-v2-type`). Lossy changes return `warning` issues; changes needing a decision return `required-input`. `presentationConfigV1ToV2` is the reference.
3. Bare files without `$schema` (key chain files, `kms.json`, `registrar.json`, `info.json`): if the new field or value tells the versions apart, extend `bareFileVersion()` in the same module. The backend (`detectLegacyVersion`) and the CLI (`wrapBare`) both use it.
4. Stored data changes need a database migration in `apps/backend/src/database/migrations`. Take a timestamp newer than the newest one on `origin/main` (renumber after merging main if someone took yours). Use `json`, not `jsonb`, where the entity uses `json`, or the drift check in `apps/backend/test/migrations.e2e-spec.ts` fails.
5. Regenerate, then snapshot and sync:

   ```bash
   pnpm gen:api
   pnpm schemas:snapshot <Kind>
   pnpm schemas:sync
   pnpm --filter @eudiplo/cli assets:sync
   ```

6. Tests: the migration step in `packages/eudiplo-config-format` (transformation, source and target validation, required input, running it twice) and, for CLI behavior, `apps/cli/test/config-upgrade.test.ts`.
7. Checks CI runs:

   ```bash
   pnpm schemas:check-contract
   pnpm schemas:check
   pnpm schemas:check-history origin/main
   pnpm --filter @eudiplo/website build
   ```

8. If the DTO also appears in OpenAPI, regenerate the SDK (skill `regen-sdk`). A field already documented on the entity class can leave the SDK unchanged.
9. `pnpm run knip` before pushing: the pre-push hook fails on unused exports.

Tenant pitfall: the startup folder bundle does not contain `info.json`. Only `TenantService.setupTenant` applies it, before key chains are imported, so a Tenant field that references another resource needs the orchestrator's `finish` hook.

## 4. Documentation

- Add a row to the table in `apps/docs/docs/contributing/configuration-schemas.md` and extend the sentence above it that lists the bumps per release.
- Describe the change under "Configuration files" in the upgrade guide of the next major (`apps/docs/docs/upgrade/<prev>-to-<next>.md`): files exported by the new release cannot be imported into older ones. Keep CI examples pinned to the matching `@eudiplo/cli@<major>`.
- Update the operator docs that describe the field (`apps/docs/docs/operate/configuration-as-code.md` or the resource's page).

## 5. Commit classification

- An optional field or a new allowed value, where every old file is still valid: not breaking. Use `feat(...)` or `fix(...)` without `!` (CredentialConfig v2, KeyChain v2, KmsConfig v2, RegistrarConfig v2).
- Tightened validation (a value that was accepted is now refused) or a different default behavior: breaking, even if enforced only on write. Use `!`, a `BREAKING CHANGE:` footer and an upgrade guide section (federation `entityId` check, IssuanceConfig v4 status check mode).
- Let `compat-reviewer` confirm the classification; run it with `docs-alignment-reviewer` before committing (root `CLAUDE.md`).

Commit schema, snapshot, generated files, tests and docs together, signed off (`git commit -s`).
