---
title: Configuration Schemas
---

# Configuration schemas

Configuration files name their format in `$schema`, for example `https://eudiplo.dev/schemas/v3/PresentationConfigFile.schema.json`. This page explains how these format versions work, how to bump one, and how the schemas are published. The file format itself is described in [Configuration as code](../operate/configuration-as-code.md).

## Format versions

Each resource type has its own format version in `CONFIG_FORMATS` (`packages/eudiplo-config-format/src/config-format.ts`); it is independent of the application version. EUDIPLO 9.0 introduced the first bumps; `IssuanceConfig` v3 followed after 9.0:

| Resource | Version | Change |
| --- | --- | --- |
| `IssuanceConfig` | v2 | Optional `offerLifetimeSeconds`. A v1 file is a valid v2 file. |
| `IssuanceConfig` | v3 | Optional `verifierKeyPem` (PEM public key) in `walletProviderTrustLists` entries. A v2 file is a valid v3 file. |
| `PresentationConfig` | v2 | `registration_cert.body.provided_attestations` is replaced by the registrar's `provides_attestations` (string array). The v1 → v2 step drops the old field with a warning. |
| `PresentationConfig` | v3 | DCQL claim `values` accept integers and booleans besides strings and must be non-empty. A v2 file is a valid v3 file unless it has an empty `values` array. |
| All other resources | v1 | |

The backend and the CLI bundle every published snapshot (`schemas/v*/`) and never fetch schema URLs from files. Older files are upgraded on import, one version step at a time, through `CONFIG_MIGRATIONS`: the startup import and bundle imports (`POST /api/config-bundles/plan` and `/import`) accept warnings and stop on issues that need input; `eudiplo config upgrade <file-or-folder>` does the same offline. A file with a newer version than the running release supports is rejected, so 9.0 exports cannot be imported into 8.x.

## Bump a format version

Bump the version whenever the accepted content of a resource changes, including documentation-only changes to a published schema.

1. Change the backend schema of the resource and increment its `version` in `CONFIG_FORMATS`.
2. Add exactly one step from the previous version to `CONFIG_MIGRATIONS` in the same module. `migrate(spec, metadata)` returns the new `spec`, optionally new `metadata`, and `issues`: `warning` for lossy but automatic changes, `required-input` when a user must decide. Keep the resource identity. `presentationConfigV1ToV2` is the reference.
3. If stored data must change as well, add a database migration ([Backend architecture](./backend-architecture.md#a-database-migration)).
4. Regenerate the schemas and create the snapshot of the new version:

    ```bash
    pnpm gen:api                              # current schemas in schemas/*.schema.json
    pnpm schemas:snapshot PresentationConfig  # writes schemas/v<N>/…; never overwrites an existing file
    pnpm schemas:sync                         # bundles schemas/v*/ into the config-format package
    pnpm --filter @eudiplo/cli assets:sync    # copies schemas and templates into the CLI
    ```

5. Add tests for the migration step (valid transformation, source and target validation, required input, running the upgrade twice) in `packages/eudiplo-config-format` and, for CLI behavior, `apps/cli/test/config-upgrade.test.ts`.
6. Run the checks CI runs:

    ```bash
    pnpm schemas:check-contract        # current DTOs match the committed schemas and snapshots
    pnpm schemas:check                 # bundled snapshots are in sync
    pnpm schemas:check-history origin/main   # no published snapshot was changed
    pnpm --filter @eudiplo/website build
    ```

7. Commit schema, snapshot, generated files, tests and documentation together, and describe the change in the [upgrade guide](../upgrade/index.md) of the next major: files exported by the new release cannot be imported into older ones.

`schemas:snapshot` without a resource name checks and snapshots every current resource. Running `schemas:snapshot` alone is not enough: `schemas:check-contract` fails when a DTO changed but the version was not bumped.

## Immutable snapshots

Files under `schemas/v*/` are publication artifacts. Never edit or delete one; CI compares them with the pull request base (`scripts/check-published-schemas.mjs`) and fails on any change. Each resource schema contains its dependencies in `$defs`, so one resource can move to a new version while the others stay. The schema's own `$schema` is the JSON Schema dialect; its `$id` is the public EUDIPLO URL that files reference.

## Publishing

The `eudiplo-website` Cloudflare Pages project serves the schemas next to the website at `eudiplo.dev/schemas/…`. `pnpm --filter @eudiplo/website build` stages the website and every `schemas/v*/` snapshot in `apps/website/dist`, verifies the schema ids and references, and writes `/schemas/index.json`. `_headers` allows cross-origin reads and sets the JSON Schema content type; `404.html` keeps unknown versions from falling back to the home page.

Pushes to `main` deploy the website to the `preview` branch; the release workflow deploys it to production. New schema URLs therefore go live with the release that introduces them, not with the merge.
