---
title: Configuration Schemas
---

# Configuration schemas

Configuration files name their format in `$schema`, for example `https://eudiplo.dev/schemas/v4/PresentationConfigFile.schema.json`. This page explains how these format versions work, how to bump one, and how the schemas are published. The file format itself is described in [Configuration as code](../operate/configuration-as-code.md).

## Format versions

Each resource type has its own format version in `CONFIG_FORMATS` (`packages/eudiplo-config-format/src/config-format.ts`); it is independent of the application version. EUDIPLO 9.0 introduced the first bumps; `IssuanceConfig` v3 followed in 9.1, `CredentialConfig` v2 to v4, `KeyChain` v2, `Client` v2, `KmsConfig` v2, `RegistrarConfig` v2, `Tenant` v2 to v4, `IssuanceConfig` v4 to v6, `KeyChain` v3 and v4, `KeyChainDefaults` v2, `PresentationConfig` v4 and `TrustList` v2 in 10.0:

| Resource | Version | Change |
| --- | --- | --- |
| `IssuanceConfig` | v2 | Optional `offerLifetimeSeconds`. A v1 file is a valid v2 file. |
| `IssuanceConfig` | v3 | Optional `verifierKeyPem` (PEM public key) in `walletProviderTrustLists` entries. A v2 file is a valid v3 file. |
| `IssuanceConfig` | v4 | Optional `walletAttestationStatusCheckMode` on the issuance configuration and its authorization servers. A v3 file is a valid v4 file. |
| `IssuanceConfig` | v5 | Optional entity configuration fields in `federation` (`entityTypes`, `authorityHints`, `entityKeyChainId`, `entityConfigurationLifetimeSeconds`, `trustMarks`, `entityMetadata`, `includeTrustChain`). A v4 file is a valid v5 file. |
| `IssuanceConfig` | v6 | The top-level `signingKeyId` is removed; the v5 → v6 step drops a set value with the warning `ISSUANCE_SIGNING_KEY_ID_REMOVED` and keeps `token.signingKeyId` with the warning `AUTHORIZATION_SERVER_KEY_CHAIN_REQUIRED`. Optional `registrationCertificate.renewal`. |
| `CredentialConfig` | v2 | `x509` as `frameworkType` of `schemaMeta.trustedAuthorities` entries. A v1 file is a valid v2 file. |
| `CredentialConfig` | v3 | `fields[].constraints` accept only JSON Schema validation and annotation keywords. The v2 → v3 step drops other keys with a warning and stops on claim patterns RE2 cannot run (`CLAIM_PATTERN_UNSUPPORTED`). |
| `CredentialConfig` | v4 | `config.display[]` colors must be CSS Color Level 3 numerical values, and each locale may appear once; optional `revokeWithWalletUnit`. The v3 → v4 step trims colors and lowercases their function names, drops the ones wallets cannot read with the warning `DISPLAY_COLOR_REMOVED` and stops on a repeated locale (`DISPLAY_LOCALE_DUPLICATE`). |
| `KeyChain` | v2 | Optional `type` (`standalone`, `internalChain`). A v1 file is a valid v2 file; a bare key chain file with `type` is read as v2 (`bareFileVersion`). |
| `KeyChain` | v3 | Usage type `federation`. A v2 file is a valid v3 file; a bare key chain file with usage type `federation` is read as v3. |
| `KeyChain` | v4 | Usage type `authorizationServer`. A v3 file is a valid v4 file; a bare key chain file with usage type `authorizationServer` is read as v4. |
| `KeyChainDefaults` | v2 | Optional `authorizationServer` entry. A v1 file is a valid v2 file; a bare `key-chain-defaults.json` with the entry is read as v2 (`bareFileVersion`). |
| `Client` | v2 | The roles `audit:read`, `sessions:read`, `credentials:status` and `keys:manage`. A v1 file is a valid v2 file. |
| `KmsConfig` | v2 | Optional `algorithms` and `defaultAlgorithm` on providers. A v1 file is a valid v2 file; a bare `kms.json` with either field on a provider is read as v2 (`bareFileVersion`). |
| `RegistrarConfig` | v2 | Optional `relyingPartyContact`. A v1 file is a valid v2 file; a bare `registrar.json` with the field is read as v2 (`bareFileVersion`). |
| `Tenant` | v2 | Optional `defaultAccessKeyChainId`. A v1 file is a valid v2 file; a bare `info.json` with the field is read as v2 (`bareFileVersion`). Only in development builds of 10.0. |
| `Tenant` | v3 | `defaultKeyChains` map by usage type replaces `defaultAccessKeyChainId`; the v2 → v3 step moves it to `defaultKeyChains.access`. A bare `info.json` with `defaultKeyChains` is read as v3. Only in development builds of 10.0. |
| `Tenant` | v4 | `defaultKeyChains` moves to the new resource `KeyChainDefaults` (`key-chain-defaults.json`, v1); the v3 → v4 step drops it with the warning `DEFAULT_KEY_CHAINS_MOVED`. |
| `PresentationConfig` | v2 | `registration_cert.body.provided_attestations` is replaced by the registrar's `provides_attestations` (string array). The v1 → v2 step drops the old field with a warning. |
| `PresentationConfig` | v3 | DCQL claim `values` accept integers and booleans besides strings and must be non-empty. A v2 file is a valid v3 file unless it has an empty `values` array. |
| `PresentationConfig` | v4 | Optional `allowedOrigins` (web origins for Digital Credentials API requests). A v3 file is a valid v4 file; a bare presentation file with `allowedOrigins` is read as v4 (`bareFileVersion`). |
| `TrustList` | v2 | Entity info follows ETSI TS 119 602: `info.country` is an ISO 3166-1 alpha-2 code in capital letters (`UK`, `EL`, `EU` as exceptions), `info.lang` a lower-case RFC 5646 tag and `info.uri` an absolute URI; the required `info.contactUri` (e-mail address) and the new required `info.website` and optional `info.phone` form `TEElectronicAddress` (clause 6.5.3.2). v1 has no `website`, so the v1 → v2 step is report-only and always stops with `TRUST_LIST_WEBSITE_MISSING`; it also names every other value v2 refuses: `TRUST_LIST_CONTACT_URI_MISSING`/`_INVALID`, and `TRUST_LIST_COUNTRY_INVALID`, `TRUST_LIST_LANGUAGE_INVALID` (with the value to write, for example `UK` for `gb`) and `TRUST_LIST_URI_INVALID`. |
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

