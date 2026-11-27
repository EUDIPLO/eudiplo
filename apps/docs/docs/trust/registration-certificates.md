---
title: Registration Certificates
---

A registration certificate is a JWT, issued by a registrar, that states what a relying party is registered for: a verifier the data it may request and why, an issuer the attestations it provides. EUDIPLO presents it to wallets, which can warn about or refuse requests that go beyond it; wallets do not present registration certificates. EUDIPLO requests certificates from the German EUDI Hub ([EUDI Hub](eudi-hub.md#request-a-registration-certificate)) and stores them; a certificate from another registrar is stored the same way. EUDIPLO does not renew certificates: request a new one before it expires.

## Verifier registration certificate

Set `registration_cert` in a [presentation configuration](../presentation/configure-verification.md#registration-certificate). EUDIPLO adds the certificate to the signed request as `verifier_info: [{ "format": "registration_cert", "data": "<JWT>" }]`.

| Field            | Meaning                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt`            | The certificate, attached to every request object as is. Without it, requests carry no registration certificate.                                           |
| `purpose`        | Why the data is requested (GDPR purpose), `[{ "lang", "content" }]`. Used when a certificate is requested from a registrar; the EUDI Hub needs `de` and `en`. |
| `privacy_policy` | URL of the privacy policy for this request. Used when a certificate is requested from a registrar.                                                          |

A request to the EUDI Hub stores all three, so a later request for a new certificate, for example after the DCQL query changed or before the certificate expires, can leave out the purpose and privacy policy. You can also set `purpose` and `privacy_policy` before the first request.

```json
{
    "registration_cert": {
        "jwt": "eyJ...",
        "purpose": [
            { "lang": "de", "content": "Prüfung Ihrer Vereinsmitgliedschaft" },
            { "lang": "en", "content": "Check your club membership" }
        ],
        "privacy_policy": "https://verifier.example/privacy"
    }
}
```

### Validation

The certificate is checked before every use:

- **Time:** `exp` and `nbf` with 60 seconds tolerance.
- **Access certificate:** the certificate must be issued to the relying party of the access certificate that signs the request; see [Access certificate match](#access-certificate-match).
- **Overasking:** the certificate's authorized `credentials` must cover the request exactly; see [Overasking check](#overasking-check).

The certificate is checked when the configuration is created and when an update changes `registration_cert`, `dcql_query` or `accessKeyChainId`; the API refuses a failed check with `400` and the reason. The plan of a [configuration bundle](../operate/configuration-as-code.md#plan-and-import) (`eudiplo config plan`) or a [config folder](../operate/configuration-as-code.md#provision-tenants-from-a-folder) runs the same check for each presentation config it creates or updates: the item is `blocked` with `REGISTRATION_CERTIFICATE_REFUSED` at `/spec/registration_cert` and the reason as message, so the import applies nothing. At startup, EUDIPLO then logs the issue and imports none of that tenant's files until the file is fixed. The plan matches the certificate against the access key chain stored in the tenant. When the bundle or folder also contains a `KeyChainDefaults` document or a `KeyChain` document with `usageType: access`, it leaves that match to the import instead: the import stops at the presentation config with `CONFIG_APPLY_FAILED`, the documents applied before it stay applied, and later ones, status lists and deletions are not applied (at startup, again on every start until the file is fixed). Exports of bundles and of single presentation configs keep the `jwt`, and a plan treats a changed `jwt` as a change. A presentation config the plan leaves `unchanged` or skips is not checked again, so a certificate that expires after it was imported does not block later imports. Any other change to that file, even to its description, checks the certificate again.

Every presentation request checks the certificate again; when it has expired since it was stored, no longer covers the DCQL query, or does not belong to the access certificate that signs the request, the request fails with `400`.

### Access certificate match

A wallet links the registration certificate to the access certificate of the request through the relying party's identifier (ETSI TS 119 475, clause 5.1). EUDIPLO checks the same link before it sends the certificate: the `sub` of the registration certificate must equal the relying party identifier of the access certificate, which is the subject's `organizationIdentifier` for a legal person and its `serialNumber` for a natural person, for example `LEIXG-529900T8BM49AURSDO55` or `VATDE-123456789`. EUDIPLO reads the access certificate with `@owf/eudi-access-certificate`: it is a natural person's when its certificate policy is a natural-person one (NCP-n-eudiwrp or QCP-n-eudiwrp), or, without such a policy, when it has no `organizationIdentifier` but a `givenName`, `surname` or `pseudonym`; every other access certificate is matched by its `organizationIdentifier` only. An access certificate that cannot be read refuses the registration certificate too.

When the relying party acts through an intermediary, the intermediary presents its own access certificate. The registration certificate then names the intermediary in `intermediary.sub`, and that identifier, not `sub`, must equal the one of the access certificate. A registration certificate with `intermediary` but without `intermediary.sub` (in v1.1.1, `act` without `act.sub`) is refused.

These are the claims of ETSI TS 119 475 v1.2.1. Certificates in the shape of v1.1.1 are read too: `sub.id` instead of `sub` (with several identifiers, one match is enough) and `act.sub.id`, or `act.sub` given as a string, instead of `intermediary.sub`. Names, country and other fields are not compared.

The access certificate is the leaf certificate of the presentation configuration's `accessKeyChainId`, or of the tenant's default access key chain. A request uses the key chain fixed when its session was created, so after a key chain change only new sessions fail. A save without any access key chain leaves the match to the request. A request with an `openid_federation` client ID carries no access certificate (`x5c`), so it is not matched; a save cannot know the client ID of later requests and matches against the access key chain all the same. A certificate without an identifier in `sub` and without an intermediary is not matched. A mismatch fails with "The registration certificate does not belong to the access certificate", followed by both identifiers. When you change the access key chain of a presentation configuration, or the tenant's default access key chain, to one issued to another relying party, request a new registration certificate for it; until then, requests of that configuration fail. Without a default set in the key chain defaults, the default is picked by rule and can change when a key chain is added or a certificate expires ([Default access key chain](keys-and-certificates.md#default-access-key-chain)); set `accessKeyChainId` or the default explicitly to keep it fixed.

### Overasking check

EUDIPLO only sends a registration certificate whose authorized `credentials` cover the request exactly. Each credential query of the DCQL query, with `<TENANT_URL>` resolved, must equal one authorized credential in `format`, `meta` and the claim paths; the order of the claims, claim IDs, `values` and `intent_to_retain` are ignored. Requesting fewer claims than authorized also fails ("Registration certificate does not authorize the requested DCQL credentials"). After you change the DCQL query, request a new certificate. For development and interoperability tests only, `SKIP_OVERASKING_CHECK=true` disables the check; see [Skip Flags](../reference/environment-variables.md#skip-flags).

## Issuer registration certificate

Set `registrationCertificate` in the issuance configuration to publish a certificate in the credential issuer metadata as `issuer_info: [{ "format": "registration_cert", "data": "<JWT>" }]`:

```json
{
    "registrationCertificate": {
        "enabled": true,
        "jwt": "eyJ...",
        "privacyPolicy": "https://issuer.example.com/privacy",
        "supportUri": "https://issuer.example.com/support"
    }
}
```

| Field           | Meaning                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`       | Publish the certificate.                                                                                   |
| `jwt`           | The certificate, published while it is within `nbf`/`exp` (30 seconds tolerance). An expired one is left out and logged. |
| `privacyPolicy` | Privacy policy URL of the issuer. Stored only; neither EUDIPLO nor the EUDI Hub request uses it.            |
| `supportUri`    | Support URI of the issuer, kept for requesting a new certificate. A request to the EUDI Hub stores the one it used. |

The certificate must list the credential types of the issuer: the `vct` of each SD-JWT VC configuration (for a `vct` object, its [hosted VCT URL](../issuance/credential-configuration.md)) and the `docType` of each mDOC configuration. A request to the EUDI Hub registers exactly these and refuses a certificate that misses one. After you add a credential type, request a new certificate.

## Verifier and issuer compared

|                       | Verifier (presentation configuration)       | Issuer (issuance configuration)                  |
| --------------------- | ------------------------------------------- | ------------------------------------------------ |
| Certificate           | `registration_cert.jwt`                     | `registrationCertificate.jwt` with `enabled: true` |
| Kept request values   | `purpose`, `privacy_policy`                 | `supportUri`                                     |
| Checks                | Time (60 s tolerance), access certificate match and overasking | Time (30 s tolerance)                            |
| After a change        | New DCQL query, or access key chain of another relying party: request a new certificate | New credential type: request a new certificate   |
| Replaced certificate  | Not revoked; revoke it at the registrar      | Not revoked; revoke it at the registrar          |
