---
title: Trust Lists
---

import SchemaReference from "@site/src/components/SchemaReference";

A trust list names the issuers you accept. EUDIPLO uses Lists of Trusted Entities (LoTE, ETSI TS 119 602) as signed JWTs: it publishes lists you manage and reads lists published by others. ETSI TS 119 612 XML trusted lists are not supported. For a complete walkthrough, follow [chapter 3 of the cookbook](../cookbooks/first-presentation.md), which publishes a trust list and verifies against it, and [Accept only trusted issuers](../cookbooks/trusted-issuers.md), which tests an untrusted issuer and an external list.

## How a trust list is used

Each trusted entity has an issuance certificate and a revocation certificate that signs its status lists. Lists you manage in EUDIPLO always include both; lists published by others may omit the revocation certificate. A service whose `ServiceStatus` withdraws it (`http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn` or `http://uri.etsi.org/19602/commons/schemeApprovalWithdrawn`) is ignored in every list, also in wallet-provider lists. A list without a valid `NextUpdate`, or whose `NextUpdate` has passed, is discarded as expired (ETSI TS 119 602 §6.3.15), in every position and also as a wallet-provider list; a closed list, whose `NextUpdate` is null, too. By then its publisher has issued a newer list, and an older one, though validly signed, may still name an issuer that the newer list removed or withdrew. For the same reason, a list numbered lower (`LoTESequenceNumber`) than one EUDIPLO already accepted from the same URL is discarded, even while its `NextUpdate` is ahead, and so is a list without a valid `LoTESequenceNumber` ([Older versions of a list](#older-versions-of-a-list)). The issuers of a discarded list are not trusted, while the other lists referenced with it still count. The log names each discarded list with its `NextUpdate` or its sequence number (`Discarded outdated trust list(s) ...`). Only when every list referenced together is discarded does the check fail as if no list could be loaded. When a credential is presented, EUDIPLO:

1. loads every list of the credential query's `etsi_tl` entry, checks its signature and discards it if it is outdated or older than a list accepted before,
2. builds a certificate path from the credential's `x5c` chain to a certificate listed as a PID, Pub-EAA or EAA issuance service (`http://uri.etsi.org/19602/SvcType/PID/Issuance`, `.../PubEAA/Issuance` or `.../EAA/Issuance`). Other service types are ignored for credentials: a credential under the `.../WalletSolution/Issuance` or `.../WRPAC/Issuance` certificate of an entity is rejected, even when the same entity is also listed as a PID provider,
3. if status checks are enabled, requires the status list of the credential (SD-JWT VC or mDOC) to be signed under a revocation certificate of the **same** entity whose type belongs to the matched issuance service: `.../PID/Revocation` for `.../PID/Issuance`, `.../PubEAA/Revocation` for `.../PubEAA/Issuance` and `.../EAA/Revocation` for `.../EAA/Issuance`. If the entity lists no revocation service of that type, its `.../EAA/Revocation` services count instead. The status list must be signed below that certificate if it is a CA, or with it if it is an end-entity certificate. An entity listed without such a revocation certificate must sign its status lists under the certificate the credential matched, in the same way. A status list signed by any other key rejects the credential, also one under a revocation certificate of the same entity for another service, such as `.../WalletSolution/Revocation`. The chain comes from the status list's `x5c` header (SD-JWT VC) or `x5chain` (mDOC).

A listed CA certificate accepts every credential issued below it; a listed end-entity certificate only accepts credentials signed with exactly that certificate. Wallet-provider lists, used to trust wallet and key attestations during issuance, are described in [Wallet and Key Attestation](attestation.md).

### Older versions of a list

`NextUpdate` only limits how long an older version of a list stays usable: served again before its `NextUpdate` has passed, a validly signed older list would still name an issuer that the newer list removed or withdrew. EUDIPLO therefore also reads the list's `LoTESequenceNumber`, which its publisher raises with every list it issues and never lowers (ETSI TS 119 602 §6.3.2). This applies to every list, also to wallet-provider lists:

- For each tenant and list URL, EUDIPLO remembers the highest number of a list it accepted. The numbers are kept in the database, so they hold after a restart and for every instance.
- A list numbered lower is discarded like an outdated list, and so is a list whose `LoTESequenceNumber` is missing or not a whole number from 1. The log names the numbers, for example `Discarded outdated trust list(s), using the current lists: https://trust.example.org/lists/pid.jwt (LoTESequenceNumber 3 is lower than 5 accepted before) ...`. A list with the same number as before is accepted.
- A managed list of this EUDIPLO instance, referenced by `trustListId` or by a URL below `PUBLIC_URL` or `INTERNAL_URL` such as `<TENANT_URL>/trust-list/<id>`, is compared with the number it has in storage instead, and nothing is remembered for it: that number is always the current one, also for a list that was deleted and created again, which starts at 1.

A publisher that numbers its list from 1 again breaks this rule, and the list stays discarded until its number is higher than the one remembered. Another EUDIPLO instance does this when one of its managed lists is created anew: deleted and created again, dropped by a `replace` import and added back later, or imported into an empty database. To accept such a list, call `DELETE /api/cache/trust-list/sequence-numbers` (role `issuance:manage` or `presentation:manage`): it forgets the numbers of your tenant and clears your tenant's trust list cache. The next list fetched from each URL then sets its number again, whichever version it is, so only do this once the publisher has confirmed the new numbering. Deleting a tenant deletes its numbers.

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
            "info": {
                "name": "Example Club",
                "country": "DE",
                "contactUri": "info@club.example",
                "website": "https://club.example/"
            }
        },
        {
            "type": "external",
            "issuerCertPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
            "revocationCertPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
            "info": {
                "name": "Partner Club",
                "contactUri": "mailto:office@partner.example",
                "website": "https://partner.example/",
                "phone": "+49-30-1234567"
            }
        }
    ]
}
```

- **Internal** entities reference key chains of this tenant. EUDIPLO lists the last certificate of each chain, the root CA for internal and external CA chains, so the entry survives key rotation. `issuerKeyChainId` must name a key chain with usage type `attestation`, and `revocationKeyChainId` one with `statusList` or `attestation`, since [status lists](../issuance/revocation.md#manage-status-lists) are signed with the attestation key chain when they are pinned to it or the tenant has no status list key chain. Otherwise `POST` and `PUT` answer `400`, with an entry per field in `errors` (`path` `["entities", <index>, "issuerKeyChainId"]` or `revocationKeyChainId`), and a [configuration bundle or config folder](../operate/configuration-as-code.md#plan-and-import) is blocked with `KEY_CHAIN_USAGE_MISMATCH`. A key chain that the stored list already names in that field is still accepted, so lists saved before 10.0 can be updated: the plan only warns about it, as it does for a list the import skips, for example a detached one. EUDIPLO checks only the usage type: name the key chains that sign the issuer's credentials and its status lists, as wallets and verifiers check signatures against these certificates. A status list that is not pinned is signed by one of the tenant's `statusList` key chains, else by one of its `attestation` key chains, without a defined order; with several key chains of that usage type, pin the issuer's status lists (`keyChainId`) to the key chain named in `revocationKeyChainId`. In the Web Client, the **Issuer Key Chain** select offers `attestation` key chains, and the **Revocation Key Chain** select offers `statusList` key chains and, after them, `attestation` ones, with a hint on which status lists an `attestation` key chain signs. Both selects mark a stored key chain of another usage type, or one that no longer exists.
- **External** entities carry the certificates of issuers outside this tenant, as PEM or Base64 DER.
- `info` describes the entity in the published list, as ETSI TS 119 602 requires: `country` is an ISO 3166-1 alpha-2 code in capital letters (clause 6.1.5), with `UK` for the United Kingdom, `EL` for Greece and `EU` for the European Union, and defaults to `EU`; `lang` is an IETF RFC 5646 language tag in lower case (clause 6.1.4), for example `en` or `de-at`, and defaults to `en`, for the entity's name, postal address, electronic address and information URI. With another language, for example `de-at`, the list publishes these texts in that language and again under `en` with the same text, since every list supports English (clause 6.1.4); give the name in a form English readers recognize, such as the legal name. Service names are English labels and are published under `en` only. `uri` is an absolute URI written as a URL parser serializes it, for example with spaces percent-encoded. `contactUri` and `website` are required, because clause 6.5.3.2 makes an e-mail address and a web site mandatory in the entity's `TEElectronicAddress`: `contactUri` is one e-mail address in ASCII characters, bare (`info@example.com`) or as a `mailto:` URI, published as `mailto:info@example.com`; `website` is an absolute `http` or `https` URI in serialized form, for example `https://example.com/`; the optional `phone` is a number in international form without spaces, for example `+49-30-1234567` or `tel:+49-30-1234567`, published as a `tel:` URI. All three are published per language like the other texts. `uri` is published separately, as `TEInformationURI`. Other values, such as `country` `de`, `GB` or `Germany` or `lang` `EN`, answer `400` with an entry at `["entities", <index>, "info", <field>]` in `errors`, and the [plan](../operate/configuration-as-code.md#plan-and-import) of a configuration bundle or config folder blocks the document; a missing `contactUri` or `website` answers the same way. Trust list files of format v1 (9.x) have no `website` field, so their upgrade on import always stops with the required input `TRUST_LIST_WEBSITE_MISSING` per entity: change `$schema` to `https://eudiplo.dev/schemas/v2/TrustListConfigFile.schema.json`, add `website` and fix the other values the upgrade names: `TRUST_LIST_CONTACT_URI_MISSING` or `TRUST_LIST_CONTACT_URI_INVALID` for the e-mail address, `TRUST_LIST_COUNTRY_INVALID` or `TRUST_LIST_LANGUAGE_INVALID`, whose message names the value to write when only the case or `GB`/`GR` is wrong (for example `UK` for `gb`), or `TRUST_LIST_URI_INVALID`. The list carries `ListIssueDateTime` and `NextUpdate` in whole UTC seconds, for example `2026-11-06T12:00:00Z` (clause 6.1.3).
- The list is signed with the `trustList` key chain in `keyChainId`. Without `keyChainId`, a new list uses a `trustList` key chain of the tenant, so create one first ([Keys and Certificates](keys-and-certificates.md)), and an update keeps the key chain the list is signed with. That key chain must still have usage type `trustList`: if a key chain import with its ID gave it another usage type, the update fails until it names a `trustList` key chain in `keyChainId`. The API answers `409`. In the Web Client, **Any trust list key chain of the tenant** (create) and **Keep the current key chain** (edit) leave `keyChainId` out; the form does not save while the signing key chain it names or keeps is gone or lacks usage type `trustList`, or while a new list has no `trustList` key chain to use. When the tenant has none, it links to create one. The [plan](../operate/configuration-as-code.md#plan-and-import) of a configuration bundle or config folder blocks a `TrustList` document that would change such a list, or that names a key chain without usage type `trustList` in `keyChainId`, with `KEY_CHAIN_USAGE_MISMATCH`, so the import applies nothing; a startup import skips the tenant and logs the issue. The plan takes the usage type from a `KeyChain` document of the same bundle that the import writes, else from the stored key chain. A document that leaves the list unchanged gets the issue only as a warning, as the import does not write the list; it shows in a bundle plan (`eudiplo config plan` or **Plan and validate** in the Web Client), not in the startup log.

`POST` and `PUT` check the whole body before they sign the list and answer `400` with an entry per refused field in `errors`, each with `path`, `code` and `message`. `path` is an array, for example `["keyChainId"]` or `["entities", 0, "issuerKeyChainId"]`. Entries at `info` itself follow only once no other field is refused. `country`, `lang`, `uri`, `contactUri`, `website` and `phone` that do not fit (see above) are refused earlier by the body schema, also with `400` at their path:

| `code`                     | Field                                                                       | Refused value                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `key_chain_not_found`      | `keyChainId`, `entities.<index>.issuerKeyChainId` or `revocationKeyChainId` | a key chain the tenant does not have                                                                              |
| `key_chain_usage_mismatch` | the same fields                                                             | a key chain of another usage type, as described above                                                             |
| `invalid_certificate`      | `entities.<index>.issuerCertPem` or `revocationCertPem`                     | no X.509 certificate in PEM or Base64 DER                                                                         |
| `invalid_entity_info`      | `entities.<index>.info`                                                     | values the LoTE format does not take that the body schema let through                                             |

`409` remains for a save that the stored state blocks: a `POST` without `keyChainId` when the tenant has no `trustList` key chain or the one EUDIPLO picks has no valid certificate, an update without `keyChainId` whose kept key chain lost usage type `trustList`, and an update that another update or a renewal overtook; name a `trustList` key chain in `keyChainId` for the first two. `PUT /api/trust-list/{id}`, `GET /api/trust-list/{id}`, `GET /api/trust-list/{id}/export`, `GET /api/trust-list/{id}/versions` and `GET /api/trust-list/{id}/versions/{versionId}` answer `404` for a list or version the tenant does not have.

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

A managed list is valid for 30 days (`NextUpdate`). EUDIPLO renews it automatically in the last 10 days: it re-signs the unchanged entities with the next sequence number and a new `NextUpdate`, and keeps the previous version in the history. A renewal signs with the key chain the list is signed with, even one that no longer has usage type `trustList`; only an update refuses that key chain. The check runs every hour and at startup, so lists that expired while EUDIPLO was stopped are renewed when it starts. A managed list is checked like any other list when it is used: if its renewal keeps failing until its `NextUpdate` (the log shows `Failed to renew trust list ...`), it is discarded, and credentials and wallet and key attestations that only it covers are rejected.

Renewals and updates never publish the same sequence number twice. If a renewal or another update was published between reading and writing, `PUT` fails with `409`; read the list again and retry. An import updates an existing list in the same way, with the next sequence number, or leaves it unchanged. A list that is created anew (deleted and created again, dropped by a `replace` import and added back later, or imported into an empty database) starts again at sequence number 1, so verifiers outside this instance that remember a higher number discard it ([Older versions of a list](#older-versions-of-a-list)).

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

Wallets match credentials by key identifier, without fetching the list. EUDIPLO therefore replaces each `etsi_tl` entry in the request with an `aki` entry whose values are the base64url-encoded key identifiers of the listed PID, Pub-EAA and EAA issuance certificates: the Subject Key Identifier of every certificate, plus the Authority Key Identifier of end-entity certificates. If a list cannot be loaded, or an issuer certificate has no usable identifier (for example a self-signed certificate without Authority Key Identifier), the request additionally keeps an `etsi_tl` entry with the plain URL of that list. An outdated list is left out like in verification; only when every list of the entry is outdated are their URLs sent this way. Verification always uses the stored configuration.

Some wallets do not handle `trusted_authorities` yet. `VP_REMOVE_TA=true` removes it from all requests sent to wallets; EUDIPLO still verifies against the configured lists.

### Caching

Loaded trust lists are cached for five minutes, but not past the earliest `NextUpdate` of the lists loaded together: then they are fetched again. An outdated list next to current ones is fetched again with them when the cache expires; when all lists loaded together are outdated, they are not fetched again for one minute. A managed list of this instance is fetched again as soon as it has a new sequence number, after an update or a renewal. After changing another list, clear the cache with `DELETE /api/cache/trust-list` (it also clears the OpenID Federation cache, but keeps the [sequence numbers](#older-versions-of-a-list) accepted before) to use it immediately; `GET /api/cache/stats` shows the cached status lists. With `issuance:manage` or `presentation:manage`, `GET /api/cache/stats` shows only the status lists your tenant used, and the `DELETE` endpoints clear only your tenant's trust lists and the status lists and [OpenID Federation resolutions](federation.md#caching) it used. Status lists and resolutions are shared, so another tenant that uses one you cleared fetches it again too. With `tenants:manage`, they cover all tenants. Fetching a list times out after four seconds. Outside `NODE_ENV=production`, the TLS certificate of the list's host is not checked; the list signature always is. Lists outside EUDIPLO's own `PUBLIC_URL` and `INTERNAL_URL` must pass the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS and public addresses only, unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set. The same applies to the status lists named in presented credentials and wallet attestations. EUDIPLO caches a status list for its `ttl`, five minutes without one, at most one hour and not past its `exp`; `DELETE /api/cache/status-list` clears the status lists your tenant used.
