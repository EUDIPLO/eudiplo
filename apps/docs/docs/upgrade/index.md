---
title: Migration & Upgrade Guide
---

# Migration & Upgrade Guide

This section provides step-by-step guidance for upgrading EUDIPLO between versions, with a focus on breaking changes and required actions.

## Upgrade Process

When upgrading EUDIPLO, follow this general process:

1. **Read the release notes** for every version between your current and target version
2. **Check the migration guide** below for your target version
3. **Back up your database** before upgrading
4. **Update environment variables** as documented
5. **Deploy the new version** — database migrations run automatically on startup
6. **Verify** that the service starts correctly and your integrations work

For tenant configuration, export a safe bundle before the application upgrade, run `eudiplo config upgrade <bundle> --dry-run`, and plan the import against the new instance. Config migrations are separate from database migrations and run sequentially per resource schema. See [Configuration Model](../operate/configuration-as-code.md#configuration-model).

:::warning[Always upgrade sequentially]
If you are multiple major versions behind, upgrade one major version at a time. Do not skip major versions.
:::

:::danger[Using the `main` branch image? Start with a fresh database]
The `main` branch image tracks active development and **does not guarantee complete database migrations between snapshots**. Migration files are only finalized when a version is released. If you are running `main` and pull a newer snapshot, schema changes may have been added without a corresponding migration, causing startup failures or data corruption.

**The only safe approach for `main` is to start with a fresh database each time you update.** If you need a stable, upgradeable deployment, use a tagged release image instead.
:::

## Version History

| Version | Status             | Notes                                                                                                                                                                 |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.x     | Archived           | Initial development and protocol testing                                                                                                                              |
| 2.x     | Archived           | First stable release                                                                                                                                                  |
| 3.x     | Maintained         | Introduced automatic database migrations. Bumped from v2 due to the migration system being flagged as a breaking change, though no user-facing API changes were made. |
| 4.x     | Maintained         | Unified Key Chain model, Attribute Providers, `/api/` prefix, @owf ecosystem packages.                                                                                |
| 5.0     | **Current stable** | Field-based credential configuration model (v2), improved UX for config creation.                                                                                     |
| 6.0     | Planned            | Authorization server model migration to `authorizationServers` and related issuance config updates.                                                                   |
| 7.0     | Planned            | Strict trust-list integrity for wallet-provider trust lists (`walletProviderTrustLists`) requiring verifier material.                                                 |
| 8.0     | Planned            | Portable configuration resources now use canonical `$schema` envelopes; legacy `apiVersion`/`kind` envelopes are no longer accepted.                                |

## Migration Guides

### Bundled object storage: MinIO to RustFS

The CLI and deployment templates now use RustFS with new service names,
credentials, and data volumes. Existing MinIO objects must be copied through
the S3 API before switching endpoints; reusing the old data directory is not
supported. Follow the migration instructions for
[Docker Compose](../operate/docker-compose.md#migrating-existing-minio-storage)
or [Kubernetes](../operate/kubernetes.md#migrating-existing-minio-storage).

### Application versions

| From | To  | Guide                                                                                                     |
| ---- | --- | --------------------------------------------------------------------------------------------------------- |
| 2.x  | 3.0 | No action required — the migration system is backward compatible. Just update and start.                  |
| 3.x  | 4.0 | [Migration Guide](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/3.x-to-4.0.md) — API prefix, Key Chains, Attribute Providers, and more                |
| 4.x  | 5.0 | [Migration Guide](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/4.x-to-5.0.md) — Field-based credential configuration (v2)                            |
| 5.x  | 6.0 | [Migration Guide](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/5.x-to-6.0.md) — Authorization server model (`authorizationServers`)                  |
| 6.x  | 7.0 | [Migration Guide](./6.x-to-7.0.md) — Strict trust-list verifier requirements (`walletProviderTrustLists`) |
| 7.x  | 8.0 | [Migration Guide](./7.x-to-8.0.md) — Canonical portable configuration envelopes                           |

## What Can Break Between Versions

### Major Versions (Breaking Changes)

Major versions may include:

- **Database schema changes** — handled automatically by the migration system (see [Database](../operate/database.md))
- **Environment variable changes** — new required variables, renamed variables, or changed defaults
- **API changes** — modified request/response formats, removed endpoints, changed field names
- **Configuration format changes** — credential configs, issuance configs, or presentation configs with new required fields or changed structure
- **Protocol updates** — changes to OID4VCI/OID4VP behavior to align with spec updates

### Minor Versions

Minor versions add features in a backward-compatible way. However, new optional fields may appear in API responses or configuration objects.

### Patch Versions

Patch versions contain only bug fixes and should never require any migration steps.

## Backward Compatibility Policy

EUDIPLO follows [Semantic Versioning](https://semver.org/):

- **Breaking changes only happen in major versions.** If you experience a breaking change in a minor or patch release, please [report it as a bug](https://github.com/openwallet-foundation/eudiplo/issues/new?template=bug_report.md).
- **Deprecation before removal.** Where feasible, features are deprecated in a minor release before being removed in the next major release.
- **Database migrations are automatic.** Schema changes are handled by the migration system and should not require manual intervention.

## Troubleshooting Upgrades

If you encounter issues after upgrading:

1. **Check the logs** — EUDIPLO logs migration steps and configuration errors on startup
2. **Compare environment variables** — diff your `.env` against the latest `example.env`
3. **Check the migration guide** — the version-specific guide lists all required actions
4. **Open an issue** — if the migration guide doesn't cover your situation, [let us know](https://github.com/openwallet-foundation/eudiplo/issues/new?template=bug_report.md)
