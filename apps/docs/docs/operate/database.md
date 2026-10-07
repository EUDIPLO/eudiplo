---
title: Database
---

# Database

Connect EUDIPLO to SQLite or PostgreSQL, understand how schema migrations run,
and set how long session data is kept. Sensitive columns are encrypted; the key
is configured in [Encryption keys](encryption-keys.md).

## Choose a database

`DB_TYPE` accepts `sqlite` (default) and `postgres`.

| Database   | Use it for                                                       | Data location                       |
| ---------- | ---------------------------------------------------------------- | ----------------------------------- |
| SQLite     | One backend process: tests, demos, small single-VM installations | `<FOLDER>/service.db`               |
| PostgreSQL | Production, and every setup with more than one backend replica   | Your PostgreSQL server              |

`FOLDER` is `/app/config` in the container image (so the file is
`/app/config/service.db`); outside the image it defaults to `../../tmp` relative
to the working directory. With SQLite, `DB_HOST`, `DB_DATABASE` and the other
connection variables are ignored.

## Connect to PostgreSQL

```env
DB_TYPE=postgres
DB_HOST=postgres.internal
DB_PORT=5432
DB_USERNAME=eudiplo
DB_PASSWORD=<password>
DB_DATABASE=eudiplo
```

All five connection variables are required with `postgres`. In the bundled
Compose and Kubernetes setups the host is `postgres`.

For servers that require TLS, typically managed cloud databases:

```env
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true                  # default; keep it in production
DB_SSL_CA_PATH=/certs/postgres-ca.crt           # for private CAs
DB_SSL_CERT_PATH=/certs/client.crt              # client certificate, if required
DB_SSL_KEY_PATH=/certs/client.key
DB_SSL_KEY_PASSPHRASE=<passphrase>              # for an encrypted client key
```

`DB_SSL_REJECT_UNAUTHORIZED=false` accepts any server certificate; use it only
for local tests. All variables are listed under
[Database](../reference/environment-variables.md#database).

**Checkpoint:** `GET /health` reports `"database": { "status": "up" }`.

## Migrations

The backend applies pending schema migrations on start (`DB_MIGRATIONS_RUN=true`,
the default). A fresh, empty database is created by the same migrations, so
leave `DB_SYNCHRONIZE=false` from the first start on; `DB_SYNCHRONIZE=true`
lets TypeORM change the schema from the entity definitions and is meant for
development only. With `DB_MIGRATIONS_RUN=false`, the backend logs a warning
when migrations are pending; to apply them, start a single backend instance
once with `DB_MIGRATIONS_RUN=true`, wait until `GET /health` is `ok`, and
start the other instances afterwards.

Plan upgrades with migrations in mind:

- **Back up the database before every upgrade.** Some migrations convert or
  remove data and cannot be reverted (for example the move of keys into key
  chains, or the removal of `provided_attestations` in 9.0). Starting the
  previous image afterwards does not restore the old schema. To roll back,
  restore the backup and run the previous version.
- **Let one process migrate.** With several replicas, scale to one replica (or
  start one new replica first), wait until it is healthy, then scale up.

Developers who create migrations find the commands in the
[backend architecture guide](../contributing/backend-architecture.md).

## Session retention

The backend checks sessions every `SESSION_TIDY_UP_INTERVAL` seconds (default
`3600`). It marks open sessions whose lifetime has passed as `expired`, and
handles sessions older than the retention period:

| Variable               | Default | Meaning                                                                                                        |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `SESSION_TTL`          | `86400` | Retention period in seconds                                                                                    |
| `SESSION_CLEANUP_MODE` | `full`  | `full` deletes old sessions; `anonymize` keeps status and timestamps but removes credentials, claims, offers, requests and keys |

A tenant can override both with `PUT /api/session-config` (roles
`issuance:manage` or `presentation:manage`):

```json
{ "ttlSeconds": 3600, "cleanupMode": "anonymize" }
```

`ttlSeconds` must be at least 60. `DELETE /api/session-config` restores the
global defaults. [Session logs](logging.md#session-logs) are deleted together
with their session; `anonymize` keeps them.
