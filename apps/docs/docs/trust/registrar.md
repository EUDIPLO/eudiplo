---
title: Registrar
---

import SchemaReference from "@site/src/components/SchemaReference";

EUDIPLO can talk to the German EUDI wallet registrar to obtain access certificates, issue registration certificates and publish schema metadata. Each tenant uses its own registrar account. Other ecosystems are not supported by this integration: import their certificates instead ([Wallet and Registrar Requirements](wallet-registrars.md)).

## Prerequisites

- The `registrar:manage` role; without it the **Registrar** menu is hidden.
- For schema metadata, also `issuance:manage`: creating a schema and publishing a new version need it, and the detail page lists the credential types that reference a schema only with it. With `registrar:manage` alone, the schema list and details open, and **Create** and **Publish New Version** are disabled.
- Registrar URL, OIDC realm URL, client ID (and secret, if any), username and password from the registrar operator.

## 1. Connect the registrar

In the Web Client, open **Registrar → Registrar Config**. Pick the **German Sandbox** preset or enter the URLs, then the account credentials. Under **Relying Party Contact**, enter a support URL (`https://` only), an email address or a phone number (5 to 40 digits, spaces, `+`, `-`, `(` or `)`), at least one of them: the registrar puts them in your access certificates and refuses to issue one without ([Relying party](#relying-party)). Optionally set **Registration Certificate Defaults**: privacy policy URL, support URI and intermediary RP ID, used for every registration certificate of the tenant. Other defaults set through the API or `registrar.json`, such as `provides_attestations`, are kept when you save here. Every save checks the URLs against the outbound URL policy. A new configuration, a changed URL or changed credentials are also checked against the OIDC endpoint; saving only the defaults or the relying party contact does not contact it. Saving fails with `400` if a URL is malformed or blocked by the outbound URL policy (the response names the field) or the token endpoint answers with an error status, for example `401` for wrong credentials or `404` for a wrong OIDC URL; the message names the status and, for an OAuth2 error, its code, such as `invalid_grant`. It fails with `503` if the OIDC provider cannot be reached or returns no token; a host that cannot be resolved answers `400` unless `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` is set. After you change the registrar URL or the OIDC URL, enter the password again. Saving then replaces the configuration: enter the client secret again if the registrar needs one, an empty field removes it.

The same configuration via the API (`POST /api/registrar/config` creates or replaces it, `PATCH` changes fields and checks the credentials only when it sends the OIDC URL, the client ID, the username, the password or the client secret, `DELETE` removes it) or as file:

```json title="config/<tenant>/registrar.json"
{
    "registrarUrl": "https://sandbox.eudi-wallet.org/api",
    "oidcUrl": "https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar",
    "clientId": "swagger",
    "username": "your-username",
    "password": "your-password",
    "relyingPartyContact": {
        "email": "support@shop.example.com"
    },
    "registrationCertificateDefaults": {
        "privacy_policy": "https://shop.example.com/privacy",
        "support_uri": "mailto:support@shop.example.com"
    }
}
```

A file with `relyingPartyContact` needs file format v2 (`https://eudiplo.dev/schemas/v2/RegistrarConfigFile.schema.json`); a `registrar.json` without envelope is read as v2 when it has the field.

A `POST`, and a configuration bundle or file imported in `upsert` or `replace` mode, replace the whole configuration: a `clientSecret`, `registrationCertificateDefaults` or `relyingPartyContact` they leave out is removed. A `PATCH` keeps the fields it leaves out; send `null` to remove `registrationCertificateDefaults` or `relyingPartyContact`. File and bundle imports check the URLs against the outbound URL policy without resolving their hosts (scheme, allowlist, reserved names and IP addresses), and not the credentials against the registrar, because it may be unreachable at startup; the resolved address is checked on first use, and wrong credentials fail when EUDIPLO first uses them, for example when requesting an access certificate (`400`). A URL the policy blocks stops the import of that tenant at the registrar configuration, and the configurations imported after it (attribute providers, webhooks, issuance, credential, trust list, presentation and status list configurations) are not applied. A URL with a query, fragment or credentials already makes the plan fail, so no configuration file of that tenant is applied; at startup, the tenant itself is still created or updated from `info.json`, unless its settings are [detached or changed through the API](../operate/configuration-as-code.md#configuration-model). `eudiplo config validate` does not check the URL rule.

Both URLs must be `http(s)` base URLs without query, fragment or credentials. Every request to the registrar and its OIDC provider, including the token endpoint named by the OIDC discovery document and every redirect target, goes through the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS only and no private addresses by default. Up to 5 redirects are followed; the access token only goes to the origin of the original request, and a request body, such as the token request with the password, never goes to another origin: a `303`, or a `301` or `302` after a `POST`, continues as a `GET` without body, and any other redirect of a request with a body to another origin fails. Each request must finish within 30 seconds, redirects included, and a response may have at most 5 MiB. A configured URL that the policy blocks is rejected with `400` when the configuration is saved, as is a blocked token endpoint or redirect target. For a registrar on a private network or plain HTTP, set `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` or `OUTBOUND_URL_ALLOW_HTTP`. If `OUTBOUND_URL_ALLOWED_HOSTS` is set, it must list the registrar host, the OIDC host and the host of the token endpoint. Error messages of the registrar are passed on as text, cut after 500 characters.

:::warning[Stored credentials]
The password and client secret are encrypted in the database with the [data-at-rest key](../operate/encryption-keys.md). The API returns neither; `hasPassword` and `hasClientSecret` show whether they are set. Use a registrar account dedicated to this tenant.

A stored credential is never sent to a new address. A `PATCH` that changes `oidcUrl` or `registrarUrl` must send `password` again, and `clientSecret` if one is stored; otherwise it fails with `400`.
:::

### Relying party

EUDIPLO acts as one relying party at the registrar. If the account has none yet, EUDIPLO registers one on first use, with the `relyingPartyContact` of the registrar configuration; otherwise it uses the first relying party of the account as it is. The registrar has no request to change a relying party's contact, so changing `relyingPartyContact` later does not reach a relying party that is already registered.

`relyingPartyContact` takes `supportUri` (an `https` URL), `email` and `phone` (5 to 40 digits, spaces, `+`, `-`, `(` or `)`); an object without any of them, or with other fields, is rejected with `400`. When the registrar refuses the registration of the relying party, the request that needed it fails with `400 Failed to register relying party at registrar:` and the registrar's reason.

The registrar needs at least one contact value (`supportUri`, `email` or `phone`) to issue an access certificate. Without one, requesting an access certificate fails with `400 Failed to create access certificate: At least one registered contact value (support URI, email, or phone) is required.` Set `relyingPartyContact` before the first access certificate. If the relying party is already registered without contact, add the contact at the registrar; registering a new one through EUDIPLO is not possible while the account has a relying party.

## 2. Get an access certificate

In **Cryptographic Assets → Keys → Create Key**, choose **Access Certificate → Registrar Enrollment**. EUDIPLO creates an access key chain with the default signing algorithm of the selected KMS provider, sends a certificate request for its key to the registrar and stores the returned certificate on the key chain, all in one request. The key chain keeps its description (the one you entered, or **Access Certificate** if you left it empty), so you can still select it by that description, for example as **Access Key Chain** of a presentation configuration.

If the enrollment fails, EUDIPLO deletes the new key chain again, so no access key chain with only its self-signed certificate is left. When EUDIPLO refuses (`400`, `403` or `404`), for example with `400 Failed to authenticate with registrar: …` because the stored credentials are wrong or the OIDC provider cannot be reached, or with `403` because you lack the `registrar:manage` role, the Web Client shows the reason next to **Create & Enroll**. Check the registrar configuration and select **Create & Enroll** again. After another status such as `500`, the reason is shown as well; if EUDIPLO could not delete the new key chain, the reason names it: enroll it as described below, or delete it under **Keys**. If the Web Client gets no answer from EUDIPLO, it cannot tell whether the key chain was created: if **Keys** lists a new access key chain whose **Active Certificate** has a different issuer than subject, it is enrolled; with the same issuer as subject, it is self-signed: enroll it as described below, or delete it.

To enroll an existing standalone access key chain, for example one kept after a failed enrollment or one created with **Self-Signed Certificate**, open it under **Cryptographic Assets → Keys** and select **Enroll with Registrar** on its **Active Certificate** card. The action needs the `registrar:manage` role and a registrar configuration; on a key chain provisioned from a configuration file it is locked. The returned certificate replaces the active certificate for the same key; the description stays. The Web Client asks first if the active certificate was issued by someone else, for example by the registrar in an earlier enrollment, or if the key chain rotates automatically, since its next rotation would replace the registrar certificate. If the enrollment fails, it shows the reason, with a link to the registrar configuration unless the role was missing (`403`). After a failure without a refusal, such as no answer or a `500`, it reloads the key chain, because the certificate may have been stored.

Via the API, **Create & Enroll** is one request:

```bash
curl -X POST "$EUDIPLO_URL/api/registrar/access-key-chain" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{ "description": "Registrar access certificate" }'
```

`description` and `kmsProvider` are optional; without `kmsProvider` the default [KMS provider](../operate/kms.md) is used. EUDIPLO checks the registrar configuration and the relying party before it creates the key chain. When the registrar refuses the certificate request or EUDIPLO cannot store the certificate, the key chain is deleted and the request fails, with `400` for a refusal. If the key chain cannot be deleted, the request fails with `500` and the message names the key chain to delete. The response contains `id` (the certificate ID at the registrar), `certId` (the new key chain) and `crt` (the certificate as PEM).

To enroll an existing key chain, for example one created with `POST /api/key-chain` ([Keys and Certificates](keys-and-certificates.md#create-a-key-chain)), send its ID instead. On failure that key chain is kept with the certificate it had:

```bash
curl -X POST "$EUDIPLO_URL/api/registrar/access-certificate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{ "keyId": "<access key chain id>" }'
```

The response has the same fields; `certId` is the key chain you sent. The key chain keeps its description; one without a description gets `Access certificate from registrar (ID: <id>)`, as does a key chain created with `POST /api/registrar/access-key-chain` without `description`.

Both endpoints need the `registrar:manage` role. When the registrar answers the certificate request with an error, or no answer arrives, it may still have issued the certificate, for example when its response was lost. EUDIPLO then looks for an active certificate with the key's public key among the registrar's access certificates of your relying party, other than the one the key chain already holds, and stores it, as if the request had succeeded. Without one, an error answer of the registrar fails the request with `400` and the registrar's reason; a registrar that stops answering during the certificate request fails it with `500`. A registrar that cannot be reached at all fails earlier, with `400 Failed to fetch relying parties from registrar`. When EUDIPLO cannot store a certificate this request issued, it revokes it at the registrar; if that fails too, the log names the certificate ID to revoke there.

Where no access key chain is named, EUDIPLO uses the [default access key chain](keys-and-certificates.md#default-access-key-chain): the one set for the tenant, else one picked by rule, which prefers a registrar certificate over a self-signed one.

If the registrar already issued a key and certificate to you, import them as an **External Certificate** instead; no registrar configuration is needed for that. Do not rotate a key chain with a registrar certificate: rotation replaces it with a self-signed certificate for a new key. If it was rotated, select **Enroll with Registrar** to get a registrar certificate for the new key.

## 3. Registration certificates

With a registrar configuration, EUDIPLO creates registration certificates on demand:

- **Verifier:** for each presentation configuration with `registration_cert`; the `purpose` comes from the configuration, privacy policy and support URI from the defaults above.
- **Issuer:** in the issuance configuration (`registrationCertificate.mode: "generate"`), listing the schema metadata of your credential types.

Strategies, caching and the overasking check are described in [Registration Certificates](registration-certificates.md).

### Overasking check

EUDIPLO only sends a registration certificate whose authorized `credentials` cover the request exactly. Each credential query of the DCQL query must equal one authorized credential in `format`, `meta` and the claim paths; the order of the claims, claim IDs, `values` and `intent_to_retain` are ignored. Requesting fewer claims than authorized also fails. Otherwise creating the request fails with `400` ("Registration certificate does not authorize the requested DCQL credentials").

When EUDIPLO creates the certificate from `registration_cert.body` without `credentials`, it derives the authorized credentials from the DCQL query, so they match, and it creates a new certificate after the DCQL query changes. A certificate you import (`jwt`) or reuse (`id`) must already match. For development and interoperability tests only, `SKIP_OVERASKING_CHECK=true` disables the check; see [Skip Flags](../reference/environment-variables.md#skip-flags).

## Schema metadata (TS11)

Schema metadata describes an attestation type for relying parties: version, formats and schemas, rulebook, level of assurance and the trusted issuers. The registrar signs and publishes it; EUDIPLO prepares it from your credential types and trust lists.

:::warning[Draft specification]
TS11 is still a draft. Fields, endpoints and screens can change.
:::

1. Create the credential type in **Credential Issuance → Credential Types** and the trust list of your issuers in **Trust Lists**.
2. Open **Registrar → Schema → Create** and fill in **Version** (semantic version, for example `1.0.0`), **Rulebook URI**, **Attestation LoS**, **Binding Type** and **Name**; category and tags are optional. Alternatively, choose **Create schema for this configuration** on the credential type: it is preselected in the next step and linked to the new schema metadata ID.
3. Under **Schema URIs**, select the credential types the schema covers. If you select exactly one, its `schemaMeta` is linked to the new schema metadata ID.
4. Under **Trusted Authorities**, select trust lists or add root certificates (PEM or base64 DER). Each root certificate field takes one certificate; a certificate chain is rejected. For a selected trust list, EUDIPLO sends the registrar the active certificate of its key chain. After that key chain rotates, save the trust list, which signs it with the new key, and then publish a new version.
5. Choose **Submit**. EUDIPLO uploads the schemas and the rulebook, the registrar signs the result.

EUDIPLO downloads the rulebook and schema URLs before uploading them, under the [outbound URL policy](../concepts/security-model.md#https-and-tls): HTTPS only and no private addresses by default, at most 5 MiB and three redirects per file, and 10 seconds without data per request.

Schema metadata is versioned: the list groups versions by ID. To publish a new version:

1. Open the schema and choose **Publish New Version**.
2. Check **New Version** and **Rulebook URI**. The registrar does not copy the name, category and tags to a new version, so the Web Client sends those of the shown version again (the ID as name if it has none). It leaves out values that are not in the registrar vocabulary; if the vocabulary cannot be loaded, it sends them unchecked and says so before you publish. The vct or doctype of each schema URI comes from the credential type linked to the schema: the one named in the URI, otherwise the only linked credential type of that format.
3. Leave **Deprecate current version** ticked to deprecate the shown version, and choose **Publish**. If the deprecation fails, the new version stays published and the message offers **Retry**.

On the details of a version, **Catalog Metadata** changes its name, category and tags, **Deprecate** deprecates it later (marked as superseded by the newest version, if there is a newer one), and **Delete** removes it at the registrar. Deprecate and Delete ask for confirmation first.

Via the API, `POST /api/schema-metadata/publish` and `POST /api/schema-metadata/publish-version` publish (roles `issuance:manage` and `registrar:manage`, both required); the other `/api/schema-metadata` endpoints list, read, update, deprecate (`PATCH /api/schema-metadata/{id}/versions/{version}/deprecation`) and delete entries (role `registrar:manage`); see [Publish via the API](#publish-via-the-api). All endpoints and their roles: [Roles](../reference/roles.md#endpoints).

The `schemaMeta` of each credential configuration determines the `provides_attestations` of the [issuer registration certificate](registration-certificates.md#issuer-registration-certificate). Verifiers can start a presentation configuration from schema metadata with **Import from Schema** ([Configure Verification](../presentation/configure-verification.md)).

### Publish via the API

`POST /api/schema-metadata/publish` takes the body below. `POST /api/schema-metadata/publish-version` takes the same body for a new version: `config.id` names the existing schema, and `pinMode: "replace_id"` repoints the pin to it. The registrar does not copy the name, category and tags to a new version: send them again in `config.name` (required), `config.category` and `config.tags`. `GET /api/schema-metadata/vocabularies` (role `registrar:manage`) lists the values of `config.category` and `config.tags`. A `publish` request with `credentialConfigId` and `config.id` but without `config.rulebookURI` is link-only: EUDIPLO uploads nothing, rejects category and tags, and writes `config` with that ID into the `schemaMeta` of the credential configuration as `pinMode` allows.

<SchemaReference name="schema-metadata-publish" mode="table" />
