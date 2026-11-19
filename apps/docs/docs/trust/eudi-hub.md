---
title: EUDI Hub
---

The German EUDI Hub ([portal.eudi-hub.gov.de](https://portal.eudi-hub.gov.de/)) is the registrar of the German wallet ecosystem and the registrar EUDIPLO integrates with: organizations register there and get access and registration certificates for their relying parties. EUDIPLO requests an access certificate for one of its access key chains, so the private key stays in EUDIPLO, and registration certificates for its presentation configurations and its issuer. It works with an access token you copy from the portal, so there is no EUDI Hub configuration to save. [Certificates from the EUDI Hub](../cookbooks/eudi-hub-certificates.md) walks through all three requests for the cookbook tenant.

## Prerequisites

- The `registrar:manage` role; for registration certificates also `presentation:manage` (verifier) or `issuance:manage` (issuer).
- An organization at the EUDI Hub, and a portal user assigned to it that may issue certificates. Create and verify the organization in the portal; EUDIPLO does not do that.
- For an access certificate, a standalone access key chain in EUDIPLO, for example created in **Cryptographic Assets → Keys → Create Key** with **Access Certificate → Self-Signed Certificate**.
- EUDIPLO must reach the EUDI Hub API under the [outbound URL policy](../concepts/security-model.md#https-and-tls); with `OUTBOUND_URL_ALLOWED_HOSTS` set, list `api.eudi-hub.gov.de` and the host from which the EUDI Hub serves the CA that issues access certificates (the URL its certificates name under Authority Information Access). Without that host, access certificates are stored without their issuing CA.

## Copy the access token

The EUDI Hub API only accepts access tokens issued to its portal; it offers no accounts for other software. The token is valid for a few minutes, is sent with your request only and is not stored.

1. Sign in to the [EUDI Hub portal](https://portal.eudi-hub.gov.de/).
2. Open the developer tools of your browser and select the **Network** tab.
3. Open a page of the portal that loads data, such as **Access certificates**, and select a request to `api.eudi-hub.gov.de`.
4. Copy the value of its `Authorization` request header. It works with or without the `Bearer` prefix.

Treat the token like a password: it acts as your portal user until it expires. Copy a fresh one if EUDIPLO reports that the EUDI Hub did not accept it.

## Request an access certificate

Open the access key chain under **Cryptographic Assets → Keys** and select **Request from EUDI Hub** on its **Active Certificate** card. The action needs the `registrar:manage` role and is shown for standalone access key chains only; on a key chain provisioned from a configuration file it is locked. In the dialog:

- **Access token**: the token you copied.
- **Organization**: select **Load Organizations** to list the organizations of the token's user, or enter the organization ID (a UUID) by hand.
- **Environment**: **Sandbox** or **Live**. Live needs an organization the EUDI Hub has promoted to live.
- **Support URI**: where people can reach your organization about this certificate.
- **Certificate name**: the name shown in the portal; empty uses the key chain's description, else its ID.

**Request Certificate** (**Request Live Certificate** for Live) sends a certificate signing request (CSR) for the key chain's active key to the EUDI Hub, downloads the issued certificate and stores it as the key chain's active certificate. The EUDI Hub hands out the certificate without the CA that issued it, which wallets need in `x5c` to reach the root they trust; EUDIPLO fetches that CA from the URL the certificate names (Authority Information Access, under the outbound URL policy) and stores it after the certificate when it issued it and is not a self-signed root. If it cannot be fetched, for example because the outbound URL policy blocks its host, the certificate is stored alone and the log says so. The key stays the same; the key chain keeps its description, and one without a description gets `Access certificate from the EUDI Hub (<environment>, ID: <id>)`. The Web Client asks first if the active certificate was issued by someone else, or if the key chain rotates automatically, since its next rotation would replace the certificate with a self-signed one for a new key. If the request fails, the dialog stays open and shows the reason.

Via the API, with the EUDIPLO token in the `Authorization` header and the portal token in the body:

```bash
curl -X POST "$EUDIPLO_URL/api/eudi-hub/organizations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{ "token": "<portal token>" }'

curl -X POST "$EUDIPLO_URL/api/eudi-hub/access-certificate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "token": "<portal token>",
    "organizationId": "<organization id>",
    "keyId": "<access key chain id>",
    "environment": "sandbox",
    "supportUri": "https://verifier.example/support"
  }'
```

`name` is optional. The response contains `id` (the certificate ID at the EUDI Hub), `certId` (the key chain), `crt` (the certificate as PEM), `environment`, and, as the EUDI Hub reports them, `clientId` and `expirationDate`.

## Request a registration certificate

A registration certificate tells wallets what a verifier may request and why, or which credentials an issuer provides ([Registration Certificates](registration-certificates.md)). At the EUDI Hub, a verifier certificate is issued for a _credential request_ and an issuer certificate for _credential issuances_; EUDIPLO registers these for you. EUDIPLO stores the certificate in the configuration ([Registration Certificates](registration-certificates.md)). It cannot reach the EUDI Hub without a fresh token, so it does not renew the certificate: request a new one before it expires, and after you change the DCQL query or the credential types.

**Verifier:** open the presentation configuration, go to the **Security** tab and select **Request from EUDI Hub** (needs `registrar:manage` and `presentation:manage`; locked on a configuration provisioned from a configuration file). EUDIPLO turns the DCQL query, with `<TENANT_URL>` resolved, into a credential request: for each credential query the format, its single `vct` or `docType` and the claim paths. It uses an existing credential request of the organization in that environment with the same credentials, privacy policy and purpose texts sent to the EUDI Hub (texts that are not sent do not count), else it creates one. The configuration's `registration_cert` then holds the certificate (`jwt`) with the `purpose` and `privacy_policy` it was requested with; storing runs the [checks of every registration certificate](registration-certificates.md#validation), including the overasking check. A request that leaves out the purpose or the privacy policy uses the ones `registration_cert` keeps, so renewing a certificate needs only the token and the organization's fields; without either, the request is refused with `400` before the EUDI Hub is called. A DCQL query is refused with `400` before the EUDI Hub is called when a credential query lists several `vct_values`, has meta other than `vct_values` or `doctype_value`, uses a format other than `dc+sd-jwt` or `mso_mdoc`, lists no claims, or has a claim path with an array index or wildcard (`null`), since the EUDI Hub registers none of these and the certificate would then fail the overasking check.

**Issuer:** open **Issuer Settings**, go to the **Registration Certificate** tab and select **Request from EUDI Hub** (needs `registrar:manage` and `issuance:manage`; locked when the issuance configuration is provisioned from a configuration file). EUDIPLO registers the `vct` of each SD-JWT VC and the `docType` of each mDOC credential configuration as a credential issuance, unless the organization has one for that format and type in that environment, requests a certificate for all of them and checks that it lists every type. When the EUDI Hub does not register a type, the error names it and every other type the EUDI Hub did not register (the server log has the reasons for the other types), and no certificate is requested; issuances created for the other types stay at the EUDI Hub and the next request reuses them. It stores the certificate and the support URI in the issuance configuration's `registrationCertificate` and turns it on (`enabled: true`); other settings such as the privacy policy stay.

In both dialogs, after you paste the token and choose the organization, EUDIPLO reads the organization's identifier, service description, privacy policy and contact URLs from the EUDI Hub and fills empty fields with them. The EUDI Hub needs:

- **Identifier**: an official identifier of the organization, such as its EUID or Handelsregisternummer.
- **Service description** and, for a verifier, **Purpose**: each in German and English. The dialog lists purposes the configuration keeps in other languages below the fields and stores them again with the new certificate; only those with a two-letter language code reach the EUDI Hub (see the API description below). A regional German or English text that filled a field, such as `de-DE` without `de`, is saved as `de` or `en`, and kept texts without a valid language tag or text, or beyond 50 texts, are removed.
- **Support URI** and **Info URI**; for a verifier also the **Privacy policy**.

Via the API, with the EUDIPLO token in the `Authorization` header and the portal token in the body:

```bash
curl -X POST "$EUDIPLO_URL/api/eudi-hub/registration-certificate/presentation" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "token": "<portal token>",
    "organizationId": "<organization id>",
    "environment": "sandbox",
    "presentationConfigId": "<presentation configuration id>",
    "identifier": { "type": "http://data.europa.eu/eudi/id/EUID", "value": "DE/HRB123456B" },
    "serviceDescription": [
      { "lang": "de", "content": "Altersprüfung im Online-Shop" },
      { "lang": "en", "content": "Age verification in the online shop" }
    ],
    "purpose": [
      { "lang": "de", "content": "Prüfung, ob Sie volljährig sind" },
      { "lang": "en", "content": "Checks that you are of age" }
    ],
    "privacyPolicy": "https://verifier.example/privacy",
    "supportUri": "https://verifier.example/support",
    "infoUri": "https://verifier.example"
  }'
```

`purpose` and `privacyPolicy` are optional when the presentation configuration's `registration_cert` keeps them. `purpose` needs a German (`de`) and an English (`en`) text and may hold up to 50 texts with language tags such as `fr` or `pt-BR`. All of them are stored in `registration_cert.purpose`, but the EUDI Hub accepts only two-letter language codes, at most 24 texts: texts with a region or a three-letter code, such as `pt-BR` or `eng`, are kept in the configuration for the next request or another registrar, but are not part of the certificate. Beyond 24 texts, EUDIPLO sends `de`, `en` and then the first others in request order; the rest is stored only. `POST /api/eudi-hub/registration-certificate/issuer` takes the same fields without `presentationConfigId`, `purpose` and `privacyPolicy`. `name` is optional for both. `POST /api/eudi-hub/organization-details` with `token` and `organizationId` returns the data the dialog fills in. The response contains `id` (the certificate ID at the EUDI Hub), `environment`, `expirationDate`, and `credentialRequestId` with `reusedCredentialRequest` for a verifier or `credentialIssuanceIds` for an issuer.

When EUDIPLO cannot download or store a registration certificate the EUDI Hub issued, or an issuer certificate does not list every credential type, it revokes the certificate at the EUDI Hub (reason `cessationOfOperation`). A certificate that a new one replaces is not revoked; revoke it in the portal.

## Errors

- `400`: the request is invalid, the key chain is not a standalone access key chain, the DCQL query or the credential types cannot be registered, neither the request nor `registration_cert` has a purpose or privacy policy, the kept privacy policy is not an http or https URL, the purpose (of the request or kept in `registration_cert`) lacks a German or English text, gives a language twice, uses something other than a language tag, has more than 50 texts or an empty or overlong text, the certificate fails the checks of a registration certificate, the outbound URL policy blocks the EUDI Hub URL, or the EUDI Hub refused. A refused token (expired, or not from the portal) is reported as `400` naming HTTP 401 of the EUDI Hub, not as `401`, since your EUDIPLO session is fine. Missing permissions at the EUDI Hub are reported as `400` naming HTTP 403 of the EUDI Hub; other refusals carry the EUDI Hub's reason. A certificate for another key, which EUDIPLO does not store, is a `400` as well.
- `403`: a role is missing.
- `404`: the key chain or the presentation configuration does not exist.
- `502`: the EUDI Hub could not be reached, answered with a server error, answered with something other than what its API describes, or issued an issuer certificate that does not list every credential type. When registering the credential types of an issuer certificate fails this way for one type, the answer is `502` even if the EUDI Hub refused another type. A `502` before EUDIPLO asked for a registration certificate, while it read or registered the credential issuances of an issuer or found or registered the credential request of a verifier, has `"code": "EUDI_HUB_NO_CERTIFICATE_REQUESTED"`: EUDIPLO requested no certificate and stored nothing; credential issuances or a credential request created on the way stay at the EUDI Hub, and the next request reuses them. After any other `502` a certificate may have been stored anyway, for example when a proxy gave up while EUDIPLO went on; look at the presentation or issuance configuration, or the key chain for an access certificate, before you request again.

When an access certificate request gets no answer or the EUDI Hub fails with a server error, the EUDI Hub may still have issued the certificate. EUDIPLO then looks among the first 100 listed certificates of that environment, downloading at most 5 valid ones of the same name, for one with the key's public key, other than the one the key chain already holds, and stores it as if the request had succeeded. When EUDIPLO cannot download or store a certificate this request issued, it revokes it at the EUDI Hub (reason `cessationOfOperation`); if that fails too, the log names the certificate ID to revoke in the portal.

## Configuration

EUDIPLO talks to the production EUDI Hub at `https://api.eudi-hub.gov.de/org-management`. To use another environment of the EUDI Hub, set `EUDI_HUB_API_URL` ([Environment Variables](../reference/environment-variables.md#registrar)). EUDIPLO sends pasted tokens only to that URL.

## Limits

- Certificates from the EUDI Hub are not renewed automatically; request new ones with a fresh token.
- EUDIPLO looks for an existing credential request or credential issuance among the first 100 of the organization in that environment.
- All EUDI Hub operations are marked as drafts in its API description and may change.
