---
title: Revoke and suspend credentials
sidebar_label: Revocation
---

Revoke or suspend credentials you issued, using Token Status Lists ([draft-ietf-oauth-status-list](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/)). EUDIPLO assigns every credential an entry in a signed status list that verifiers fetch; you change entries per issuance session. For an end-to-end walkthrough, see the [revocable credentials cookbook](../cookbooks/revocable-credentials.md).

**Prerequisites:** a [credential configuration](credential-configuration.md) and a client with the `issuance:manage` role (configuration) and `issuance:offer` (revocation).

## 1. Enable status management

Set `statusManagement: true` on the credential configuration. Every credential issued afterwards carries a status reference:

```json
{
    "status": {
        "status_list": {
            "idx": 4711,
            "uri": "https://eudiplo.example.com/issuers/membership-demo/status-management/status-list/3f1c…"
        }
    }
}
```

SD-JWT VCs carry it as the `status` claim, mDOCs in the Mobile Security Object. Credentials issued before you enabled the setting have no status entry and cannot be revoked.

:::warning[Suspension needs 2 bits per entry]
Status lists use 1 bit per entry by default (`STATUS_BITS=1`), which only distinguishes valid and revoked. Suspending a credential on such a list is rejected with `400`. If you want to suspend credentials, set `bits` to `2` or more in the tenant's status list settings (or `STATUS_BITS`) **before** issuing. The `bits` of an existing list cannot be changed.
:::

## 2. Revoke or suspend

Use the session ID returned when you [created the offer](credential-offers.md):

```bash
curl -X POST "$EUDIPLO_URL/api/session/revoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "a6318799-dff4-4b60-9d1d-58703611bd23",
    "credentialConfigurationId": "membership",
    "status": 1
  }'
```

| Field | Required | Description |
| --- | --- | --- |
| `sessionId` | yes | Issuance session that issued the credentials. |
| `credentialConfigurationId` | no | Restrict the change to one credential type. Without it, all credentials of the session change. |
| `status` | yes | `0` = valid, `1` = revoked, `2` = suspended. |

- The call answers `204 No Content`. It updates every credential of the session and type, including all credentials of a batch; without `credentialConfigurationId` it updates all credentials of the session. If the session has no status entry for the type, it answers `409`. A value that does not fit a list's bits per entry (for example `2` on a 1-bit list) is rejected with `400` before anything is changed.
- Allowed roles: `issuance:offer` or `issuance:manage`.
- Revocation is final: setting `0` or `2` on a revoked credential is rejected with `409`, and nothing is changed. A suspension can be lifted (`0`) or turned into a revocation (`1`).

In the web client, open the session under **All Sessions**. The **Credential Status** card lists the credentials of the session per credential type and offers **Revoke**, **Suspend** and **Reinstate** where the change is allowed; Suspend only appears when every list of that type has at least 2 bits per entry.

## 3. Check the result

Read the current status of a session's credentials:

```bash
curl "$EUDIPLO_URL/api/session/a6318799-dff4-4b60-9d1d-58703611bd23/credential-status" \
  -H "Authorization: Bearer $TOKEN"
```

```json
[
  {
    "credentialConfigurationId": "membership",
    "statusListId": "8f1c…",
    "index": 42,
    "status": 1,
    "bits": 2
  }
]
```

There is one entry per issued credential that carries a status, so a batch issuance returns several entries for the same type. The list is empty when no credential of the session carries a status. Allowed roles: `issuance:offer` or `issuance:manage`.

Verifiers resolve `status_list.uri` and read the bit at `idx`. Status list tokens are cached:

- By default a token is re-signed only after its `ttl` has passed (`STATUS_TTL`, 3600 seconds). A change becomes visible to verifiers within that time.
- With `immediateUpdate: true` (tenant setting or `STATUS_IMMEDIATE_UPDATE`), EUDIPLO re-signs the list after every change.

Verifiers may cache the token themselves until its `exp`.

## Public endpoints

These endpoints are wallet- and verifier-facing and have no `/api` prefix.

| Endpoint | Response |
| --- | --- |
| `GET /issuers/{tenant}/status-management/status-list/{listId}` | Status list token. JWT (`application/statuslist+jwt`) by default; CWT (`application/statuslist+cwt`) when the `Accept` header contains `application/statuslist+cwt`. |
| `GET /issuers/{tenant}/status-management/status-list-aggregation` | `{"status_lists": ["<uri>", …]}` with all lists of the tenant. |

The JWT has `typ: statuslist+jwt` and the signing certificate in `x5c`; its payload contains `sub` (the list URI), `iat`, `exp` (`iat` + `ttl`), `ttl` and `status_list` (`bits`, compressed `lst`). With aggregation enabled (`STATUS_ENABLE_AGGREGATION`, default `true`), tokens include `aggregation_uri` and the authorization server metadata advertises `status_list_aggregation_endpoint`.

## Manage status lists

EUDIPLO allocates entries automatically: first from lists bound to the credential configuration, then from shared lists, and when all are full it creates a new shared list. Indices are assigned in random order. You only need the management API to pre-create, bind or re-key lists. All endpoints require `issuance:manage`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status-lists`, `GET /api/status-lists/{listId}` | List status lists with `bits`, `capacity`, `usedEntries`, `availableEntries`, `uri` and token `expiresAt`. |
| `POST /api/status-lists` | Create a list: `credentialConfigurationId` (bind it to one type; omit for a shared list), `keyChainId` (signing key; default: the tenant's status list key, else its attestation key), `bits` (1, 2, 4 or 8), `capacity` (1000 to 1,000,000). |
| `PATCH /api/status-lists/{listId}` | Change `credentialConfigurationId` or `keyChainId` (`null` resets to shared or default). `bits` and `capacity` are fixed. |
| `DELETE /api/status-lists/{listId}` | Delete an unused list. Lists with entries answer `409`. |
| `GET`, `PUT`, `DELETE /api/status-list-config` | Tenant defaults: `capacity` (minimum 100), `bits`, `ttl` (minimum 60 seconds), `immediateUpdate`, `enableAggregation`. `PUT` replaces the whole object; omitted fields fall back to the environment defaults. `DELETE` resets to them. |

The environment defaults are `STATUS_CAPACITY` (10000), `STATUS_BITS` (1), `STATUS_TTL` (3600), `STATUS_IMMEDIATE_UPDATE` (`false`) and `STATUS_ENABLE_AGGREGATION` (`true`); see [Environment variables](../reference/environment-variables.md#status). `capacity` and `bits` apply to lists created afterwards. Status lists can also be managed as files; see [Configuration as code](../operate/configuration-as-code.md). In the web client, open **Status Lists**.

To keep only one valid credential per person, combine status management with [`activeCredentials`](credential-configuration.md#keep-one-active-credential-per-subject).
