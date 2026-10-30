---
title: Keys and Certificates
---

A key chain is a signing key together with its certificate chain. Each tenant needs one per purpose: an access key chain to sign presentation requests, an attestation key chain to sign credentials, and optionally status list and trust list key chains. The key chain that signs access tokens is created by EUDIPLO ([Access token key chain](#access-token-key-chain)). Create them in the Web Client under **Cryptographic Assets → Keys → Create Key**, or with the API below; where the private keys live is set by the [KMS provider](../operate/kms.md).

**Prerequisites:** the `issuance:manage`, `presentation:manage` or `keys:manage` role.

## Usage types

| `usageType`   | Signs                                                                                          | Web Client option                 |
| ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| `access`      | Presentation requests (it determines the `client_id`), signed issuer metadata, ISO 18013-7 `readerAuth` | Access Certificate                |
| `accessToken` | The access tokens of EUDIPLO's [authorization servers](../issuance/authorization-servers.md) ([details](#access-token-key-chain)) | Access Token Signing              |
| `attestation` | Issued credentials (SD-JWT VC and mDOC)                                                        | Credential Signing (Attestation)  |
| `statusList`  | Status lists for [revocation](../issuance/revocation.md)                                       | Status List Signing               |
| `trustList`   | [Trust lists](trust-lists.md) you publish                                                      | Trust List Signing                |
| `federation`  | The [OpenID Federation entity configuration](federation.md#publish-your-entity-configuration) of the tenant | OpenID Federation Entity Key      |

`encrypt` is reserved for the tenant's encryption key, which EUDIPLO creates and manages itself. It is not listed with the other key chains, and the key chain endpoints do not change it: updating, rotating, deleting, exporting or creating a CSR for its ID answers `404`, and an import with its ID answers `409`. Configuration bundles leave it out and skip a document with its ID ([Config Bundle Format](../reference/config-bundle-format.md#import-modes-and-plan-actions)).

## Key chain types

| Type              | Created with                                                         | Certificate                                                                                                   | On rotation                                    |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Standalone        | `POST /api/key-chain` with `"type": "standalone"`                    | Self-signed; subject is the tenant name, DNS name the host of `PUBLIC_URL`                                     | New key with a new self-signed certificate     |
| Internal chain    | `POST /api/key-chain` with `"type": "internalChain"`                 | EUDIPLO creates a root CA (valid 10 years) and a leaf certificate signed by it                                | New leaf key signed by the same root           |
| Imported key      | `POST /api/key-chain/import` with `"type": "standalone"`             | Your chain from `crt` (leaf first), or a self-signed certificate valid 365 days if `crt` is omitted                           | New key with a self-signed certificate (see warning below) |
| External CA chain | `POST /api/key-chain/import` with `"type": "internalChain"`          | `key` is your CA key and the last `crt` entry its CA certificate, or a self-signed CA certificate EUDIPLO creates if `crt` is omitted; EUDIPLO generates leaf keys signed by it | New leaf key signed by your CA                 |

In the Web Client, attestation and status list keys offer **Create Key Chain** (internal chain), **Standalone Key** and **External CA Chain** (external CA chain; the last certificate must be the CA certificate); access keys offer **Self-Signed Certificate**, **Registrar Enrollment** ([Registrar](registrar.md)) and **External Certificate**. Standalone Key and the other usage types except OpenID Federation Entity Key and Access Token Signing, which are always created, offer an external certificate with **Use a certificate from an external CA**. For an external certificate, choose **Import a key and the certificate chain issued for it**, or **Create the key in EUDIPLO and request its certificate with a CSR** ([details](#request-a-certificate-with-a-csr)). Create Key Chain and External CA Chain rotate the signing key by default; with **Enable automatic key rotation** off, the signing certificate expires after **Certificate Validity** and is renewed only once you turn rotation on by editing the key chain. The other options create key chains without rotation. When EUDIPLO creates the key, **Signing Algorithm** offers the algorithms of the selected KMS provider, starting with its default; imported keys keep the algorithm of their curve, and Registrar Enrollment uses the provider default. The wizard accepts pasted PEM values and PEM, CRT, CER or DER files; EUDIPLO checks that key and certificate match.

Use an internal or external CA chain for attestation and status list keys: trust lists publish the CA certificate, so entries stay valid when the leaf key rotates.

## Create a key chain

```bash
curl -X POST "$EUDIPLO_URL/api/key-chain" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "usageType": "attestation",
    "type": "internalChain",
    "description": "Membership signing key",
    "rotationPolicy": { "enabled": true, "intervalDays": 90, "certValidityDays": 365 }
  }'
```

The response is `{ "id": "<key chain id>" }`. `kmsProvider` selects a provider ID from `kms.json`; without it the default provider is used. `alg` selects the signing algorithm and with it the curve: `ES256` (P-256, the default), `ES384` (P-384) or `ES512` (P-521), as far as the provider offers it ([signing algorithms](../operate/kms.md#signing-algorithms)). The root CA and every rotated key use the same algorithm; `GET /api/key-chain/{id}` returns it as `alg`. Wallets only have to support `ES256`. `certValidityDays` defaults to 365. `intervalDays` is required when `rotationPolicy.enabled` is `true`; without rotation the key is only rotated on request.

`GET /api/key-chain/{id}` and `GET /api/key-chain` return the active key's public key as a JWK in `activePublicKey` (after a rotation, the old one in `previousPublicKey`), without private key material. In the Web Client, **Copy Public Key (JWK)** next to a key's certificate copies it.

## Import a key and certificate

Import material issued by your own PKI or an ecosystem operator with `POST /api/key-chain/import`. Provide exactly one of `key` (EC private key as JWK) or `keyPem` (PKCS#8 PEM). The key may be on P-256, P-384 or P-521; its curve sets the key chain's algorithm (`ES256`, `ES384` or `ES512`), which must be one the provider offers:

```json
{
    "usageType": "access",
    "description": "Access certificate from the ecosystem operator",
    "keyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "crt": [
        "-----BEGIN CERTIFICATE-----\n<leaf>\n-----END CERTIFICATE-----",
        "-----BEGIN CERTIFICATE-----\n<intermediate>\n-----END CERTIFICATE-----"
    ]
}
```

For an imported key, the first certificate must contain the public key of the imported private key. For an **external CA chain**, add `"type": "internalChain"` and pass the CA key and a chain whose last certificate is the CA certificate (`CA=true`, matching the key); the certificates before it are not used. EUDIPLO then creates the signing leaf itself, and rotates it with `"rotationPolicy": { "enabled": true, "intervalDays": 30, "certValidityDays": 365 }`. With rotation enabled, a missing `intervalDays` becomes 90 and a missing `certValidityDays` 365; without rotation, no intervals are stored. For an external CA chain, `certValidityDays` (default 365) also sets the validity of the first signing certificate, with or without rotation.

Without `type`, as in files written before 10.0, the import decides from `rotationPolicy`: with rotation enabled it is an external CA chain, unless `crt` is one self-signed certificate that is not a CA (the export of a standalone key chain); otherwise it is an imported key.

To provision key chains as files, put the same JSON into `config/<tenant>/key-chains/`; see [Configuration as Code](../operate/configuration-as-code.md). `GET /api/key-chain/{id}/export` returns a key chain in this format, with its `type`, and needs `tenant:admin` or `tenants:manage`. For an internal or external CA chain it contains the CA key and certificate but not the signing key, so its import keeps the CA and creates a new signing key, as a rotation does. For the `db` provider the export contains the private key; for an external KMS only the public key, because the private key never leaves the KMS, so that file cannot be imported again. **Download configuration** on a key's page in the Web Client saves `GET /api/config-bundles/resources/KeyChain/{id}/document` instead: a document that also contains the signing key of a CA chain, so its import keeps both keys ([single resources](../reference/config-bundle-format.md#single-resources)). For 9.x exports, see the [10.0 upgrade guide](../upgrade/9.x-to-10.0.md#configuration-files). A startup import does not apply an unchanged file again and so renews no certificate ([details](../reference/config-bundle-format.md#import-modes-and-plan-actions)).

## Request a certificate with a CSR

To keep the private key in EUDIPLO, in its KMS, and still get the certificate from your own CA or an ecosystem operator, create a standalone key chain and send your CA a certificate signing request (CSR) for it:

1. Create a standalone key chain without rotation, as above with `"type": "standalone"`. Until step 3 it has a self-signed certificate.
2. Create the CSR. `subject` is the distinguished name your CA should certify; without it, the subject is `CN=<key chain id>`. EUDIPLO encodes the attributes in the order you write them, so write them in certificate order, country first.

    ```bash
    curl -G "$EUDIPLO_URL/api/key-chain/$KEY_ID/csr" \
      -H "Authorization: Bearer $TOKEN" \
      --data-urlencode "subject=C=DE, O=Example Org, CN=Example Verifier"
    ```

    The response is `{ "csr": "-----BEGIN CERTIFICATE REQUEST-----\n..." }`, a PKCS#10 request signed by the active key. A subject that is not a distinguished name or is longer than 1024 characters is refused with `400`.

3. Store the certificate your CA issued, leaf first, followed by any issuing certificates:

    ```bash
    curl -X PUT "$EUDIPLO_URL/api/key-chain/$KEY_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      --data '{ "activeCertificate": "-----BEGIN CERTIFICATE-----\n<leaf>\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n<intermediate>\n-----END CERTIFICATE-----" }'
    ```

    EUDIPLO refuses with `400` a value without a PEM certificate, a first certificate that does not hold the public key of the active key, such as one issued for a CSR from before a rotation, and a chain in which a certificate did not issue the one before it. Wallets validate the chain in that order.

In the Web Client, the page of a standalone or imported key chain, except an OpenID Federation entity key, has the card **Certificate from an External CA** for steps 2 and 3: **Request Certificate from External CA**, **Create CSR**, then **Copy CSR** or **Download CSR**, and **Store Certificate** for the issued chain. For a key chain managed by a configuration file, add the issued chain to `crt` in that file instead. To renew the certificate, create a new CSR for the same key and store the new certificate; do not rotate the key chain.

## Rotate keys

- **Automatic:** once a day, every key chain with `rotationPolicy.enabled` and an `intervalDays` that has passed since creation or the last rotation is rotated.
- **Manual:** `POST /api/key-chain/{id}/rotate` rotates immediately (`204`).
- **Change the policy:** `PUT /api/key-chain/{id}` with `rotationPolicy` or `description`. Enabling rotation needs `intervalDays`, unless the key chain already has one.

Rotation creates a new key and certificate as listed in the table above. The JWKS of an authorization server keeps the previous key of its access token key chain for one access token lifetime after the rotation, so tokens signed just before stay valid. Credentials issued before keep their certificate chain in `x5c`; with an internal or external CA chain, old and new credentials chain to the same CA, so trust lists need no update.

:::warning[Rotating imported keys]
Rotating a standalone or imported key chain replaces its certificate with a self-signed one. Do not rotate key chains whose certificate comes from a registrar or an external PKI; import the renewed key and certificate, [request a renewed certificate with a CSR](#request-a-certificate-with-a-csr), or use an external CA chain.
:::

## Access token key chain

The hosted [authorization servers](../issuance/authorization-servers.md) (built-in, chained and OID4VP) sign their access tokens only with a key chain of usage type `accessToken`, never with the access certificate or a credential signing key. Only EUDIPLO verifies these tokens, with the keys in the authorization server's JWKS (`/.well-known/jwks.json/issuers/{tenant}` for the built-in server), so the key chain needs no certificate from a CA.

An authorization server uses, in this order:

1. The key chain in `token.signingKeyId` of its entry. In the Web Client, choose it as **Access Token Signing Key** of the authorization server in the issuance configuration; the list offers only access token key chains.
2. The `accessToken` entry of the tenant's key chain defaults. It is set only in a [config folder or bundle](../operate/configuration-as-code.md), as `accessToken` in `key-chain-defaults.json`, for example `{ "accessToken": "my-token-key" }`; the star in the Web Client and `PUT /api/key-chain/access/default` set only the `access` entry.
3. The tenant's access token key chain created first (by creation time, then ID).
4. Without any, EUDIPLO creates a standalone key chain with ID `access-token` on the first token request, with the tenant's default KMS provider. Its key in the KMS gets a random name, so tenants that share a KMS never share or delete each other's key. A JWKS requested before that is empty.

A named key chain that does not exist or has another usage type is never replaced by another one:

- Saving an issuance configuration whose `token.signingKeyId` names one answers `400`.
- A configuration bundle or config folder reports `MISSING_RESOURCE_REFERENCE` for a missing key chain and `KEY_CHAIN_USAGE_MISMATCH` for another usage type, for `token.signingKeyId` and for the `accessToken` entry of the key chain defaults. A `token.signingKeyId` of another usage type that the stored issuance configuration already has gets only a warning, so an unchanged folder still imports; a missing key chain is still reported.
- A configuration stored before 10.0, which can only name another usage type, fails the token requests of that authorization server with `500` while the backend log names the key chain. Remove the value or choose an access token key chain.

If a key chain with ID `access-token` and another usage type exists, EUDIPLO cannot create its key chain; token requests then fail and the log says so until you create an access token key chain.

The JWKS publishes the active key and, for one access token lifetime of that authorization server after a [rotation](#rotate-keys), the previous key. To replace the key, rotate the key chain with `POST /api/key-chain/{id}/rotate`, or create another access token key chain and choose it; tokens signed with the old key fail once it has left the JWKS.

## Delete a key chain

`DELETE /api/key-chain/{id}` answers `204` and, where the KMS provider supports it, also deletes the key in the KMS. It answers `409` while a configuration of the tenant names the key chain, because that configuration could no longer sign or publish the key chain's certificate. These fields count:

- an entry of the tenant's key chain defaults, `access` ([Default access key chain](#default-access-key-chain)) or `accessToken` ([Access token key chain](#access-token-key-chain)),
- `token.signingKeyId` of each authorization server of the issuance configuration,
- `keyChainId` of a credential configuration,
- `accessKeyChainId` of a presentation configuration,
- `keyChainId` of a status list,
- `keyChainId` of a [trust list](trust-lists.md), which the key chain signs, and `issuerKeyChainId` or `revocationKeyChainId` of its internal entities. Deleting the signing key chain would also delete the trust list.

A configuration that leaves the field out uses the tenant's default key chain of the usage type and does not count, so a default key chain picked by rule can be deleted; such configurations then use another key chain of that usage type, or fail until one exists. Authorization servers use another access token key chain, or a new `access-token` key chain if none is left ([Access token key chain](#access-token-key-chain)). Trust lists are the exception: a trust list created without `keyChainId` stores the trust list key chain picked at creation, so that key chain counts until the trust list is deleted, also when a bundle rewrites the trust list without `keyChainId`.

The response names the configurations in `message` and lists them in `references`. An entry of the key chain defaults is a reference of kind `KeyChainDefaults`, without ID. Configurations the caller's roles cannot read are only counted, without ID and description: the issuance configuration, credential configs and status lists need `issuance:manage`, presentation configs `presentation:manage` or `presentation:request`, and trust lists `issuance:manage` or `presentation:manage`.

```json
{
    "statusCode": 409,
    "timestamp": "2026-10-17T12:00:00.000Z",
    "path": "/api/key-chain/pid-signing",
    "code": "KEY_CHAIN_IN_USE",
    "message": "Key chain \"pid-signing\" is still used by the issuance configuration and 1 credential config (\"pid\"). Remove these references before deleting the key chain.",
    "references": [
        { "kind": "IssuanceConfig" },
        { "kind": "CredentialConfig", "id": "pid", "description": "Personal ID" }
    ]
}
```

Point the configurations to another key chain, or remove the field, then delete the key chain. In the Web Client, deleting a key chain from the key list or its page shows this message; the tenant's default access key chain is refused before any request, with a note to stop using it as default first. An unknown ID answers `404`. Sessions that are already running are not checked; an OpenID4VP request whose key chain is deleted before the wallet fetches it cannot be used ([Default access key chain](#default-access-key-chain)).

A [configuration bundle](../operate/configuration-as-code.md#plan-and-import) or a [config folder](../operate/configuration-as-code.md#provision-tenants-from-a-folder) imported in `replace` mode deletes a key chain that it created and no longer contains. Its plan is blocked with `KEY_CHAIN_IN_USE` on that key chain while a configuration that survives the import names it by the rules above: a stored configuration the import neither deletes nor rewrites, or a document of the bundle with its new content. A document of the bundle that names the key chain is also blocked with `MISSING_RESOURCE_REFERENCE`. Keep the key chain in the bundle, or remove the references, then plan again.

## Certificates

Certificates always belong to a key chain. Which one a wallet or verifier has to trust depends on its use:

| Certificate                 | Who checks it                                                                 | Typical source                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Access certificate          | Wallets, when they receive a presentation request or signed issuer metadata    | Self-signed for development; registrar or ecosystem operator for production ([wallet requirements](wallet-registrars.md)) |
| Attestation certificate     | Wallets and verifiers, through the `x5c` chain in each credential and a trust list | Internal or external CA chain; your issuer PKI                                              |
| Status list certificate     | Verifiers, as the revocation certificate of your trust list entry             | Internal or external CA chain; standalone                                                       |
| Trust list certificate      | Consumers of your trust list, who pin it as `verifierX509Der`                  | Standalone or internal chain                                                                    |

A presentation configuration uses the access key chain in `accessKeyChainId`, or the default access key chain when it is not set. Registration certificates are JWTs issued by a registrar, not key chains; see [Registration Certificates](registration-certificates.md).

### Default access key chain

Presentation requests (OID4VP and ISO 18013-7) of a configuration without `accessKeyChainId`, signed issuer metadata and the link of a registration certificate to its access certificate use the tenant's default access key chain. A presentation configuration's `accessKeyChainId` always takes precedence; the issuer metadata has no such field, so all issuance of a tenant uses the default.

To choose the default, set `access` of the tenant's key chain defaults:

- In the Web Client, select the star (**Use as default access key chain**) on an access key chain in the key list or on its page. The list marks the default with **Default**, or with **Default by rule** while none is set. Select the star again to remove the setting.
- Through the API, `PUT /api/key-chain/access/default` with `{"defaultAccessKeyChainId": "<id>"}`, or `null` to remove it; `GET` returns the setting and the key chain in use (`keyChainId`). Both need `issuance:manage`, `presentation:manage` or `keys:manage`.
- In a [config folder or bundle](../operate/configuration-as-code.md), as `access` in `key-chain-defaults.json` next to `info.json` (resource `KeyChainDefaults/defaults`, [format](../reference/config-bundle-format.md#resource-types-and-versions)), for example `{ "access": "registrar-access" }`. The file may name a key chain of the same folder. A file without `access` removes the setting, and a `replace` import without the file deletes defaults it applied before. If it names no access key chain of the tenant, the plan is blocked with `MISSING_RESOURCE_REFERENCE` or `KEY_CHAIN_USAGE_MISMATCH`: a bundle import is refused, and at startup the import of that tenant's folder fails while the log names the key chain; the stored setting stays. While the file is file-managed, the API and the Web Client cannot change the setting: [detach](../operate/configuration-as-code.md#configuration-model) `KeyChainDefaults/defaults` first. Startup imports then skip the file until you reset it to the file version. The tenant settings in `info.json` stay file-managed.

The key chain must belong to the tenant and have usage type `access`, else the request answers `400`. While it is the default, deleting it is refused with `KEY_CHAIN_IN_USE` ([Delete a key chain](#delete-a-key-chain)). If it is gone anyway, requests that need the default fail instead of falling back to another certificate; the backend log names the key chain, `GET /api/key-chain/access/default` returns the setting without `keyChainId`, and the Web Client's key list shows a warning with **Remove default**.

Without the setting, EUDIPLO picks one of the tenant's access key chains in this order:

1. A certificate that is valid now before an expired or not yet valid one, which could not sign.
2. The kind of the active certificate: one issued by another CA, such as a registrar certificate or that of an imported key, before an internal chain (an External CA chain included), before a self-signed certificate.
3. The key chain created first.

A new access key chain therefore only becomes the default when its certificate is of a better kind, or when the certificate of the current default is no longer valid. To use a particular key chain, set the default access key chain, or `accessKeyChainId` for one presentation configuration.

An OpenID4VP request keeps the access key chain chosen when it was created: the request object a wallet fetches later is signed with the key chain its `client_id` was derived from, even when the default or the configuration's `accessKeyChainId` has changed in between. Its registration certificate is resolved for that key chain as well; see [Registration Certificates](registration-certificates.md#validation-and-caching). If that key chain is deleted or rotated before the wallet fetches the request, the wallet cannot use the request; create a new one.

### Revocation check

Before a key chain signs, EUDIPLO checks that its leaf certificate is within its validity period and, if the certificate names a CRL distribution point, that the CRL does not list it. A key chain whose certificate is expired or revoked does not sign, and the requests that need it fail.

CRLs are usually served over plain HTTP, so a CRL only counts if it names the leaf's issuer and is signed by the issuing CA certificate. EUDIPLO looks for that certificate in the key chain: the certificates after the leaf in `crt` of an import or in `activeCertificate` of `PUT /api/key-chain/{id}`, or the root CA certificate of an internal or external CA chain. If the issuing CA certificate is not there, or no CRL can be fetched or passes these checks, EUDIPLO logs a warning and keeps signing. Self-signed certificates are not checked against a CRL, because no CA can revoke them. Certificates that EUDIPLO creates name no CRL distribution point.
