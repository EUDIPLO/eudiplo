---
title: Configure the issuer
sidebar_label: Issuance configuration
---

Set the issuer-wide settings of a tenant: how the issuer is shown in wallets, which authorization servers it offers, and how its token and credential endpoints behave. Each tenant has exactly one issuance configuration; credential types are configured separately in [credential configurations](credential-configuration.md).

**Prerequisites:** a client with the `issuance:manage` role. In the web client, open **Credential Issuance → Issuer Settings**.

## 1. Write the configuration

```json
{
    "display": [
        {
            "name": "Membership Demo",
            "locale": "en-US",
            "logo": { "uri": "https://issuer.example.com/logo.png", "alt_text": "Logo" }
        }
    ],
    "authorizationServers": [{ "type": "built-in", "id": "issuer-built-in" }],
    "batchSize": 10,
    "dPopRequired": true,
    "offerLifetimeSeconds": 900
}
```

## 2. Store it

```bash
curl -X POST "$EUDIPLO_URL/api/issuer/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @issuance.json
```

`POST /api/issuer/config` creates the configuration or updates it field by field: each top-level field you send replaces the stored value as a whole (an `authorizationServers` array replaces all servers), fields you leave out keep their stored value, and `null` clears the settings that accept it (`federation`, `registrationCertificate`, `txCodeMaxAttempts`, `offerLifetimeSeconds`). `GET /api/issuer/config` returns it and creates a default one (a single built-in authorization server) if none exists. To manage it as a file, see [Configuration as code](../operate/configuration-as-code.md).

**Check:** `GET /.well-known/openid-credential-issuer/issuers/{tenant}` shows your `display`, the `authorization_servers` and the endpoints.

## Settings

| Field | Default | Effect |
| --- | --- | --- |
| `display` | none | Issuer name and logo per locale, published as `display` in the credential issuer metadata. Logos use `uri`; to host them in EUDIPLO, see [Object storage](../operate/object-storage.md). |
| `authorizationServers` | built-in server | Required, at least one entry. See [Authorization servers](authorization-servers.md). |
| `batchSize` | `1` | Batch issuance: how many credentials (one per key proof) a wallet may request at once. Values above 1 are published as `batch_credential_issuance.batch_size`. A key attestation proof may carry up to `batchSize` keys. |
| `dPopRequired` | `true` | Require DPoP-bound access tokens at the built-in token endpoint and the credential, deferred credential and notification endpoints. See [DPoP](authorization-servers.md#dpop). |
| `credentialRequestEncryption` | `false` | Sets `encryption_required` of `credential_request_encryption`; plain credential requests are then rejected. |
| `credentialResponseEncryption` | `false` | Sets `encryption_required` of `credential_response_encryption`; requests without response encryption are then rejected. |
| `notificationEndpointEnabled` | `true` | Publish and serve the [notification endpoint](notifications.md). |
| `txCodeMaxAttempts` | `5` | Failed transaction code attempts before a pre-authorized code is invalidated. `null` restores the default. See [Transaction code](credential-offers.md#transaction-code). |
| `offerLifetimeSeconds` | unset | Default lifetime of credential offers (9.0). Unset or `null`: offers do not expire. Offers can override it. See [Lifetime and expiry](credential-offers.md#lifetime-and-expiry). |
| `walletAttestationRequired`, `walletProviderTrustLists` | `false`, none | Defaults for wallet attestation at EUDIPLO's authorization servers; the trust lists also validate key attestations at the credential endpoint. See [Wallet and key attestation](../trust/attestation.md). |
| `walletAttestationStatusCheckMode` | unset (`best_effort`) | How the status list of a key attestation is checked at the credential endpoint, and default for wallet attestations at the authorization servers: `strict`, `best_effort` or `disabled`. `null` restores the default. See [Wallet and key attestation](../trust/attestation.md#2-require-wallet-attestation) and [key attestation](../trust/attestation.md#3-require-key-attestation). |
| `federation` | none | See [OpenID Federation](../trust/federation.md). |
| `registrationCertificate` | none | Publish a registration certificate in `issuer_info`. See [Registration certificates](../trust/registration-certificates.md). |

### Encryption flags

EUDIPLO always advertises `credential_request_encryption` (its encryption key with `kid` and `alg` `ECDH-ES`, `enc` `A128GCM` or `A256GCM`) and `credential_response_encryption` (`alg` `ECDH-ES`, `enc` `A128GCM` or `A256GCM`). The two flags set `encryption_required` in these objects, and the credential and deferred credential endpoints enforce it. Set them only if every wallet you serve supports encryption.

A wallet that wants an encrypted response must also encrypt its request: a plain request with `credential_response_encryption` is rejected with `invalid_encryption_parameters`. So `credentialResponseEncryption: true` in effect requires encryption in both directions. An encrypted request names the advertised key with `kid` in the JWE header and uses that key's `alg` (`ECDH-ES`) and an `enc` of `A128GCM` or `A256GCM`; other headers are rejected with `invalid_encryption_parameters`. An encrypted response names the wallet's key in the JWE header `kid` when that key has one.

The same rules apply when the wallet polls the deferred credential endpoint: it may send `{"transaction_id": "…"}` encrypted (`application/jwt`) and gets the credential back encrypted when the encrypted request carries `credential_response_encryption`. With `credentialRequestEncryption`, every poll must be encrypted; with `credentialResponseEncryption`, every poll must also carry `credential_response_encryption`. Errors such as `issuance_pending` stay plain JSON. See [Deferred issuance](deferred-issuance.md).