5. Bring the bundled demo tenant to the new version. `eudiplo init --demo-tenant` and `eudiplo config tenant create --template demo` copy `assets/config/demo`, so a file there that is behind fails `eudiplo config upgrade --check` in a fresh project. The CLI test `generates configuration that needs no upgrade` (`apps/cli/test/runtime.test.ts`) fails until you upgrade it from the repository root (`dev` runs in `apps/cli`, and the `--output` folder must not exist yet):

    ```bash
    pnpm --filter @eudiplo/cli dev config upgrade ../../assets/config/demo --output ../../tmp/demo-upgraded
    cp -R tmp/demo-upgraded/. assets/config/demo/ && rm -rf tmp/demo-upgraded
    pnpm --filter @eudiplo/cli assets:sync
    ```

6. Add tests for the migration step (valid transformation, source and target validation, required input, running the upgrade twice) in `packages/eudiplo-config-format` and, for CLI behavior, `apps/cli/test/config-upgrade.test.ts`.
7. Run the checks CI runs:

    ```bash
    pnpm schemas:check-contract        # current DTOs match the committed schemas and snapshots
    pnpm schemas:check                 # bundled snapshots are in sync
    pnpm schemas:check-history origin/main   # no snapshot of a release was changed
    pnpm schemas:check-ids             # every snapshot has its eudiplo.dev $id and resolvable references
    ```

8. Commit schema, snapshot, generated files, tests and documentation together, and describe the change in the [upgrade guide](../upgrade/index.md) of the next major: files exported by the new release cannot be imported into older ones. A migration step that rewrites the `spec` or `metadata` of a `KeyChain` document, or of a `Client` document with `"secret": "!generate"`, makes such a document differ from the one last applied, so the next `upsert` or `replace` import applies it once more: CA keys get a new signing key, `regenerate` creates new key material and the client gets a new secret, which a startup import does not show. Say so in that guide too. A step that returns `spec` and `metadata` unchanged keeps them as they are.

`schemas:snapshot` without a resource name checks and snapshots every current resource. Running `schemas:snapshot` alone is not enough: `schemas:check-contract` fails when a DTO changed but the version was not bumped.

## Immutable snapshots

Files under `schemas/v*/` are publication artifacts once a release ships them. Never edit or delete one; CI compares the snapshots of the latest release tag before the pull request base with the working tree (`scripts/check-published-schemas.mjs`) and fails on any change. A snapshot that no release has shipped yet can still change before the release, for example to rename a value; files written by a build of `main` in between may then need editing before they import. Each resource schema contains its dependencies in `$defs`, so one resource can move to a new version while the others stay. The schema's own `$schema` is the JSON Schema dialect; its `$id` is the public EUDIPLO URL that files reference.

## Publishing

eudiplo.dev serves the schemas at `eudiplo.dev/schemas/…`. The site is built in its own repository, [EUDIPLO/website](https://github.com/EUDIPLO/website): its build checks out this repository, copies every `schemas/v*/` snapshot, verifies the schema ids and references (the same checks as `pnpm schemas:check-ids`) and writes `/schemas/index.json`. Its `_headers` allows cross-origin reads and sets the JSON Schema content type; its `404.html` keeps unknown versions from falling back to the home page.

Pushes to `main` here deploy the website preview with the schemas of that commit. A release here, or *Versioned Release* with `deploy_site_only`, deploys production with the schemas of the deployed commit. The website repository also deploys production on its own pushes and once a month, built from the head of `main` here. A version added on `main` can therefore go live before the release that introduces it; until that release ships it, the snapshot may still change (see [Immutable snapshots](#immutable-snapshots)). The website only builds from commits on `main`, and production always takes the CLI installer (`apps/cli/install.sh`) from the latest release.
