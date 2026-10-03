---
title: Logging Configuration
---

# Logging Configuration

The EUDIPLO Service provides flexible logging configuration to help with debugging, monitoring, and auditing.

## Configuration

| Key                                 | Type      | Notes                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                         | `string`  | Application log level (default: `debug`)                                                                                                                                                                                                                            |
| `LOG_ENABLE_HTTP_LOGGER`            | `boolean` | Enable HTTP request logging (default: `false`)                                                                                                                                                                                                                      |
| `LOG_HTTP_RESPONSE_BODY`            | `boolean` | Capture and log HTTP response bodies (buffered up to LOG_HTTP_RESPONSE_BODY_MAX_LENGTH bytes). Disabled by default because response bodies may contain access tokens, credentials, or other sensitive data. (default: `false`)                                      |
| `LOG_HTTP_RESPONSE_BODY_MAX_LENGTH` | `number`  | Maximum number of bytes to capture for HTTP response bodies. Set to 0 to disable truncation. (default: `4096`)                                                                                                                                                      |
| `LOG_REDACT_SENSITIVE_DATA`         | `boolean` | Redact sensitive request/response fields from logs. Disable only for debugging. (default: `true`)                                                                                                                                                                   |
| `LOG_OID4VP_DECRYPTED_RESPONSE`     | `boolean` | Log decrypted OID4VP authorization responses. Use only for local debugging because responses may contain personal data and credentials. (default: `false`)                                                                                                          |
| `LOG_ENABLE_SESSION_LOGGER`         | `boolean` | Enable session flow logging (default: `false`)                                                                                                                                                                                                                      |
| `LOG_SESSION_STORE`                 | `string`  | Controls whether session log entries are persisted to the database. 'off' disables storage, 'errors' stores only warn/error entries, 'all' stores everything, 'verbose' stores everything including full request/response bodies and error stacks. (default: `off`) |
| `LOG_TO_FILE`                       | `boolean` | Enable logging to file in addition to console (default: `false`)                                                                                                                                                                                                    |
| `LOG_FILE_PATH`                     | `string`  | File path for log output when LOG_TO_FILE is enabled (default: `./logs/session.log`)                                                                                                                                                                                |
| `AUDIT_LOG_RETENTION_DAYS`          | `number`  | Delete tenant activity audit log entries older than N days. Set to 0 to disable time-based pruning. (default: `0`)                                                                                                                                                  |
| `OTEL_SDK_DISABLED`                 | `boolean` | Disable OpenTelemetry SDK (and OTel log forwarding) (default: `false`)                                                                                                                                                                                              |
| `AUDIT_LOG_MAX_ENTRIES_PER_TENANT`  | `number`  | Keep only the newest N tenant activity audit log entries per tenant. Set to 0 to disable count-based pruning. (default: `0`)                                                                                                                                        |

## Basic Log Level Configuration

Control the overall log level using the `LOG_LEVEL` environment variable:

```bash
# Show all logs (debug, info, warn, error)
LOG_LEVEL=debug

# Include trace logs. Required together with LOG_OID4VP_DECRYPTED_RESPONSE=true
# to log the decrypted OID4VP authorization response.
LOG_LEVEL=trace

# Show only info, warn, error (default)
LOG_LEVEL=info

# Show only warnings and errors
LOG_LEVEL=warn

# Show only errors
LOG_LEVEL=error
```

## Logging Destinations

### File Logging

The application supports logging to both console and file simultaneously, which is useful for debugging, auditing, and persisting logs for later analysis.

File logging is controlled via environment variables:

| Variable        | Description            | Default              |
| --------------- | ---------------------- | -------------------- |
| `LOG_TO_FILE`   | Enable logging to file | `false`              |
| `LOG_FILE_PATH` | Path to the log file   | `./logs/session.log` |

When `LOG_TO_FILE` is set to `true`, the system will:

1. Write all logs to the console with pretty formatting as usual
2. Write the same logs to the specified file in `LOG_FILE_PATH` in JSON format
3. Use synchronous file writes to ensure message order is maintained

#### Message Order Synchronization

The file logging is configured with `sync: true` to ensure that log messages are written in the exact order they are generated. This is especially important for session logging where the sequence of events matters.

#### Usage Example

To enable file logging, add the following to your `.env` file or environment variables:

```bash
LOG_TO_FILE=true
LOG_FILE_PATH=./logs/sessions.log
```

#### Log File Format

The log files are written in JSON format for easy parsing and analysis by external tools. Each log entry is a complete JSON object on a new line.

#### Log Rotation

The current implementation does not include built-in log rotation. For production environments, it is recommended to use external log rotation tools like `logrotate` to manage log file size and retention.

## Session Log Persistence

In addition to Pino console/file logging, session flow events can be persisted to the database so they are available per-session via the API and the Web Client.

```bash
# Disable persistence (default)
LOG_SESSION_STORE=off

# Store only warn/error entries
LOG_SESSION_STORE=errors

# Store all session log entries
LOG_SESSION_STORE=all

# Store all entries with full request/response bodies and error stacks
LOG_SESSION_STORE=verbose
```

When enabled, log entries are written to the `session_log_entry` table and can be retrieved via `GET /api/session/{id}/logs`. The Web Client shows them in the **Logs** tab on the session detail page.

:::warning[Verbose Mode]
`verbose` mode captures full HTTP response bodies and error stack traces. This can generate large amounts of data and may include sensitive information. Use it only for debugging and disable it in production.
:::

