---
title: Registration Certificates
---

A registration certificate is a JWT, issued by a registrar, that states what a relying party is registered for: a verifier the data it may request and why, an issuer the attestations it provides. EUDIPLO presents it to wallets, which can warn about or refuse requests that go beyond it; wallets do not present registration certificates. Creating certificates needs a [registrar configuration](registrar.md).

## Verifier registration certificate

Set `registration_cert` in a [presentation configuration](../presentation/configure-verification.md#registration-certificate). EUDIPLO adds the certificate to the signed request as `verifier_info: [{ "format": "registration_cert", "data": "<JWT>" }]`, but only when both are true:

- the presentation configuration has `registration_cert`, and
- the tenant has a registrar configuration, even if you supply the JWT yourself.

Otherwise the request is sent without a registration certificate.

### Strategies

| Field  | Behavior                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt`  | Uses this JWT as is; no registrar call. Takes precedence over `id` and `body`.                                                                                  |
| `id`   | Uses the active (not revoked) certificate with this ID of the tenant's relying party. If none is found, falls back to `body`; without `body` the request fails. |
| `body` | Creates a new certificate at the registrar.                                                                                                                     |

At least one of them is required.

### Payload of a new certificate

For `body`, EUDIPLO merges, with later values winning:

1. `registrationCertificateDefaults` of the registrar configuration,
2. `registration_cert.body` of the presentation configuration.

The relying party (`rpId`) is always set by EUDIPLO. If neither `credentials` nor `provides_attestations` is set, `credentials` is derived from the DCQL query: `format`, `meta` and `claims` of every credential query. After merging, `privacy_policy`, `support_uri`, `purpose` (as `[{ "lang", "content" }]`) and `credentials` must be present, otherwise creating the request fails with `400`.

```json
{
    "registration_cert": {
        "body": {
            "purpose": [{ "lang": "en", "content": "Check your club membership" }]
        }
    }
}
```

### Validation and caching

Every certificate, also an imported `jwt`, is checked before use:

- **Time:** `exp` and `nbf` with 60 seconds tolerance.
- **Overasking:** the certificate's authorized `credentials` must exactly cover every credential query of the DCQL query; see [Overasking check](registrar.md#overasking-check). `SKIP_OVERASKING_CHECK=true` disables this for development.

A failed check makes the presentation request fail with `400`. The resolved certificate is cached on the configuration (`registrationCertCache`) and reused until the DCQL query or `registration_cert` changes, or until 60 seconds before it expires. After a change, EUDIPLO resolves it again in the background. `POST /api/verifier/config/{id}/registration-cert/reissue` forces a new certificate.

## Issuer registration certificate

Set `registrationCertificate` in the issuance configuration to publish a certificate in the credential issuer metadata as `issuer_info: [{ "format": "registration_cert", "data": "<JWT>" }]`:

```json
{
    "registrationCertificate": {
        "enabled": true,
        "mode": "generate",
        "privacyPolicy": "https://issuer.example.com/privacy",
        "supportUri": "mailto:support@issuer.example.com"
    }
}
```

| `mode`     | Behavior                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`   | Publishes `jwt` while it is within `nbf`/`exp` (30 seconds tolerance). No registrar configuration needed.                                                                                                                                                                                      |
| `generate` | Requests a certificate from the registrar with `provides_attestations` set to the schema metadata IDs (`schemaMeta.id`) of all SD-JWT VC and mDOC credential configurations. At least one credential configuration needs schema metadata ([Registrar](registrar.md#schema-metadata-ts11)). `privacyPolicy` and `supportUri` fall back to the registrar defaults. |

A generated certificate is created when the issuer metadata is built, for example when a wallet fetches `/.well-known/openid-credential-issuer/issuers/<tenant>`; saving the configuration does not create one. It is cached in the issuance configuration and reused while the inputs are unchanged and it is valid. When a new certificate replaces a valid one, EUDIPLO revokes the old one at the registrar. If generation fails, the metadata is served without `issuer_info` and the reason is logged.

## Import and generate compared

|                   | Verifier (presentation configuration)                                       | Issuer (issuance configuration)                         |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Bring your own JWT | `registration_cert.jwt`; attached only with a registrar configuration       | `mode: "import"`; works without a registrar configuration |
| Checks            | Time (60 s tolerance) and overasking                                         | Time (30 s tolerance)                                   |
| Generated by the registrar | `registration_cert.body`, or `id` for an existing one              | `mode: "generate"`, from schema metadata                |
| Replaced certificate | Not revoked                                                              | Revoked at the registrar                                |
