---
title: Registrar
---

EUDIPLO can talk to the German EUDI wallet registrar to obtain access certificates, issue registration certificates and publish schema metadata. Each tenant uses its own registrar account. Other ecosystems are not supported by this integration: import their certificates instead ([Wallet and Registrar Requirements](wallet-registrars.md)).

## Prerequisites

- The `registrar:manage` role; without it the **Registrar** menu is hidden.
- Registrar URL, OIDC realm URL, client ID (and secret, if any), username and password from the registrar operator.

## 1. Connect the registrar

In the Web Client, open **Registrar → Registrar Config**. Pick the **German Sandbox** preset or enter the URLs, then the account credentials. Optionally set **Registration Certificate Defaults**: privacy policy URL, support URI and intermediary RP ID, used for every registration certificate of the tenant. Saving checks the credentials against the OIDC endpoint and fails if they are rejected (`400`) or the endpoint is unreachable (`503`).

The same configuration via the API (`POST /api/registrar/config` creates or replaces it, `PATCH` changes fields, `DELETE` removes it) or as file:

```json title="config/<tenant>/registrar.json"
{
    "registrarUrl": "https://sandbox.eudi-wallet.org/api",
    "oidcUrl": "https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar",
    "clientId": "swagger",
    "username": "your-username",
    "password": "your-password",
    "registrationCertificateDefaults": {
        "privacy_policy": "https://shop.example.com/privacy",
        "support_uri": "mailto:support@shop.example.com"
    }
}
```

File imports are not checked against the registrar, because it may be unreachable at startup.

:::warning[Stored credentials]
The password and client secret are encrypted in the database with the [data-at-rest key](../operate/encryption-keys.md). The API returns neither; `hasPassword` and `hasClientSecret` show whether they are set. Use a registrar account dedicated to this tenant.
:::

EUDIPLO acts as one relying party at the registrar. If the account has none yet, EUDIPLO registers one on first use; otherwise it uses the first relying party of the account.

## 2. Get an access certificate

In **Cryptographic Assets → Keys → Create Key**, choose **Access Certificate → Registrar Enrollment**. EUDIPLO creates an access key chain, sends a certificate request for its key to the registrar and stores the returned certificate on the key chain.

Via the API, create a standalone `access` key chain ([Keys and Certificates](keys-and-certificates.md#create-a-key-chain)) and enroll it:

```bash
curl -X POST "$EUDIPLO_URL/api/registrar/access-certificate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{ "keyId": "<access key chain id>" }'
```

The response contains `id` (the certificate ID at the registrar), `certId` (the key chain that now holds the certificate) and `crt` (the certificate as PEM).

If the registrar already issued a key and certificate to you, import them as an **External Certificate** instead; no registrar configuration is needed for that. Do not rotate a key chain with a registrar certificate: rotation replaces it with a self-signed certificate. Enroll a new key chain instead.

## 3. Registration certificates

With a registrar configuration, EUDIPLO creates registration certificates on demand:

- **Verifier:** for each presentation configuration with `registration_cert`; the `purpose` comes from the configuration, privacy policy and support URI from the defaults above.
- **Issuer:** in the issuance configuration (`registrationCertificate.mode: "generate"`), listing the schema metadata of your credential types.

Strategies, caching and the overasking check are described in [Registration Certificates](registration-certificates.md).

### Overasking check

EUDIPLO only sends a registration certificate whose authorized `credentials` cover the request exactly. Each credential query of the DCQL query must equal one authorized credential in `format`, `meta` and the ordered list of claim paths; claim IDs, `values` and `intent_to_retain` are ignored. Requesting fewer claims than authorized also fails. Otherwise creating the request fails with `400` ("Registration certificate does not authorize the requested DCQL credentials").

When EUDIPLO creates the certificate from `registration_cert.body` without `credentials`, it derives the authorized credentials from the DCQL query, so they match, and it creates a new certificate after the DCQL query changes. A certificate you import (`jwt`) or reuse (`id`) must already match. For development and interoperability tests only, `SKIP_OVERASKING_CHECK=true` disables the check; see [Skip Flags](../reference/environment-variables.md#skip-flags).

## Schema metadata (TS11)

Schema metadata describes an attestation type for relying parties: version, formats and schemas, rulebook, level of assurance and the trusted issuers. The registrar signs and publishes it; EUDIPLO prepares it from your credential types and trust lists.

:::warning[Draft specification]
TS11 is still a draft. Fields, endpoints and screens can change.
:::

1. Create the credential type in **Credential Issuance → Credential Types** and the trust list of your issuers in **Trust Lists**.
2. Open **Registrar → Schema → Create** and fill in **Version** (semantic version, for example `1.0.0`), **Rulebook URI**, **Attestation LoS**, **Binding Type** and **Name**; category and tags are optional.
3. Under **Schema URIs**, select the credential types the schema covers. If you select exactly one, its `schemaMeta` is linked to the new schema metadata ID.
4. Under **Trusted Authorities**, select trust lists or add root certificates (base64 DER).
5. Choose **Submit**. EUDIPLO uploads the schemas and the rulebook, the registrar signs the result.

EUDIPLO downloads the rulebook and schema URLs before uploading them, under the [outbound URL policy](../reference/webhooks.md): HTTPS only and no private addresses by default, at most 5 MB and three redirects per file.

Schema metadata is versioned: the list groups versions by ID, and a new version is published from the existing entry. Via the API, `POST /api/schema-metadata/publish` and `POST /api/schema-metadata/publish-version` publish (role `issuance:manage`); the other `/api/schema-metadata` endpoints list, read, update and deprecate entries (role `registrar:manage`).

The `schemaMeta` of each credential configuration determines the `provides_attestations` of the [issuer registration certificate](registration-certificates.md#issuer-registration-certificate). Verifiers can start a presentation configuration from schema metadata with **Import from Schema** ([Configure Verification](../presentation/configure-verification.md)).
