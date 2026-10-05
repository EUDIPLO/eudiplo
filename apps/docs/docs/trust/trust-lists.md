---
title: Trust Lists
---

import SchemaReference from "@site/src/components/SchemaReference";

A trust list names the issuers you accept. EUDIPLO uses Lists of Trusted Entities (LoTE, ETSI TS 119 602) as signed JWTs: it publishes lists you manage and reads lists published by others. ETSI TS 119 612 XML trusted lists are not supported. For a complete walkthrough, follow the [trusted issuers cookbook](../cookbooks/trusted-issuers.md).

## How a trust list is used

Each trusted entity has an issuance certificate and a revocation certificate. When a credential is presented, EUDIPLO:

1. loads the lists referenced in the credential query and checks their signature and `NextUpdate`,
2. builds a certificate path from the credential's `x5c` chain to a listed issuance certificate,
3. requires the matching entity to be listed with a PID or EAA issuance service (`http://uri.etsi.org/19602/SvcType/PID/Issuance` or `.../EAA/Issuance`); other service types are ignored for credentials,
4. if status checks are enabled, requires the credential's status list to be signed by the revocation certificate of the **same** entity.

A listed CA certificate accepts every credential issued below it; a listed end-entity certificate only accepts credentials signed with exactly that certificate. Wallet-provider lists, used to trust wallet and key attestations during issuance, are described in [Wallet and Key Attestation](attestation.md).

## Publish a managed trust list

Create the list in the Web Client under **Credential Issuance → Trust Lists**, or with `POST /api/trust-list` (role `issuance:manage` or `presentation:manage`):

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

- **Internal** entities reference key chains of this tenant. EUDIPLO lists the last certificate of each chain, the root CA for internal and external CA chains, so the entry survives key rotation.
- **External** entities carry the PEM certificates of issuers outside this tenant.
- The list is signed with the `trustList` key chain in `keyChainId`, or with a `trustList` key chain of the tenant if omitted; create one first ([Keys and Certificates](keys-and-certificates.md)).

EUDIPLO publishes the signed JWT at `GET /issuers/{tenantId}/trust-list/{id}` without authentication, so others can use your list.

| Task                       | Endpoint                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Replace entities           | `PUT /api/trust-list/{id}` with the complete body; publishes the next sequence number            |
| Version history            | `GET /api/trust-list/{id}/versions`, `GET /api/trust-list/{id}/versions/{versionId}`             |
| List, read, export, delete | `GET /api/trust-list`, `GET /api/trust-list/{id}`, `GET /api/trust-list/{id}/export`, `DELETE /api/trust-list/{id}` |

To manage lists as files, put the same JSON into `config/<tenant>/trust-lists/` ([Configuration as Code](../operate/configuration-as-code.md)).

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

- `trustListId` references a managed list of this tenant. EUDIPLO fetches it from `<INTERNAL_URL or PUBLIC_URL>/issuers/<tenant>/trust-list/<id>` and pins the certificate that signs it. Set `INTERNAL_URL` if the backend cannot reach its own `PUBLIC_URL`.
- `url` references an external LoTE JWT. `verifierX509Der` (base64 DER certificate) or `verifierKey` (public JWK) is required to check its signature; without them loading the list fails (`trust_list_unavailable`). `<TENANT_URL>` in the URL is replaced with `<PUBLIC_URL>/issuers/<tenant>`.
- Put several lists into the `values` of one `etsi_tl` entry: only the first `etsi_tl` entry of a credential query is used for verification.

A credential query without `trusted_authorities` is verified without any issuer check.

### What the wallet receives

Wallets match credentials by key identifier, without fetching the list. EUDIPLO therefore replaces each `etsi_tl` entry in the request with an `aki` entry whose values are the base64url-encoded key identifiers of the listed PID and EAA issuance certificates: the Subject Key Identifier of every certificate, plus the Authority Key Identifier of end-entity certificates. If a list cannot be loaded, or an issuer certificate has no usable identifier (for example a self-signed certificate without Authority Key Identifier), the request additionally keeps an `etsi_tl` entry with the plain URL of that list. Verification always uses the stored configuration.

Some wallets do not handle `trusted_authorities` yet. `VP_REMOVE_TA=true` removes it from all requests sent to wallets; EUDIPLO still verifies against the configured lists.

### Caching

Loaded trust lists are cached for five minutes. After changing a list, clear the cache with `DELETE /api/cache/trust-list` (it also clears the OpenID Federation cache) to use it immediately; `GET /api/cache/stats` shows what is cached. Fetching a list times out after four seconds. Outside `NODE_ENV=production`, the TLS certificate of the list's host is not checked; the list signature always is. Lists outside EUDIPLO's own `PUBLIC_URL` and `INTERNAL_URL` must pass the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS and public addresses only, unless `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set. The same applies to the status lists named in presented credentials and wallet attestations.
