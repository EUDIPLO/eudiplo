---
title: Registration Certificates
---

A registration certificate is a JWT, issued by a registrar, that states what a relying party is registered for: a verifier the data it may request and why, an issuer the attestations it provides. EUDIPLO presents it to wallets, which can warn about or refuse requests that go beyond it; wallets do not present registration certificates. Creating certificates needs a [registrar configuration](registrar.md).

## Verifier registration certificate

Set `registration_cert` in a [presentation configuration](../presentation/configure-verification.md#registration-certificate). EUDIPLO adds the certificate to the signed request as `verifier_info: [{ "format": "registration_cert", "data": "<JWT>" }]`. An imported `jwt` works without a registrar configuration. `id` and `body` need one; without it the request is sent without a registration certificate.

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

An imported `jwt` is checked when the configuration is created and when an update changes `registration_cert` or `dcql_query`; the API refuses a failed check with `400` and the reason. The plan of a [configuration bundle](../operate/configuration-as-code.md#plan-and-import) (`eudiplo config plan`) or a [config folder](../operate/configuration-as-code.md#provision-tenants-from-a-folder) runs the same check for each presentation config it creates or updates: the item is `blocked` with `REGISTRATION_CERTIFICATE_REFUSED` at `/spec/registration_cert` and the reason as message, so the import applies nothing. At startup, EUDIPLO then logs the issue and imports none of that tenant's files until the file is fixed. Exports of bundles and of single presentation configs keep an imported `jwt`, and a plan treats a changed `jwt` as a change. A presentation config the plan leaves `unchanged` or skips is not checked again, so a certificate that expires after it was imported does not block later imports; the presentation request fails instead. Any other change to that file, even to its description, checks the certificate again. Certificates from `id` or `body` are checked after they are resolved; a failed check makes the presentation request fail with `400`. The resolved certificate is cached on the configuration (`registrationCertCache`) and reused until the DCQL query or `registration_cert` changes, the access certificate that signs the request changes, or until 60 seconds before it expires. After `registration_cert` or `dcql_query` changes, EUDIPLO resolves it again in the background; after the access certificate changes (including a new `accessKeyChainId`) or the cached certificate expires, the next presentation request resolves it, and fails if the registrar cannot be reached. `POST /api/verifier/config/{id}/registration-cert/reissue` forces a new certificate.

A certificate created from `body` names the registrar access certificate of the access key chain that signs the request (`accessCertificateId`) when the registrar lists one, unless the body sets it. The cache holds the certificate for the configuration's current access key chain: its `accessKeyChainId`, or the tenant's default. A request whose session keeps another access key chain, for example a step of the Interactive Authorization Endpoint started before the default access key chain changed, gets a certificate for that key chain; EUDIPLO creates it at the registrar for that request and does not cache it.

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
| `generate` | Requests a certificate from the registrar with `provides_attestations` set to the credential types of all SD-JWT VC and mDOC credential configurations: the `vct` of each SD-JWT VC configuration (for a `vct` object, its [hosted VCT URL](../issuance/credential-configuration.md)) and the `docType` of each mDOC configuration. Schema metadata (`schemaMeta`) is not used. At least one credential configuration needs a `vct` or `docType`, otherwise **Regenerate now** (`POST /api/issuer/config/registration-cert/reissue`) fails with `400`. `privacyPolicy` and `supportUri` fall back to the registrar defaults. |

A generated certificate is created when the issuer metadata is built, for example when a wallet fetches `/.well-known/openid-credential-issuer/issuers/<tenant>`; saving the configuration does not create one. It is cached in the issuance configuration and reused while the inputs are unchanged and it is valid. When a new certificate replaces a valid one, EUDIPLO revokes the old one at the registrar. If generation fails, the metadata is served without `issuer_info` and the reason is logged.

## Import and generate compared

|                   | Verifier (presentation configuration)                                       | Issuer (issuance configuration)                         |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Bring your own JWT | `registration_cert.jwt`; works without a registrar configuration            | `mode: "import"`; works without a registrar configuration |
| Checks            | Time (60 s tolerance) and overasking                                         | Time (30 s tolerance)                                   |
| Generated by the registrar | `registration_cert.body`, or `id` for an existing one              | `mode: "generate"`, from `vct` and `docType`            |
| Replaced certificate | Not revoked                                                              | Revoked at the registrar                                |
