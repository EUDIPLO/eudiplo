---
title: Trust Lists
---

import SchemaReference from "@site/src/components/SchemaReference";

A trust list names the issuers you accept. EUDIPLO uses Lists of Trusted Entities (LoTE, ETSI TS 119 602) as signed JWTs: it publishes lists you manage and reads lists published by others. ETSI TS 119 612 XML trusted lists are not supported. For a complete walkthrough, follow [chapter 3 of the cookbook](../cookbooks/first-presentation.md), which publishes a trust list and verifies against it, and [Accept only trusted issuers](../cookbooks/trusted-issuers.md), which tests an untrusted issuer and an external list.

## How a trust list is used

Each trusted entity has an issuance certificate and a revocation certificate that signs its status lists. Lists you manage in EUDIPLO always include both; lists published by others may omit the revocation certificate. When a credential is presented, EUDIPLO:

1. loads the lists referenced in the credential query and checks their signature and `NextUpdate`,
2. builds a certificate path from the credential's `x5c` chain to a listed issuance certificate,
3. requires the matching entity to be listed with a PID or EAA issuance service (`http://uri.etsi.org/19602/SvcType/PID/Issuance` or `.../EAA/Issuance`); other service types are ignored for credentials,
4. if status checks are enabled, requires the status list of an SD-JWT VC credential to carry an `x5c` chain to a revocation certificate (a `.../Revocation` service) of the **same** entity: below that certificate if it is a CA, or signed with it if it is an end-entity certificate. An entity listed without a revocation certificate must sign its status lists under the certificate the credential matched in the same way. A status list signed by any other key rejects the credential. The status list of an mDOC credential must be signed under a revocation certificate of any entity in the list, or under a listed issuance certificate if the list has no revocation certificates.

A listed CA certificate accepts every credential issued below it; a listed end-entity certificate only accepts credentials signed with exactly that certificate. Wallet-provider lists, used to trust wallet and key attestations during issuance, are described in [Wallet and Key Attestation](attestation.md).

## Publish a managed trust list

Create the list in the Web Client under **Cryptographic Assets → Trust Lists**, or with `POST /api/trust-list` (role `issuance:manage` or `presentation:manage`):

```json
{
    "id": "membership-issuers",
    "description": "Issuers of membership credentials",
    "entities": [
        {
            "type": "internal",
            "issuerKeyChainId": "<attestation key chain id>",
            "revocationKeyChainId": "<status list key chain id>",
            "info": { "name": "Example Club", "country": "DE" }
        },
        {
            "type": "external",
            "issuerCertPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
            "revocationCertPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
            "info": { "name": "Partner Club" }
        }
    ]
}
```