:::note Session Logger Required
`LOG_SESSION_STORE` requires `LOG_ENABLE_SESSION_LOGGER=true` to have any effect, since the session logger is the source of the persisted events.
:::

:::warning[Decrypted OID4VP Responses]
To troubleshoot wallet response decryption or parsing locally, enable both settings:

```bash
LOG_LEVEL=trace
LOG_OID4VP_DECRYPTED_RESPONSE=true
```

This logs the decrypted authorization response to the configured log destinations. Treat those logs as sensitive, remove them after debugging, and keep the setting disabled in shared or production environments.
:::

## Which Log For Which Audit Trail?

Use the following distinction to avoid mixing internal management history with issuance/presentation flow evidence:

| Purpose                                                           | Log Type                   | Database Table      | API Access                   | Main Scope                          |
| ----------------------------------------------------------------- | -------------------------- | ------------------- | ---------------------------- | ----------------------------------- |
| Internal tenant management history (admin/config changes)         | Tenant activity audit logs | `tenant_action_log` | `GET /api/admin/audit-logs`  | Tenant-level management actions     |
| Issuance and presentation flow evidence (operational audit trail) | Session flow logs          | `session_log_entry` | `GET /api/session/{id}/logs` | Per-session protocol/runtime events |

Rule of thumb:

1. Use tenant activity logs to answer "who changed tenant/config state and when?"
2. Use session flow logs to answer "what happened during issuance/presentation for this session?"

## Disabling Specific Logger Services

### HTTP Request/Response Logging

To disable automatic HTTP request and response logging from Pino (useful during development when you want to reduce log noise):

```bash
# Disable HTTP request/response logging
LOG_ENABLE_HTTP_LOGGER=false

# Enable HTTP request/response logging
LOG_ENABLE_HTTP_LOGGER=true
```

**Note:** This controls the built-in HTTP logging from the Pino HTTP logger. Session-specific logging is controlled separately.

### Tenant Activity Audit Logs

Tenant activity logs are stored in the `tenant_action_log` table and exposed via `GET /api/admin/audit-logs` (tenant-scoped). These entries are separate from session flow logs (`session_log_entry`) and are used for configuration/admin change history (tenant/config create/update/delete events).

Retention is managed by `AuditLogService` with a daily cleanup job (03:00):

```bash
# Time-based retention (days). 0 disables time-based pruning.
AUDIT_LOG_RETENTION_DAYS=90

# Count-based retention per tenant. 0 disables count-based pruning.
AUDIT_LOG_MAX_ENTRIES_PER_TENANT=5000
```

How pruning works:

1. If `AUDIT_LOG_RETENTION_DAYS > 0`, entries older than that threshold are deleted.
2. If `AUDIT_LOG_MAX_ENTRIES_PER_TENANT > 0`, only the newest N entries are kept per tenant.

Recommended setup:

1. Development: keep both values at `0` unless you need to test cleanup behavior.
2. Production: enable at least one guardrail (time-based or count-based).
3. High-volume tenants: configure both values to bound storage growth.

## Development Scenarios

### Debugging Authentication Issues

```bash
LOG_LEVEL=debug
LOG_ENABLE_SESSION_LOGGER=true
LOG_ENABLE_HTTP_LOGGER=false
```

This will show detailed debug logs but hide HTTP request noise.

### Monitoring Session Flows

```bash
LOG_LEVEL=info
LOG_ENABLE_SESSION_LOGGER=true
LOG_ENABLE_HTTP_LOGGER=false
```

This will show all session flow events for monitoring credential issuance and verification, but without HTTP request logs.

### Full Development Logging

```bash
LOG_LEVEL=debug
LOG_ENABLE_SESSION_LOGGER=true
LOG_ENABLE_HTTP_LOGGER=true
```

This will show everything including HTTP requests, responses, and session flows.

### Production Monitoring

```bash
LOG_LEVEL=warn
LOG_ENABLE_SESSION_LOGGER=true
LOG_ENABLE_HTTP_LOGGER=false
LOG_TO_FILE=true
LOG_FILE_PATH=/var/log/eudiplo/session.log
```

This will only show warnings, errors, and important session events without HTTP noise, and write all logs to a file for later analysis.

## Session Log Structure

Session flow logs are persisted to the database when `LOG_SESSION_STORE` is enabled. Debug/observability logs are exported to Loki via OpenTelemetry and include trace correlation:

```json
{
    "level": "info",
    "time": "2025-07-20T10:30:45.123Z",
    "context": "SessionLoggerService",
    "sessionId": "session_123",
    "tenantId": "tenant_456",
    "flowType": "OID4VCI",
    "event": "flow_start",
    "stage": "initialization",
    "msg": "[OID4VCI] Flow started for session session_123 in tenant tenant_456"
}
```

## Environment Configuration

Add these to your `.env` file:

```bash
# Basic logging
LOG_LEVEL=info

# Logging destinations
LOG_TO_FILE=false
LOG_FILE_PATH=./logs/session.log

# HTTP request/response logging control
LOG_ENABLE_HTTP_LOGGER=false

# Session logger control
LOG_ENABLE_SESSION_LOGGER=true

# Persist session logs to the database (off | errors | all)
LOG_SESSION_STORE=off
```

## Runtime Control

You can control logging at runtime by restarting the service with different environment variables, or by implementing log level changes via API endpoints if needed.
