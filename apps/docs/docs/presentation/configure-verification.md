---
title: Configure Verification
---

A presentation configuration is the reusable definition of a verification: which credentials and claims to request, how long a request is valid, and where results go. Create it once, then start a [presentation request](requests.md) for every verification. All fields are listed in the [presentation configuration reference](../reference/presentation-configuration.md).

## Prerequisites

- A tenant client or user with the `presentation:manage` role.
- An access key chain with an active certificate. EUDIPLO signs every request with it. See [Keys and Certificates](../trust/keys-and-certificates.md).
- Optional: a webhook endpoint that receives the results (see [below](#send-results-to-your-backend)).

## In the Web Client

Open **Credential Verification → Verification Configs → Create**. The guided setup has four steps:

1. **Name**: a unique ID (the `requestId` you use later) and an internal description.
2. **Credentials**: **Import from Issuer** reads credential types and claims from an issuer's metadata, **Import from Schema** starts from registrar schema metadata, and **Add credential** lets you enter the type and claims yourself.
3. **Settings**: review the request lifetime (default 300 seconds), the status check mode (default strict) and the access key chain (default: the tenant's access key chain). Expand the panels for redirect URI, registration certificate, webhook endpoint (**Application integration**) or transaction data.
4. **Review**: check the request and create the configuration. Use **Create offer** on the saved configuration to test it with a wallet.

**Switch to editor** shows all sections at once; existing configurations open in this mode. **Use guided setup** returns to the steps. Both modes edit the same form.

### Visual query builder and JSON

For SD-JWT VC, enter the credential type (VCT) and one field per claim path; use dots for nested paths such as `address.locality`, or paste a list of paths. For mDOC, enter the document type, namespace and element names. Type and paths must match the credential in the wallet, so importing them from the issuer avoids typos.

Each claim has optional settings for its ID, accepted values and (mDOC) intent to retain. **Issuer trust** selects a managed trust list, an external trust list or an OpenID Federation trust anchor ([Trust Lists](../trust/trust-lists.md)). **Accepted credential combinations** defaults to requiring every credential; add alternatives to let the wallet choose (`credential_sets`).

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
                "claims": [{ "path": ["name"] }, { "path": ["member_id"] }]
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

The schema is strict: unknown fields, such as an inline `webhook` or `registrationCert`, are rejected with `400`. The response contains the stored configuration plus the read-only fields `registrationCertCache`, `createdAt` and `updatedAt`; remove them before sending a configuration back.

| Task                  | Endpoint                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| List configurations   | `GET /api/verifier/config`                                                                     |
| Read one              | `GET /api/verifier/config/{id}`                                                                |
| Change fields         | `PATCH /api/verifier/config/{id}`: omitted fields keep their value, `null` clears a field       |
| Delete                | `DELETE /api/verifier/config/{id}`                                                             |
| Reissue the registration certificate | `POST /api/verifier/config/{id}/registration-cert/reissue`                      |

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

If the wallet ecosystem requires a registration certificate, set `registration_cert`. The `purpose` belongs to the presentation configuration; shared values such as the privacy policy come from the registrar defaults:

```json
{
    "registration_cert": {
        "body": {
            "purpose": [{ "lang": "en", "content": "Check your club membership" }]
        }
    }
}
```

EUDIPLO only attaches it when the tenant has a registrar configuration. Resolution, caching and the overasking check are described in [Registration Certificates](../trust/registration-certificates.md).

## Reader authentication (ISO 18013-7)

Set `readerAuth: true` to sign the `DeviceRequest` of [ISO 18013-7 requests](requests.md#iso-18013-7-annex-c) with the access key chain (`accessKeyChainId`, or the tenant's access key chain). The wallet then validates the reader certificate chain before it releases data. The setting has no effect on OpenID4VP requests, which are always signed.

Reader authentication signs with the stored private key, so it needs an access key chain on the `db` [KMS provider](../operate/kms.md). Access keys in an external KMS cannot be used for it.

## Next steps

- [DCQL](dcql.md): alternatives, claim sets and trusted issuers.
- [Create presentation requests](requests.md).
- [Receive results](receive-results.md).
