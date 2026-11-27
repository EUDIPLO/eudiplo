---
title: Configure Verification
---

A presentation configuration is the reusable definition of a verification: which credentials and claims to request, how long a request is valid, and where results go. Create it once, then start a [presentation request](requests.md) for every verification. All fields are listed in the [presentation configuration reference](../reference/presentation-configuration.md).

## Prerequisites

- A tenant client or user with the `presentation:manage` role.
- An access key chain with an active certificate. EUDIPLO signs every request with it. See [Keys and Certificates](../trust/keys-and-certificates.md).
- A [trust list](../trust/trust-lists.md) or an [OpenID Federation](../trust/federation.md) trust anchor for the issuers you accept. Every credential query must reference one. A trust anchor must first be [registered with its keys](../trust/federation.md#register-trust-anchors), in the Web Client under **Cryptographic Assets → Federation Trust Anchors**, through the API or the config folder.
- Optional: a webhook endpoint that receives the results (see [below](#send-results-to-your-backend)).

## In the Web Client

Open **Credential Verification → Verification Configs** and choose **Create config**. The guided setup has four steps:

1. **Name**: a unique ID (the `requestId` you use later) and an internal description.
2. **Credentials**: **Import from Issuer** reads credential types and claims from an issuer's metadata, **Import from Credential Config** reads them from the credential configs your own tenant issues, so the query asks only for credentials and claims that exist (when there are none yet, it links to create one in a new tab; after the save that tab says to return, and **Reload** lists it), **Import from Schema** starts from TS11 schema metadata at a URL, **Templates** (when creating) starts from a predefined query, and **Add credential** lets you enter the type and claims yourself. An import replaces the whole query and a template all settings except ID and Description; the editor asks first when there is something to lose. To combine credentials, import first, then use **Add credential**.
3. **Settings**: review the request lifetime (default 300 seconds), the status check mode (default strict) and the access key chain (default: the tenant's access key chain). The same section, **Request and verification options**, holds the redirect URI and the [allowed origins](#allowed-origins-digital-credentials-api) for the Digital Credentials API; further sections hold the **Registration certificate**, the webhook endpoint (**Application integration**) and **Transaction data**.
4. **Review**: check the request and choose **Create Verification Config**. Use **New Verification** on the saved configuration to test it with a wallet.

**Switch to editor** shows all sections at once; existing configurations open in this mode. **Use guided setup** returns to the steps. Both modes edit the same form.

### Visual query builder and JSON

For SD-JWT VC, enter the credential type (VCT) and one field per claim path; use dots for nested paths such as `address.locality`, or paste a list of paths. For mDOC, enter the document type, namespace and element names. Type and paths must match the credential in the wallet, so importing them from the issuer avoids typos. While you type, the builder suggests the types and claims of your own credential configs and marks a claim that the matching credential config does not publish; it never blocks a type or claim, since you may ask for credentials issued elsewhere.

Each claim has optional settings for its ID, accepted values and (mDOC) intent to retain. Remove all claims of a credential to only check that the user holds a valid one ([without claims](dcql.md#check-a-credential-without-requesting-claims)). **Issuer trust** selects a managed trust list, an external trust list or a registered OpenID Federation trust anchor ([Trust Lists](../trust/trust-lists.md), [OpenID Federation](../trust/federation.md); federation works for SD-JWT VCs only, use a trust list for mDOCs); every credential needs at least one, unless you turn on **Accept credentials without issuer trust** below the credentials. That setting (`allowUntrustedIssuers`) accepts credentials without an issuer trust entry from any issuer whose signature is valid; the form and the config's page show a warning while it is on. Use it for development and interoperability tests only. An ETSI TS 119 612 Trusted List for QEAAs is entered with **Edit DCQL JSON** ([Trusted Lists for QEAAs](../trust/trust-lists.md#trusted-lists-for-qeaas)), and a query with one stays in JSON mode. **Accepted credential combinations** defaults to requiring every credential; add alternatives to let the wallet choose (`credential_sets`).

**Edit DCQL JSON** opens the raw query for rules the builder does not cover, such as claim sets. A query that uses such rules stays in JSON mode so they are preserved. See [DCQL](dcql.md) for the query language.

## Via the API

Create the configuration with `POST /api/verifier/config`. This example requests the membership credential from the [cookbook](../cookbooks/first-presentation.md):

```json title="membership-check.json"
{
    "id": "membership-check",
    "description": "Verify a membership name and ID",
    "dcql_query": {
        "credentials": [
            {
                "id": "membership",
                "format": "dc+sd-jwt",
                "meta": { "vct_values": ["urn:example:membership:1"] },
                "claims": [{ "path": ["name"] }, { "path": ["member_id"] }],
                "trusted_authorities": [{ "type": "etsi_tl", "values": [{ "trustListId": "membership-issuers" }] }]
            }
        ]
    },
    "lifeTime": 300,
    "webhookEndpointId": "membership-results",
    "redirectUri": "https://shop.example.com/verified?session={sessionId}"
}
```

```bash
curl -X POST "$EUDIPLO_URL/api/verifier/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @membership-check.json
```

The schema is strict: unknown fields, such as an inline `webhook` or `registrationCert`, are rejected with `400`. The response contains the stored configuration plus the read-only fields `createdAt` and `updatedAt`; remove them before sending a configuration back. A `POST` with the `id` of an existing configuration answers `409 Conflict` and leaves the stored one as it is; change it with `PATCH`.

| Task                  | Endpoint                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| List configurations   | `GET /api/verifier/config`                                                                     |
| Read one              | `GET /api/verifier/config/{id}`                                                                |
| Change fields         | `PATCH /api/verifier/config/{id}`: omitted fields keep their value, `null` clears a field       |
| Delete                | `DELETE /api/verifier/config/{id}`                                                             |

To manage configurations as files, place them in `config/<tenant>/presentation/<id>.json`; the file name becomes the ID. See [Configuration as Code](../operate/configuration-as-code.md).

## Send results to your backend

A presentation configuration references a webhook endpoint by ID (`webhookEndpointId`); it has no inline webhook. Create the endpoint once per tenant, in the Web Client under **Integrations → Webhook Endpoints** or via the API:

```bash
curl -X POST "$EUDIPLO_URL/api/issuer/webhook-endpoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "id": "membership-results",
    "name": "Membership results",
    "url": "https://shop.example.com/eudiplo/webhook",
    "auth": { "type": "apiKey", "config": { "headerName": "x-api-key", "value": "change-me" } }
  }'
```

A single request can override the endpoint with an inline `webhook` object. When the webhook is called and how to handle it is described in [Receive Results](receive-results.md).

## Registration certificate

If the wallet ecosystem requires a registration certificate, request one from the registrar: in the Web Client, **Request from EUDI Hub** on the configuration's **Security** tab ([EUDI Hub](../trust/eudi-hub.md#request-a-registration-certificate)). EUDIPLO stores it in `registration_cert`, together with the purpose and privacy policy it was requested with, which the next request can reuse:

```json
{
    "registration_cert": {
        "jwt": "eyJ...",
        "purpose": [
            { "lang": "de", "content": "Prüfung Ihrer Vereinsmitgliedschaft" },
            { "lang": "en", "content": "Check your club membership" }
        ],
        "privacy_policy": "https://shop.example.com/privacy"
    }
}
```

A certificate from another registrar goes into `registration_cert.jwt` the same way. It must be valid and cover the DCQL query exactly; request a new one after you change the query. The checks are described in [Registration Certificates](../trust/registration-certificates.md).

## Allowed origins (Digital Credentials API)

[DC API requests](requests.md#digital-credentials-api) (`dc-api` and `iso-18013-7`) are bound to the origin of the page that calls the wallet: OpenID4VP requests carry it in the signed `expected_origins` claim, ISO 18013-7 requests in the session transcript. The wallet checks it against the origin the browser reports and refuses requests from other pages. Your backend names that origin in each request (`expected_origin`). To limit which origins any caller may name, list them in `allowedOrigins`:

```json
{
    "allowedOrigins": ["https://shop.example.com"]
}
```

With the list, EUDIPLO creates `dc-api` and `iso-18013-7` requests only for these origins, and a request without `expected_origin` uses the only listed origin. Without it, any origin the request names is accepted. `uri` requests do not use the list. Each entry is an origin in serialized form, such as `https://shop.example.com` or `http://localhost:4200`; the exact rules are in the [validation rules](../reference/presentation-configuration.md#validation-rules).

Set the list when callers you do not fully control create requests, for example a client whose secret runs in a browser. To start DC API requests from the Web Client for a configuration with the list, add the Web Client's origin as well, for example `http://localhost:4200`. Since 10.0.

## Reader authentication (ISO 18013-7)

Set `readerAuth: true` to sign the `DeviceRequest` of [ISO 18013-7 requests](requests.md#iso-18013-7-annex-c) with the access key chain (`accessKeyChainId`, or the [default access key chain](../trust/keys-and-certificates.md#default-access-key-chain)). The wallet then validates the reader certificate chain before it releases data. The setting has no effect on OpenID4VP requests, which are always signed.

Reader authentication signs with the stored private key, so it needs an access key chain on the `db` [KMS provider](../operate/kms.md). Access keys in an external KMS cannot be used for it.

## Next steps

- [DCQL](dcql.md): alternatives, claim sets and trusted issuers.
- [Create presentation requests](requests.md).
- [Receive results](receive-results.md).
