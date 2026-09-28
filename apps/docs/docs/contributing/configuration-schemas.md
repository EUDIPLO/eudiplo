---
title: Publishing Configuration Schemas
---

# Publishing Configuration Schemas

Configuration files use a canonical URL such as:

```text
https://eudiplo.dev/schemas/v1/PresentationConfigFile.schema.json
```

The existing `eudiplo-website` Cloudflare Pages project serves these files alongside the website. No additional Pages project, GitHub Pages site, Worker, bucket, or DNS change is needed when that project already owns `eudiplo.dev`.

## Build and deploy

```bash
pnpm --filter @eudiplo/website build
```

The build stages public website assets and every checked-in `schemas/v*/` snapshot in `apps/website/dist`. It verifies canonical schema IDs and external reference availability. It also creates `/schemas/index.json`, listing the available configuration schemas. Each resource schema includes its own dependencies in `$defs`, so its version can evolve independently of other resources.

The `_headers` file allows cross-origin schema reads and serves JSON Schema with the appropriate content type. A top-level `404.html` prevents unknown versions from falling back to the website homepage. Cloudflare documents these mechanisms under [custom headers](https://developers.cloudflare.com/pages/configuration/headers/) and [serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).

The existing CI preview deployment and release deployment both call the website's `deploy` command, which now builds and uploads `dist`. Production schema URLs become available with the production website deployment. A preview deployment does not publish new production URLs.

To deploy explicitly using the existing Cloudflare credentials:

```bash
CLOUDFLARE_PAGES_BRANCH=main pnpm --filter @eudiplo/website deploy
```

For a project using Cloudflare's Git build integration instead of the repository's Wrangler deployment workflow, configure the repository root as the build root, `pnpm --filter @eudiplo/website build` as the build command, and `apps/website/dist` as the output directory. Review a preview deployment before publishing to production.

## Versioned contracts

Files under `schemas/v*/` are immutable publication artifacts. Do not overwrite or delete an existing snapshot. Changes to validation behavior require a new resource format version. Documentation corrections also use a new snapshot under the current strict immutability policy.

The version belongs to an individual resource type, not the application release. All resources currently start at v1. Future versions can evolve independently: a presentation configuration could use v2 while clients and key chains remain on v1. The schema's own `$schema` identifies the JSON Schema dialect; its `$id` is the public EUDIPLO URL. The configuration file's `$schema` selects that public schema.

The backend and CLI bundle the snapshots. Import, validation and migration do not depend on Cloudflare availability and never fetch arbitrary schema URLs supplied in configuration files.

## Add a format version

1. Update the configuration schema and increment the resource's version in `packages/eudiplo-config-format/src/config-format.ts`.
2. Add a sequential migration in `CONFIG_MIGRATIONS` in that same module. Preserve resource identity and applicable metadata. Migration callbacks receive both `spec` and `metadata` and may return updated metadata. Report a `required-input` issue when user input is necessary. Missing or ambiguous migration steps block the upgrade.
3. Generate the current API and compatibility schemas, then snapshot the changed resource:

    ```bash
    pnpm gen:api
    pnpm schemas:snapshot PresentationConfig
    pnpm --filter @eudiplo/cli assets:sync
    ```

4. Add tests for valid transformations, source and target validation, missing input, and repeated upgrades. Run the backend and CLI checks and build the website.
5. Commit the new snapshot, shared implementation, generated bundles, fixtures and documentation together. Publish the new schema URLs with the website release before distributing configuration that references them.

`schemas:snapshot` preflights the complete dependency graph and refuses to replace an existing snapshot with different content. Running it without a resource name checks/snapshots every current resource. The backend owns the framework-independent implementation; the existing CLI asset synchronization copies that exact source into its standalone distribution. `schemas:check` detects drift between those copies and the versioned schemas.

```bash
pnpm schemas:check-contract
pnpm schemas:check
pnpm schemas:check-history HEAD
```

`schemas:check-contract` regenerates schema content in memory and compares it with committed API/editor artifacts and current format snapshots. It catches DTO changes that were not regenerated or assigned a new format version. It does not rewrite snapshots.

CI compares snapshots against the pull request base (or previous push) to reject edits and deletions of existing versions. Website builds copy the committed snapshots; they never regenerate historical schemas from current DTOs.
