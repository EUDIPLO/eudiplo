---
title: Documentation
---

# Documentation

The documentation is a [Docusaurus](https://docusaurus.io/) site in `apps/docs`; pages live in `apps/docs/docs/`. This page covers where content goes, which parts are generated from code, the checks a change must pass and how the site is deployed.

## Run it locally

```bash
pnpm --filter @eudiplo/config-format build     # the generators import backend code
pnpm --filter @eudiplo/docs run prebuild       # generate docs/_generated/ (once, and after schema changes)
pnpm --filter @eudiplo/docs start              # live reload on http://127.0.0.1:3003
```

| Command | Purpose |
| --- | --- |
| `pnpm --filter @eudiplo/docs build` | Runs `prebuild`, then a production build. Broken links and anchors fail the build. |
| `pnpm --filter @eudiplo/docs serve` | Serves the last build on port 3003 |
| `pnpm --filter @eudiplo/docs lint` | markdownlint (`apps/docs/.markdownlint.json`); `lint:fix` fixes what it can |
| `pnpm --filter @eudiplo/docs test` | Sidebar orphan check and the schema generator tests |
| `pnpm --filter @eudiplo/docs typecheck:scripts` | Type-checks the generator scripts |

The search widget reads `ALGOLIA_APP_ID`, `ALGOLIA_SEARCH_API_KEY`, `ALGOLIA_INDEX_NAME` and `DOCSEARCH_AGENT_ID`; local builds work without them.

## Where content goes

The sidebar order is Start, Cookbooks, Issuance, Presentation, Trust, Operate, Reference, Concepts, Contributing, Upgrade.

| Folder | Content | Page type |
| --- | --- | --- |
| `cookbooks/` | End-to-end recipes that end in a working result | Cookbook |
| `issuance/`, `presentation/`, `trust/` | One task per page for issuers, verifiers and trust setup | How-to |
| `operate/` | Deploying and running EUDIPLO: Compose, Kubernetes, TLS, database, KMS, monitoring | How-to |
| `reference/` | Exact facts: API, environment variables, CLI, payloads, field references | Reference |
| `concepts/` | How EUDIPLO works; no configuration steps | Concept |
| `contributing/` | Working on EUDIPLO itself | How-to |
| `upgrade/` | Upgrade procedure and one guide per major version | How-to |
| `troubleshooting.md` | Symptoms shared by several pages | Reference |

Page types:

- **Cookbook**: title "Cookbook: …"; sections *What you will build* (one paragraph, optional diagram), *Before you start* (prerequisites, the recipe it starts from), numbered steps that each end with a **Checkpoint**, *Troubleshooting* (symptom → cause → fix), *Next steps* (2–4 links). Reuse the values of the issue-and-verify recipe where possible (`membership-demo`, `membership`, `urn:example:membership:1`, `membership-check`). Chapters 2 and 3 of that recipe are walked by `apps/client/e2e/cookbook.spec.ts`; change it together with their steps.
- **How-to**: the goal in one sentence, prerequisites, steps, a minimal example, links to the reference.
- **Reference**: tables and generated components, no tutorials.
- **Concept**: explanation and diagrams, links to the how-tos.

Rules for every page:

- **One owner per topic.** Every fact lives on one page; other pages link to it in one sentence. Before you write a table or payload, check whether a page already owns it.
- **Code is the truth.** Check every field, endpoint, default and behavior against the code of the version you document.
- **Paths:** management endpoints with the `/api` prefix (`POST /api/issuer/offer`), wallet-facing endpoints without it (see `GLOBAL_PREFIX_EXCLUSIONS` in `apps/backend/src/main.helpers.ts`).
- **Short.** Lead with the task; at most three sentences of introduction; aim for under 250 lines and split a page that serves two tasks. No marketing, no textbook material, no "future work" or TODOs.
- Use mermaid only where a flow really needs it, and give every code block a language (markdownlint MD040).
- Every published page must be listed in `apps/docs/sidebars.ts`. Files and folders starting with `_` are not published; use them for partials and generated content.
- When you move or delete a page, add a client redirect in `docusaurus.config.ts` and point existing redirects at the final target (no chains).

## Generated content

Prefer a reference generated from code over a hand-written table. `prebuild` writes the generated files to `docs/_generated/` (git-ignored, not published as pages).

| Content | Source of truth | Generator | Use on a page |
| --- | --- | --- | --- |
| Environment variables | Joi schemas combined in `apps/backend/src/platform/config/combined.schema.ts` | `scripts/generate-config-docs.ts` → `_generated/config-model.json` | `<ConfigTable group="…" />` (`src/components/ConfigTable`) |
| CLI command reference | The commander program of `apps/cli` | `scripts/generate-cli-reference.ts` → `_generated/cli-reference.md` | Imported as an MDX partial in `reference/cli.md` |
| Request bodies and configuration fields | Zod schemas registered in `scripts/schema-docs/registry.ts` | `scripts/generate-schema-docs.ts` → `_generated/schemas/` | `<SchemaReference name="…" mode="table" />` (field table) or `mode="body"` (annotated JSON sample) |
| Roles and the endpoints that accept them | `apps/backend/src/auth/roles/role.enum.ts` (member comments are the descriptions) and the `@Secured` decorators of the controllers | `scripts/generate-roles-docs.ts` → `_generated/roles.json` | `<RoleReference table="roles" />` or `table="endpoints"` (`src/components/RoleReference`) |

To document a new Zod schema, add `{ name, schema }` to `registry.ts`, run `prebuild`, import `SchemaReference` from `@site/src/components/SchemaReference` and place the component. Field descriptions come from the schema's `.describe(…)` texts, so improve the description in the backend schema instead of the page. An unknown `name` fails the build. Descriptions that are part of a published configuration file format can't change without a new format version (`pnpm schemas:check-contract` fails); correct those with the entry's `descriptions` overrides in `registry.ts` until the next format version. Text in backticks renders as inline code in the generated tables.

Generate other references that can be derived from code too, instead of writing a table by hand. The published JSON schemas for configuration files are a separate pipeline: [Configuration schemas](./configuration-schemas.md).

## Checks

CI runs on every pull request:

- `pnpm --filter @eudiplo/docs lint` (markdownlint) in the Lint job,
- `pnpm --filter @eudiplo/docs test`, `typecheck:scripts` and `build` in the Build Documentation job.

The build is configured with `onBrokenLinks: 'throw'` and `onBrokenAnchors: 'throw'`, so a link to a missing page or heading fails it. The sidebar orphan check (`scripts/check-sidebar-orphans.ts`) fails when a page is missing from `sidebars.ts` or the sidebar references a page that does not exist.

## Deployment and versions

Both workflows deploy the website and the documentation together with `.github/workflows/deploy-site.yml`.

| Trigger | Built from | Deployed to |
| --- | --- | --- |
| Push to `main` (CI job *Deploy Preview Website & Documentation*) | `main` | Cloudflare Pages project `eudiplo-docs`, branch `preview` |
| Release (*Versioned Release* workflow) | The release commit | Cloudflare Pages project `eudiplo-docs`, branch `production`, served at [docs.eudiplo.dev](https://docs.eudiplo.dev/) |
| *Versioned Release* with `deploy_site_only` | `main`, only when no release is pending | Same as a release |

So docs.eudiplo.dev describes the latest release, and the preview describes `main`. A `docs:` commit triggers no release, so documentation-only changes reach production by running *Versioned Release* with `deploy_site_only`. It refuses to deploy while a release is pending, because `main` could then document unreleased behavior; release first in that case.

The site has no per-version copies (`versioned_docs/` does not exist). Documentation of an older release is the `apps/docs/docs` folder at its git tag, which is how the [upgrade overview](../upgrade/index.md) links to old upgrade guides.

Document the behavior of `main`. A change that breaks existing setups also needs an entry in the upgrade guide of the next major (see [Releases](./releases.md#commit-messages)).
