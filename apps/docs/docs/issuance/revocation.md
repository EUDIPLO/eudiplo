---
title: Status Management
---

EUDIPLO provides comprehensive status management for issued credentials through the OAuth Token Status List specification (RFC 9528). This allows issuers to revoke or suspend credentials without requiring direct communication with the credential holder.

## Overview

Status management enables credential lifecycle operations such as:

- **Revocation** — Permanently invalidate a credential
- **Suspension** — Temporarily disable a credential (can be reinstated)
- **Status verification** — Verifiers can check credential validity in real-time

Status lists are privacy-preserving: verifiers can check if a credential is valid without learning which specific credential is being checked (beyond the list index).

## Enabling Status on Credential Configurations

To enable status management for a credential, configure the `status` field in the credential configuration:

```json
{
    "id": "employee-badge",
    "description": "Employee Badge Credential",
    "config": {
        "format": "dc+sd-jwt"
        /* ... other config fields ... */
    },
    "status": {
        "enabled": true,
        "bits": 1,
        "credentialConfigurationBound": false
    }
}
```

### Status Configuration Fields

| Field                          | Type    | Required | Description                                                                                   |
| ------------------------------ | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `enabled`                      | boolean | Yes      | Enables status management for this credential type.                                           |
| `bits`                         | number  | No       | Bits per status entry (1, 2, 4, or 8). Default: 1. More bits allow more status values.        |
| `credentialConfigurationBound` | boolean | No       | If `true`, create dedicated status lists for this credential type. Default: `false` (shared). |

### Bits Per Status

The `bits` parameter determines how many distinct status values are possible:

| Bits | Values      | Use Case                            |
| ---- | ----------- | ----------------------------------- |
| 1    | 2 (0-1)     | Simple valid/revoked                |
| 2    | 4 (0-3)     | Valid, suspended, revoked, reserved |
| 4    | 16 (0-15)   | Multiple suspension reasons         |
| 8    | 256 (0-255) | Complex status workflows            |

### Binding to Credential Configurations

Status lists can be:

- **Shared** (default) — Used by any credential configuration in the tenant
- **Bound** — Exclusively used by a specific credential configuration

Set `credentialConfigurationBound: true` when:

- Different credential types have different revocation policies
- You want separate capacity management per credential type
- Compliance requires isolated status tracking

## Automatic Status List Management

When issuing a credential with status management enabled, EUDIPLO automatically:

1. Finds an available status list for the credential configuration
2. Creates a new **shared** status list if none have capacity
3. Assigns the next available index to the credential

:::note Capacity Exhaustion
When a shared status list runs out of available indexes, EUDIPLO automatically creates a new shared status list and continues issuance seamlessly. No manual intervention is required.

For bound lists, if a list reaches capacity, EUDIPLO falls back to using shared lists if available.
:::

## Revoking or Suspending Credentials

Use the Status Management API to update credential status:

```bash
PATCH /{tenant}/status-management/status-list/{listId}/entry/{index}
Content-Type: application/json

{
    "value": 1
}
```

**Status Values:**

- `0` — Valid
- `1` — Revoked (for 1-bit lists)

For lists with more than 1 bit:

- `0` — Valid
- `1` — Suspended
- `2` — Revoked
- `3+` — Custom states

See the [API Reference](../reference/api.md) for complete endpoint documentation.

## Status List Token Caching and TTL

EUDIPLO serves status list tokens as signed JWTs (or CWTs for mDoc) at a public endpoint:

```http
GET /{tenant}/status-management/status-list/{listId}
```

The token includes time-based claims for caching:

```json
{
    "iat": 1704067200,
    "exp": 1704070800,
    "ttl": 3600,
    "status_list": {/* ... */}
}
```

### Regeneration Modes

EUDIPLO supports two token regeneration strategies:

**Lazy Mode (Default):** The token is regenerated only when a verifier requests the status list AND the current token has expired.

**Immediate Mode:** When `immediateUpdate` is enabled in tenant status configuration, the token is regenerated immediately whenever a status entry changes.

Configure the default mode in [Tenant Settings](../operate/tenants-and-access.md) or via environment variables.

:::warning[Performance Consideration]
Immediate mode can impact performance with frequent status changes. Consider lazy mode with shorter TTLs for high-volume scenarios.
:::

## Verifier Integration

Verifiers check credential status by:

1. Extracting the `status` claim from the credential
2. Fetching the status list token from the URI in the `status` claim
3. Decompressing the status list payload
4. Checking the bit at the credential's `status_list.idx`

The status list token can be cached according to the `exp` and `ttl` claims.

## Web Client

The web client provides a user-friendly interface for status management:

### Status List Overview

Navigate to **Status Lists** to see all status lists with:

- Capacity and usage statistics
- JWT expiration status (Valid, Expiring, Expired)
- Bound credential configuration
- Certificate assignment

### Creating Status Lists

Click **Create** to manually create a status list with:

- Optional credential configuration binding
- Optional certificate pinning

### Configuration

Click **Settings** (⚙️) to configure tenant defaults:

- Default bits per status
- Default capacity
- TTL for JWT caching
- Immediate update mode

## Best Practices

1. **Use 1-bit lists for simple revocation** — Most use cases only need valid/revoked
2. **Set appropriate TTLs** — Shorter for high-security credentials (5-15 minutes), longer for low-change scenarios (24 hours)
3. **Monitor capacity** — The web client shows capacity usage; create new lists before reaching capacity
4. **Use binding sparingly** — Shared lists simplify management; only bind when needed for isolation
5. **Test with verifiers** — Ensure your verifiers correctly fetch and cache status lists

## Related Documentation

- [Credential Configuration](credential-configuration.md) — Enabling status on credential configs
- [OpenAPI Reference](../reference/api.md) — Status Management API endpoints
