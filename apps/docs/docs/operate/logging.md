---
title: Logging
---

# Logging

Set the log level and destinations, keep per-session protocol logs for
troubleshooting, and bound the audit log. Metrics and traces are covered in
[Monitoring](monitoring.md).

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="log" />

## Log level and destinations

`LOG_LEVEL` accepts `trace`, `debug`, `info`, `warn`, `error` and `fatal`. Its
default is `debug`, but `warn` when `NODE_ENV=production`, which the container
image sets. Set `LOG_LEVEL=info` to see startup and flow messages in a container.

The backend writes logs to up to three destinations at the same level:

| Destination            | Format                         | Enabled by                                           |
| ---------------------- | ------------------------------ | ---------------------------------------------------- |
| Console (stdout)       | Human-readable (pino-pretty)   | always                                               |
| File                   | JSON, one object per line      | `LOG_TO_FILE=true`, path `LOG_FILE_PATH`             |
| OpenTelemetry (Loki)   | OTLP log records with trace IDs | always, unless `OTEL_SDK_DISABLED=true` ([Monitoring](monitoring.md)) |

For structured logs in a log platform, use the OpenTelemetry export or the JSON
file. The file is not rotated; use `logrotate` or similar.

## HTTP request logs

`LOG_ENABLE_HTTP_LOGGER=true` logs requests and responses of the wallet-facing
endpoints. Management API calls (`/api/...`) and `/health` are never logged this
way. With `LOG_REDACT_SENSITIVE_DATA=true` (default), these values are replaced
by `[redacted]`: the `Authorization`, `Cookie`, `DPoP`,
`OAuth-Client-Attestation` and `OAuth-Client-Attestation-PoP` request headers,
`Set-Cookie`, and the response fields `access_token`, `refresh_token`,
`id_token`, `c_nonce`, `credential`, `credentials` and `attestation_challenge`.

`LOG_HTTP_RESPONSE_BODY=true` adds response bodies (up to
`LOG_HTTP_RESPONSE_BODY_MAX_LENGTH` bytes). Bodies can contain credentials and
personal data; enable it only while debugging.

To inspect decrypted wallet responses during local debugging, set both
`LOG_LEVEL=trace` and `LOG_OID4VP_DECRYPTED_RESPONSE=true`. These logs contain
personal data; never enable this in shared or production environments.

## Session logs

Session logs record the protocol steps of one issuance or presentation
session, for example authorization, token exchange, credential issuance or
presentation verification, with errors. Enable them and choose what is stored
in the database:

```env
LOG_ENABLE_SESSION_LOGGER=true
LOG_SESSION_STORE=errors
```

| `LOG_SESSION_STORE` | Stored                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `off` (default)     | Nothing; events go only to the log destinations                         |
| `errors`            | Warnings and errors                                                     |
| `all`               | All events                                                              |
| `verbose`           | All events with full request and response bodies and error stacks       |

`LOG_SESSION_STORE` has no effect without `LOG_ENABLE_SESSION_LOGGER=true`.
Read the entries with `GET /api/session/:id/logs` (role `issuance:offer` for
issuance sessions, `presentation:request` for presentation sessions) or in the
**Logs** tab of a session in the web client.
They are deleted with their session ([session retention](database.md#session-retention)).
`verbose` stores personal data and much more volume; use it for debugging only.

## Correlate logs with sessions

Once a request has resolved its session (by offer ID, `walletNonce`, `issuer_state`, code or access token), every following log line of that request, including the HTTP request log, carries `sessionId` and `tenantId`. This works with or without OpenTelemetry; with it, the request span and the span handling the session also get `session.id`.

- The OID4VP routes (`/presentations/{walletNonce}/oid4vp/...`) contain the wallet nonce, not the session ID, so the HTTP request log reports it as `req.walletNonce`.
- The value of the session search parameter `q` is always replaced by `[redacted]` in logged URLs and in the `url.query` span attribute, because it can contain a pre-authorized code.

To go from a log line or a pasted offer link to the session, search the session list with `GET /api/session?q=...` ([Finding sessions](../concepts/sessions.md#finding-sessions)).

## Audit log

Changes to a tenant and to its credential, issuance, presentation and
status-list configurations, webhook endpoints and attribute providers are
recorded with actor, time and changed fields, as are bundle imports, exports,
detach and reattach actions, generated client secrets and cancelled sessions (with the
reason). Secrets are not recorded: the API keys of webhook endpoints and
attribute providers and the upstream client secrets of chained authorization
servers appear as `[REDACTED]`, and a changed secret is still listed among the
changed fields. Not audited: key chains, trust lists, API clients and users (including
role changes and secret rotation), KMS provider and registrar configuration,
and session retention settings. Read the audit log with
`GET /api/admin/audit-logs` (role `clients:manage`) or in the web client. The
audit log is kept forever unless you limit it; a daily job at 03:00 applies:

```env
AUDIT_LOG_RETENTION_DAYS=365          # delete entries older than this, 0 = keep
AUDIT_LOG_MAX_ENTRIES_PER_TENANT=10000  # keep only the newest N per tenant, 0 = all
```

Use session logs to answer "what happened in this flow?" and the audit log for
"who changed the configuration, and when?".