- **Internal** entities reference key chains of this tenant. EUDIPLO lists the last certificate of each chain, the root CA for internal and external CA chains, so the entry survives key rotation. `issuerKeyChainId` must name a key chain with usage type `attestation`, and `revocationKeyChainId` one with `statusList` or `attestation`, since [status lists](../issuance/revocation.md#manage-status-lists) are signed with the attestation key chain when they are pinned to it or the tenant has no status list key chain. Otherwise `POST` and `PUT` answer `400`, with an entry per field in `errors` (`path` `["entities", <index>, "issuerKeyChainId"]` or `revocationKeyChainId`), and a [configuration bundle or config folder](../operate/configuration-as-code.md#plan-and-import) is blocked with `KEY_CHAIN_USAGE_MISMATCH`. A key chain that the stored list already names in that field is still accepted, so lists saved before 10.0 can be updated: the plan only warns about it, as it does for a list the import skips, for example a detached one. EUDIPLO checks only the usage type: name the key chains that sign the issuer's credentials and its status lists, as wallets and verifiers check signatures against these certificates.
- **External** entities carry the certificates of issuers outside this tenant, as PEM or Base64 DER.
- The list is signed with the `trustList` key chain in `keyChainId`, or with a `trustList` key chain of the tenant if omitted; create one first ([Keys and Certificates](keys-and-certificates.md)).

EUDIPLO publishes the signed JWT at `GET /issuers/{tenantId}/trust-list/{id}` without authentication, so others can use your list.

| Task                       | Endpoint                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Replace entities           | `PUT /api/trust-list/{id}` with the complete body; publishes the next sequence number            |
| Version history            | `GET /api/trust-list/{id}/versions`, `GET /api/trust-list/{id}/versions/{versionId}`             |
| List, read, export, delete | `GET /api/trust-list`, `GET /api/trust-list/{id}`, `GET /api/trust-list/{id}/export`, `DELETE /api/trust-list/{id}` |

`DELETE` refuses a list that configurations still use ([Delete a trust list](#delete-a-trust-list)). In the Web Client, the page of a list shows the credential configurations (with `issuance:manage`) and the presentation configurations (with `presentation:manage` or `presentation:request`) that reference it, and the delete button (**Delete list**) says so instead of sending the request. The page does not show `walletProviderTrustLists` of the issuance configuration; check those as described in [Wallet and Key Attestation](attestation.md#1-provide-wallet-provider-trust-lists).

To manage lists as files, put the same JSON into `config/<tenant>/trust-lists/` ([Configuration as Code](../operate/configuration-as-code.md)). `GET /api/trust-list/{id}/export` returns a list in this format; **Download configuration** in the Web Client saves it as a document with `$schema` and `spec` ([single resources](../reference/config-bundle-format.md#single-resources)).

### Delete a trust list

`DELETE /api/trust-list/{id}` answers `409` while a configuration of the tenant still references the list, because that configuration would fail without it. The response names the configurations in `message` and lists them in `references`. Configurations the caller's roles cannot read are only counted, without ID and description: credential configs and the issuance configuration need `issuance:manage`, presentation configs `presentation:manage` or `presentation:request`.

```json
{
    "statusCode": 409,
    "timestamp": "2026-10-11T12:00:00.000Z",
    "path": "/api/trust-list/membership-issuers",
    "code": "TRUST_LIST_IN_USE",
    "message": "Trust list \"membership-issuers\" is still referenced by 1 presentation config (\"membership-check\") and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.",
    "references": [
        { "kind": "PresentationConfig", "id": "membership-check", "description": "Verify a membership name and ID" },
        { "kind": "IssuanceConfig" }
    ]
}
```

These entries count as a reference. "The list URL" is `<TENANT_URL>/trust-list/<id>` or any URL that ends in `/issuers/<tenant>/trust-list/<id>` with the list's own tenant; a trailing slash, a query or a fragment is ignored:

- an `etsi_tl` entry in the `trusted_authorities` of a presentation config, by `trustListId` or `url`,
- an entry of `schemaMeta.trustedAuthorities` in a credential config, by `trustListId`, or with `frameworkType: "etsi_tl"` by a `value` that is the list URL or the bare list ID,
- an entry of `walletProviderTrustLists` in the issuance configuration, shared or of an authorization server, by `trustListId` or `url`.

Remove these references, or point them to another list, then delete the list. Deleting an unknown ID answers `204`. EUDIPLO does not see references from other tenants or other systems that fetch the list from its public URL.

A [configuration bundle](../operate/configuration-as-code.md#plan-and-import) or a [config folder](../operate/configuration-as-code.md#provision-tenants-from-a-folder) imported in `replace` mode (`CONFIG_IMPORT_MODE=replace` at startup) deletes a list that it created and no longer contains. Its plan is blocked with `TRUST_LIST_IN_USE` on that list while a configuration that survives the import references it by the rules above: a stored configuration the import neither deletes nor rewrites, or a document of the bundle with its new content. A document the plan skips, for example a detached one, counts with its stored content. The message names the configurations; a document of the bundle that names the list by `trustListId` is also blocked with `MISSING_RESOURCE_REFERENCE`. Keep the list in the bundle, or remove the references (in the bundle or through the API), then plan again.

### Validity and renewal

A managed list is valid for 30 days (`NextUpdate`). EUDIPLO renews it automatically in the last 10 days: it re-signs the unchanged entities with the next sequence number and a new `NextUpdate`, and keeps the previous version in the history. The check runs every hour and at startup, so lists that expired while EUDIPLO was stopped are renewed when it starts. Verifiers reject a list whose `NextUpdate` has passed (`trust_list_unavailable`).

Renewals and updates never publish the same sequence number twice. If a renewal or another update was published between reading and writing, `PUT` fails with `409`; read the list again and retry.

### Fields

<SchemaReference name="trust-list" mode="table" />

`data` is accepted but ignored; EUDIPLO builds the list content from `entities`.

## Use a trust list in a presentation

Reference trust lists in the `trusted_authorities` of a [DCQL](../presentation/dcql.md) credential query:

```json
{
    "trusted_authorities": [
        {
            "type": "etsi_tl",
            "values": [
                { "trustListId": "membership-issuers" },
                { "url": "https://trust.example.org/lists/pid.jwt", "verifierX509Der": "MIIB..." }
            ]
        }
    ]
}
```

- `trustListId` references a managed list of this tenant. EUDIPLO fetches it from `<INTERNAL_URL>/issuers/<tenant>/trust-list/<id>` and pins the certificate that signs it. `INTERNAL_URL` defaults to `http://127.0.0.1:<PORT>`; with `TLS_ENABLED=true` or a `PORT` that is not a number it has no default, and the list is fetched from `PUBLIC_URL`. Set `INTERNAL_URL` if the backend reaches itself at another address.
- `url` references an external LoTE JWT. `verifierX509Der` (base64 DER certificate) or `verifierKey` (public JWK) is required to check its signature; without them loading the list fails (`trust_list_unavailable`). `<TENANT_URL>` in the URL is replaced with `<PUBLIC_URL>/issuers/<tenant>`.
- Put several lists into the `values` of one `etsi_tl` entry: only the first `etsi_tl` entry of a credential query is used for verification.

Every credential query needs `trusted_authorities`; EUDIPLO rejects a presentation configuration without them. For development and interoperability tests, `SKIP_TRUST_AUTHORITY=true` allows such queries, which are then verified without any issuer check.

### What the wallet receives

Wallets match credentials by key identifier, without fetching the list. EUDIPLO therefore replaces each `etsi_tl` entry in the request with an `aki` entry whose values are the base64url-encoded key identifiers of the listed PID and EAA issuance certificates: the Subject Key Identifier of every certificate, plus the Authority Key Identifier of end-entity certificates. If a list cannot be loaded, or an issuer certificate has no usable identifier (for example a self-signed certificate without Authority Key Identifier), the request additionally keeps an `etsi_tl` entry with the plain URL of that list. Verification always uses the stored configuration.

Some wallets do not handle `trusted_authorities` yet. `VP_REMOVE_TA=true` removes it from all requests sent to wallets; EUDIPLO still verifies against the configured lists.

### Caching

Loaded trust lists are cached for five minutes. After changing a list, clear the cache with `DELETE /api/cache/trust-list` (it also clears the OpenID Federation cache) to use it immediately; `GET /api/cache/stats` shows what is cached. Fetching a list times out after four seconds. Outside `NODE_ENV=production`, the TLS certificate of the list's host is not checked; the list signature always is. Lists outside EUDIPLO's own `PUBLIC_URL` and `INTERNAL_URL` must pass the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS and public addresses only, unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set. The same applies to the status lists named in presented credentials and wallet attestations. EUDIPLO caches a status list for its `ttl`, five minutes without one, at most one hour and not past its `exp`; `DELETE /api/cache/status-list` clears the cached status lists.
