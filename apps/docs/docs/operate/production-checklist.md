---
title: Production Checklist
---

# Production Checklist

Work through this list before an instance serves real wallets and users, and
again after major upgrades. Each item links to the guide that explains it.

## Secrets

- [ ] `MASTER_SECRET` is a random value of at least 32 characters
      (`openssl rand -base64 32`), kept in a secret manager and never changed
      while the data exists ([Encryption keys](encryption-keys.md#keep-the-key-stable)).
- [ ] The encryption key is backed up: `MASTER_SECRET` with the default
      `ENCRYPTION_KEY_SOURCE=env`, or the key in `vault`, `aws` or `azure`
      ([Encryption keys](encryption-keys.md#choose-a-key-source)). An external
      key source is optional; it keeps the key out of the backend's
      environment. The bundled Vault of the `full` preset runs in development
      mode and loses the key on every restart
      ([presets](index.md#presets-and-profiles)).
- [ ] `AUTH_CLIENT_SECRET` is random. Changing it in the environment later has
      no effect; rotate it with `POST /api/client/<id>/rotate-secret`
      ([Tenants and access](tenants-and-access.md#built-in-oauth2-server)).
- [ ] No default or example credentials remain: database password, RustFS/S3
      keys, Vault token `root`, Grafana `admin`/`admin`, the demo client
      `root`/`root`.
- [ ] No demo tenant or bundled demo keys (`eudiplo demo`, `--demo-tenant`,
      `--template demo`) are deployed.
- [ ] Secrets in tenant config files are `${VAR}` placeholders, not literal values
      ([Configuration as code](configuration-as-code.md#provision-tenants-from-a-folder)).

## Network and TLS

- [ ] `PUBLIC_URL` is the public `https://` URL, and its certificate is issued by
      a public CA. The backend is served at the root of its host name
      ([TLS and reverse proxy](tls.md)).
- [ ] The backend port is reachable only through the reverse proxy
      (`EUDIPLO_BIND_ADDRESS=127.0.0.1` in Compose).
- [ ] RustFS (ports 9000 and 9001) and Vault (8200) are not reachable from other
      hosts. The current Compose file binds them to `EUDIPLO_BIND_ADDRESS` like
      the backend. Older Compose files, including the `eudiplo.compose.yaml` of
      existing CLI projects, publish them on all interfaces: remove those
      `ports:` entries or block the ports in a firewall in front of the host
      ([Compose](docker-compose.md#services)).
- [ ] `CORS_ORIGINS` lists exactly the origins of the web client and of your own
      frontends that call `/api/*` from the browser, for example
      `CORS_ORIGINS=https://console.example.com`. Protocol endpoints stay open.
- [ ] The reverse proxy, API gateway or WAF rate-limits the token, PAR and
      credential endpoints and the management API; EUDIPLO has no built-in rate
      limiting. Where possible, restrict `/api/*` to known networks, and
      exclude the WAF rules that block wallet requests
      ([Web application firewall](waf.md)).
- [ ] `OUTBOUND_URL_ALLOW_HTTP` and `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` stay
      `false` (the default since 9.0). Webhooks, attribute providers, metadata,
      trust lists, status lists, federation entities, external authorization
      servers and the upstream provider of a chained authorization server then
      need public HTTPS targets; CRLs may use HTTP.
      `OUTBOUND_URL_ALLOWED_HOSTS` additionally limits them to the listed
      hosts; it does not exempt a host from either check, so a webhook on a
      private address still needs `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true`.
- [ ] Egress is restricted at the network level if EUDIPLO must not reach
      internal services: KMS providers, including those in a tenant's KMS
      configuration, are called without the outbound URL policy
      ([security model](../concepts/security-model.md#https-and-tls)).
- [ ] Services with private CAs (Vault, KMS, webhooks, PostgreSQL) are trusted
      through `NODE_EXTRA_CA_CERTS` or `DB_SSL_CA_PATH`, never by disabling
      certificate checks.

## Access

- [ ] Each application has its own API client with only the roles it needs,
      usually `issuance:offer` and `presentation:request`, limited with
      `allowedIssuanceConfigs` and `allowedPresentationConfigs`
      ([Tenants and access](tenants-and-access.md#api-clients-with-least-privilege)).
- [ ] `tenants:manage` and `tenant:admin` are held only by operators and the
      configuration pipeline ([Roles](../reference/roles.md)).
- [ ] People sign in through your identity provider rather than with shared
      client secrets ([Keycloak SSO](keycloak.md)).

## Keys, certificates and checks

- [ ] Signing keys live in the KMS your security model requires
      ([KMS](kms.md)); the `db` provider stores them encrypted in the database.
- [ ] Access and registration certificates come from your registrar instead of
      self-signed certificates ([Registrar](../trust/registrar.md),
      [Registration certificates](../trust/registration-certificates.md)).
- [ ] No `SKIP_*` flag is set; the startup log lists active ones
      ([Skip flags](../reference/environment-variables.md#skip-flags)).
- [ ] Outside the container image, for example with `node dist/main.js` from a
      source build, `NODE_ENV=production` is set. Otherwise EUDIPLO skips TLS
      certificate checks when it fetches status lists, trust lists and
      federation entity configurations, returns internal error messages to API
      callers, and `LOG_LEVEL` defaults to `debug` instead of `warn`
      ([Environment variables](../reference/environment-variables.md#general)).
- [ ] Issuance configurations require DPoP and wallet attestation where your use
      case demands it ([Authorization servers](../issuance/authorization-servers.md)).

## Data and logs

- [ ] PostgreSQL is used for anything beyond a single small instance, with
      `DB_SSL=true` when it is not on the same host ([Database](database.md)).
- [ ] Session retention (`SESSION_TTL`, `SESSION_CLEANUP_MODE`) and audit log
      retention (`AUDIT_LOG_RETENTION_DAYS`, `AUDIT_LOG_MAX_ENTRIES_PER_TENANT`)
      match your data protection rules ([Database](database.md#session-retention),
      [Logging](logging.md#audit-log)).
- [ ] Logs do not capture personal data: `LOG_REDACT_SENSITIVE_DATA=true`,
      `LOG_HTTP_RESPONSE_BODY=false`, `LOG_OID4VP_DECRYPTED_RESPONSE=false`,
      `LOG_SESSION_STORE` not `verbose` ([Logging](logging.md)).

## Backups

Back up all of these together; a restore needs every part:

| What                         | How                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Database                     | `pg_dump` (bundled stack: `docker compose exec -T postgres pg_dump -U eudiplo -Fc eudiplo > eudiplo.dump`), or the SQLite file `<FOLDER>/service.db` while the backend is stopped |
| Object storage               | Bucket versioning or replication, or a copy of `LOCAL_STORAGE_DIR`                      |
| Encryption key               | `MASTER_SECRET` (with `ENCRYPTION_KEY_SOURCE=env`) or the external key, in your secret manager |
| Signing keys in a KMS        | The KMS's own backup (Vault snapshots, AWS KMS key policies, HSM backup)                |
| Configuration                | The config folder in version control, or `eudiplo config export` per tenant              |
| Environment                  | The env file or Kubernetes secret, without which the backend does not start             |

- [ ] Backups run on a schedule and a restore has been tested on a separate
      instance.
- [ ] A backup is taken before every upgrade; migrations cannot be undone
      ([Database](database.md#migrations)).

## Operations

- [ ] Image versions are pinned to a release (`X.Y.Z`), and backend and web
      client run the same version ([Kubernetes](kubernetes.md#2-pin-the-image-version),
      [CLI](cli.md#upgrade-the-application)).
- [ ] Metrics, traces and logs reach your monitoring, and someone receives the
      alerts ([Monitoring](monitoring.md)).
- [ ] `eudiplo doctor --strict` passes, also as a scheduled check with
      `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET` set ([CLI](cli.md#check-an-instance-with-doctor)).
      With the root client the KMS check is skipped; a tenant client with
      `issuance:manage` checks the KMS providers as well:

```bash
eudiplo doctor --instance production --strict
```
