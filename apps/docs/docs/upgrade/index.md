---
title: Upgrade
---

# Upgrading EUDIPLO

Minor and patch releases are drop-in: change the image tag and restart. A new major version can need changes to your configuration, integration or deployment; its upgrade guide lists every one of them.

## Upgrade guides

Upgrade one major version at a time and read every guide on the way.

| From | To | Guide |
| --- | --- | --- |
| 8.x | 9.0 | [8.x to 9.0](./8.x-to-9.0.md): object storage, outbound URL and schema synchronization defaults, TLS fails closed, stricter OAuth and OID4VP, role-scoped sessions, key export and KMS configuration, session expiry, presentation webhooks, new configuration file formats |
| 7.x | 8.0 | [7.x to 8.0](./7.x-to-8.0.md): canonical `$schema` envelopes for configuration files |
| 6.x | 7.0 | [6.x to 7.0](./6.x-to-7.0.md): verifier material for wallet-provider trust lists |
| 5.x | 6.0 | [5.x to 6.0](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/5.x-to-6.0.md) (at tag v8.1.0): `authorizationServers` model |
| 4.x | 5.0 | [4.x to 5.0](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/4.x-to-5.0.md) (at tag v8.1.0): field-based credential configuration |
| 3.x | 4.0 | [3.x to 4.0](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/3.x-to-4.0.md) (at tag v8.1.0): `/api` prefix, key chains, attribute providers |
| 2.x | 3.0 | No action; the migration system was introduced and runs automatically. |

## Upgrade procedure

1. **Read the guide** of every major version you cross and the [release notes](https://github.com/openwallet-foundation/eudiplo/releases) of the versions in between.
2. **Back up** everything you would need to go back:
    - the database (for PostgreSQL `pg_dump`; for SQLite a copy of the database file taken while EUDIPLO is stopped),
    - the configuration folder (`CONFIG_FOLDER`; `config/` in a CLI project) and the env file,
    - uploaded files (`LOCAL_STORAGE_DIR` or the S3 bucket),
    - the key material behind encrypted columns: `MASTER_SECRET` when `ENCRYPTION_KEY_SOURCE=env`, otherwise the key in Vault, AWS or Azure. A database backup cannot be read without it.
3. **Export the tenant configuration** if you manage it as files: `eudiplo config export --output <bundle>`, then `eudiplo config upgrade <bundle> --dry-run` shows the format migrations the new release applies ([Configuration as code](../operate/configuration-as-code.md)).
4. **Apply the changes** the guide lists for your environment variables, configuration and integrations.
5. **Deploy the new version.**
    - Compose project created with the CLI: `eudiplo upgrade --image-tag X.Y.Z`. It rewrites `EUDIPLO_IMAGE` and `EUDIPLO_CLIENT_IMAGE` in the instance's env file, pulls and recreates the services, and prints the upgrade guide for every major version it crosses. It changes nothing else: the Compose file and the other variables stay as they are.
    - Any other deployment: set the tag of `ghcr.io/openwallet-foundation/eudiplo` and `ghcr.io/openwallet-foundation/eudiplo-client` to the new version and redeploy. Use the same version for both; the client shows a warning when it talks to a backend from a different release.
    - Start one backend instance first; it applies the database migrations on startup (`DB_MIGRATIONS_RUN=true`, the default). Scale out after it is healthy.
6. **Verify.** `GET /health` reports `"status": "ok"`, the startup log shows no migration or configuration import errors, `eudiplo doctor --strict` passes for CLI-managed instances, and `GET /api/version` reports the new version. Run one issuance and one presentation end to end.

Pin a full version tag (`:9.0.0`) in production. The release images are also tagged `:9.0`, `:9` and `:latest`.

:::warning[No downgrades]
Database migrations are not reverted when you start an older image. To go back, restore the backup taken in step 2.
:::

:::danger[`:main` images]
Images tagged `:main` are development builds. Their database migrations can still change before the release, so upgrading a `:main` database to a later snapshot or to a release is not supported. Use a fresh database for every `:main` snapshot, or run a release.
:::

## Compatibility policy

EUDIPLO follows [Semantic Versioning](https://semver.org/):

- **Breaking changes only in major versions.** Removed or renamed API fields and endpoints, changed defaults, stricter validation, new required environment variables and changed configuration formats wait for a major release, which comes with an upgrade guide. A breaking change in a minor or patch release is a bug; please [report it](https://github.com/openwallet-foundation/eudiplo/issues/new?template=bug_report.md).
- **Deprecation before removal** where feasible: a minor release deprecates, the next major removes.
- **Database migrations are automatic.** No manual SQL is needed.
- **Configuration files are versioned per resource.** A release imports files of its own and older format versions and upgrades them; it rejects files with a newer version. Files exported from a new major can therefore not be imported into the previous one.
- **Client and backend** of the same release work together; releases that differ only in the patch version are compatible.

## Verifying release artifacts

The standalone CLI archives and `SHA256SUMS.txt` of every release carry a signed GitHub build provenance attestation; the Sigstore bundle is attached to the release as `provenance.sigstore.json`. Download the archive for your platform and the bundle from the same release, then verify with the GitHub CLI:

```bash
gh attestation verify ./eudiplo-vX.Y.Z-linux-x64.tar.gz \
  --repo openwallet-foundation/eudiplo \
  --signer-workflow openwallet-foundation/eudiplo/.github/workflows/release.yml \
  --bundle ./provenance.sigstore.json
```

For v8.0.1, which has no attached bundle, omit `--bundle` to fetch the attestation from GitHub; earlier releases have none. The attestation proves which workflow built the artifact; a checksum alone only detects changes relative to the checksum file.

## If the upgrade fails

1. Read the startup log: migrations, configuration import and environment validation report their errors there.
2. Compare your env file with the `.env.example` of the target release.
3. Check the upgrade guide again for the area that fails.
4. If the guide does not cover your case, [open an issue](https://github.com/openwallet-foundation/eudiplo/issues/new?template=bug_report.md). Restore the backup if you need the old version back.
