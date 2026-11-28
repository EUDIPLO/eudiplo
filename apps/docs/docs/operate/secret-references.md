---
title: Secret References
---

# Secret References

Keep the API keys of webhook endpoints and attribute providers, the
upstream client secrets of chained authorization servers and the credentials
of KMS providers in a secret store
instead of in EUDIPLO's database. The value is then a reference such as
`${vault:kv/eudiplo/acme/shop#token}`, which EUDIPLO reads when it sends a
request and keeps only in memory.

Secret references are off until you set
[`SECRET_POLICY_FILE`](../reference/environment-variables.md#secret-references).
Without it, a value such as `${vault:…}` is an ordinary API key and is sent as
written, as in earlier versions.

## Where references are read

| Resource           | Field               | Read                                   |
| ------------------ | ------------------- | -------------------------------------- |
| Webhook endpoint   | `auth.config.value` | Each time a webhook is sent            |
| Attribute provider | `auth.config.value` | Each time claims are fetched           |
| Issuance configuration | `authorizationServers[].upstream.clientSecret` of a `chained` server | Each time an upstream code is exchanged at the token endpoint |
| Tenant and global `kms.json` | The credentials of a provider ([KMS](kms.md#secret-references-in-a-tenant-kmsjson)) | When the provider is used; a changed value rebuilds the provider |

The reference must be the whole value. A webhook defined in a session request
(an offer's `credentialClaims.<id>.webhook`, a presentation request's `webhook`)
cannot use a reference: the request is refused with `400`, because its API
client also chooses the URL. Configure a webhook endpoint or attribute provider
and refer to it by ID instead.

## Reference syntax

| Source | Reference                                     | Reads                                                        |
| ------ | --------------------------------------------- | ------------------------------------------------------------ |
| `env`  | `${env:SHOP_TOKEN}`                           | A variable of the backend's environment                       |
| `vault`| `${vault:kv/eudiplo/acme/shop#token}`         | Key `token` of the secret `eudiplo/acme/shop` in KV mount `kv` |
| `vault`| `${vault:kv/eudiplo/acme/shop#token@3}`       | The same key in version 3 (KV v2 only)                        |

The source is lowercase, which tells a reference apart from a `${VAR}`
placeholder of a configuration file. A reference has no default value. While
a policy is set, every value of these fields that has the form `${<source>:…}`
is read as a reference, also when a configuration file wrote it as `$${…}`; it
cannot be stored as a literal API key. A value written like that before the
policy was set is read as a reference from then on.

## The policy file

The policy file says which sources exist, what each tenant may name and, optionally, which variables the [placeholders of tenant folders](#placeholders-in-tenant-folders) may use. An
`instance` key next to `tenants` holds the grants of the global `kms.json`
([KMS](kms.md#secret-references-in-a-tenant-kmsjson)). EUDIPLO reads it once at startup and does not start when it is
invalid. It is not part of any tenant configuration and cannot be changed
through the API.

```json
{
    "sources": {
        "vault": {
            "address": "https://vault.example:8200",
            "auth": { "method": "approle" },
            "mounts": { "kv": { "version": 2 } }
        }
    },
    "tenants": {
        "*": { "vault": ["kv/eudiplo/{tenant}/"] },
        "acme": {
            "env": ["ACME_*"],
            "bound": [
                {
                    "ref": "${vault:kv/operator/crm#token}",
                    "fields": ["AttributeProvider:auth.config.value"],
                    "destinations": ["https://crm.example"]
                }
            ]
        }
    }
}
```

### Grants

A tenant's own grants are namespaces: everything inside is the tenant's, and
it may send those values to any URL the
[outbound URL policy](../reference/webhooks.md#delivery) allows. Put
only the tenant's own secrets there.

- `tenants.<id>` grants one tenant. `tenants.*` grants every tenant, and each
  of its `vault` grants must contain `{tenant}`, which stands for the tenant ID
  and must be a whole path segment.
- `vault` grants are a path prefix ending in `/`, a secret
  (`kv/eudiplo/acme/shop`) or one key (`kv/eudiplo/acme/shop#token`).
- `env` grants are a variable name or a prefix ending in `*` (`ACME_*`).
  `tenants.*` cannot have `env` grants, and no grant covers EUDIPLO's own
  settings or, for a tenant, the cloud credentials of the instance.
- `bound` lists operator secrets a tenant may use but not read: the reference
  is accepted only in the listed fields and only while the field's URL has one
  of the listed origins. Fields are written `<Kind>:<path>`, with `*` for any
  key or array index: `WebhookEndpoint:auth.config.value`,
  `AttributeProvider:auth.config.value`,
  `IssuanceConfig:authorizationServers.*.upstream.clientSecret`,
  `KmsConfig:providers.*.vaultToken`. The URL of an
  API key is the endpoint's or provider's `url`. An upstream client secret is
  checked for `upstream.issuer` when it is stored and, when it is sent, also
  for the token endpoint that the issuer's discovery document names: list the
  origins of both when they differ.

EUDIPLO refuses a policy in which two tenants' namespaces overlap, a tenant's
namespace reaches into the instance's, or a `bound` secret lies inside a
tenant's own namespace (the tenant could read it).

### Vault source

| Field             | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `address`         | The Vault server. Must use `https:` unless it is a loopback address or `allowHttp` is `true`. |
| `auth.method`     | `token` (reads `SECRET_VAULT_TOKEN`) or `approle` (reads `SECRET_VAULT_ROLE_ID` and `SECRET_VAULT_SECRET_ID`; optional `mount`, default `approle`) |
| `mounts`          | The KV mounts references may name, each with `version` `1` or `2`. Other mounts are never asked. |
| `namespace`       | Vault Enterprise namespace                                                  |
| `allowHttp`       | Allow `http:` for a host that is not a loopback address                     |

The credentials are environment variables, so the file holds no secret. Give
EUDIPLO's Vault token or AppRole read access to the granted paths only.

### Placeholders in tenant folders

By default, a `${VAR}` placeholder in a file of a tenant folder may name any
variable that is no setting of EUDIPLO and no cloud credential of the instance
([variables a file can use](../reference/config-bundle-format.md#variables-a-file-can-use)).
That deny-list cannot know your own secrets. With `templates.tenant`, the
files of every tenant folder may name only the variables you list:

```json
{
    "templates": { "tenant": ["PUBLIC_URL", "SHOP_*"] }
}
```

- An entry is a variable name or a prefix ending in `*`. A prefix never covers
  the cloud credentials of the instance (`AWS_SECRET_ACCESS_KEY` and the
  others in the table linked above); list one by name to allow it.
- Settings of EUDIPLO keep their own rules: `PUBLIC_URL` is always available,
  the others never, listed or not.
- A file that names a variable not on the list fails the import of its tenant,
  as any refused placeholder does; other tenants continue.
- It applies to the files of tenant folders read by the backend. The `kms.json`
  of a tenant keeps `KMS_TENANT_VARIABLES`, the global `kms.json` its own
  rules, and the CLI resolves placeholders of a folder it sends from its own
  environment (`--allow-env`).
- `templates` needs `tenant`; `["*"]` writes out the default rule.
- Without `templates`, the default above applies, as in earlier versions.
- A policy file set only for `templates` also turns secret references on:
  with no grants, every [reference](#reference-syntax) is then refused.

## When a value is read

- **Writing.** Creating or updating a webhook endpoint, an attribute provider,
  the authorization servers of the issuance configuration or a tenant
  `kms.json`, through the API, a bundle or a configuration folder, checks the
  reference against the policy without reading it. A bundle plan already
  reports a refused reference of a `kms.json` (`KMS_SETTING_REFUSED`). Through the API, a refused or
  malformed reference is answered with `400`; a bundle with one is refused when
  it is imported, not yet when it is planned; a configuration folder file with
  one is skipped and logged at startup, like any file that does not import,
  and the stored resource it would replace is kept. A `kms.json` of a folder
  is the operator's file and is not checked at startup: a refused reference in
  it fails when a key operation uses it
  ([KMS](kms.md#secret-references-in-a-tenant-kmsjson)).
  Changing only the `url` (or `upstream.issuer`) checks it again, so a bound
  reference cannot follow the resource to a new address.
- **Sending.** EUDIPLO checks the policy again and reads the value. Values are
  cached in memory for 5 minutes, so a rotated secret is used at the latest
  5 minutes later. While the source does not answer, the last value is used for
  up to 1 hour and a warning is logged; after that the request that needs it
  fails.
- **Failing.** When a value cannot be read, the webhook delivery fails with
  "the API key of the webhook could not be read", and the upstream login of a
  chained authorization server ends with `server_error` for the wallet, and a
  key operation of a KMS provider fails, with `409` or `503` through the key
  chain API ([KMS](kms.md#secret-references-in-a-tenant-kmsjson)). The log
  names the reference and the reason, never the value.

## What EUDIPLO shows

A reference is no secret. Responses of the webhook endpoint, attribute
provider, issuance configuration and tenant KMS configuration API show it as
written, and so do the audit log entries of the first three (the KMS
configuration is not audited); a literal API key stays
`<redacted>` in responses and `[REDACTED]` in the audit log, as does a
literal upstream client secret. A
[configuration export](configuration-as-code.md#export-a-tenant) still replaces
the value with a `${…}` placeholder, reference or not; set it again in the target. Sessions keep only the ID of a configured webhook endpoint, so
neither the reference nor the value is copied into session data.
