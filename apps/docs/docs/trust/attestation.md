---
title: Wallet and Key Attestation
---

During issuance, EUDIPLO can check two statements signed by the wallet provider: a wallet attestation, which proves that the wallet app is a genuine instance of a trusted wallet, and a key attestation, which describes how the holder keys are protected. Both are trusted through wallet-provider trust lists.

|                    | Wallet attestation                                                                                         | Key attestation                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Proves             | The wallet, as OAuth client, is an app of a trusted wallet provider                                         | The holder keys and their storage and user-authentication level                  |
| Checked at         | PAR and token endpoints of EUDIPLO-managed authorization servers (`built-in`, `chained`, `oid4vp`)          | Credential endpoint, including deferred issuance                                 |
| Required by        | `walletAttestationRequired` of the authorization server, else of the issuance configuration                 | Proof types allowed by the credential configuration (`config.proofTypesSupported`) |
| Trusted through    | `walletProviderTrustLists` of the authorization server, else of the issuance configuration                  | `walletProviderTrustLists` of the issuance configuration only                     |

## 1. Provide wallet-provider trust lists

Wallet-provider trust lists are LoTE JWTs whose entities offer the service types `http://uri.etsi.org/19602/SvcType/WalletSolution`, `.../WalletSolution/Issuance` or `.../WalletSolution/Revocation`. Reference them like any [trust list](trust-lists.md):

- **External list**, for example the wallet provider list published for your ecosystem: `{ "url": "https://...", "verifierX509Der": "MIIB..." }` (or `verifierKey`). Obtain the verification certificate through a trusted channel; it authenticates the list, not the providers in it.
- **Managed list** of this tenant: `{ "trustListId": "wallet-providers" }`. Create it under **Trust Lists** and set **Provider type → Wallet provider** on each entity (`"providerType": "wallet-provider"`). EUDIPLO then publishes `WalletSolution/Issuance` and `WalletSolution/Revocation` services; a list with only wallet-provider entities uses the wallet-provider scheme of ETSI TS 119 602 Annex E. If wallet and key attestations are signed by different provider CAs, list both.

Put the lists into the issuance configuration so that both checks can use them:

```json
{
    "walletProviderTrustLists": [{ "trustListId": "wallet-providers" }],
    "authorizationServers": [
        { "type": "built-in", "id": "issuer-built-in", "walletAttestationRequired": true }
    ]
}
```

Merge these fields into your issuance configuration ([Issuance Configuration](../issuance/issuance-configuration.md)). A presented wallet or key attestation without a configured trust list is always rejected; plain holder proofs without key attestation need no trust list.

## 2. Require wallet attestation

When wallet attestation is used, the wallet sends two headers to the PAR and token endpoints, following [OpenID4VCI Appendix E](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#appendix-E):

- `OAuth-Client-Attestation`: the attestation JWT signed by the wallet provider, with its certificate chain in `x5c` and the wallet instance key in `cnf`,
- `OAuth-Client-Attestation-PoP`: a proof of possession signed with that instance key.

EUDIPLO verifies both signatures, builds a certificate path from `x5c` to a wallet provider in the trust lists and, if the attestation has a `status` claim, rejects revoked or suspended attestations. If the status list cannot be fetched, the error is logged and the attestation is accepted.

Each EUDIPLO-managed authorization server resolves two settings independently:

| Setting                     | Value used                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `walletAttestationRequired` | The authorization server's value, else the issuance configuration's, else `false`    |
| `walletProviderTrustLists`  | The authorization server's list, else the issuance configuration's, else none        |

With `true`, requests without attestation are rejected; with `false`, a wallet may omit it, but an attestation it sends must still be valid and trusted. An empty list on the authorization server disables inheritance and rejects every presented attestation. The authorization server metadata advertises `attest_jwt_client_auth` only when attestation is required. In the Web Client, the authorization server settings offer **Use issuer default** and **Use shared wallet provider trust lists**. An external authorization server checks wallets according to its own configuration.

## 3. Require key attestation

Key attestations are configured per credential type, in the credential configuration's `config`:

```json
{
    "config": {
        "proofTypesSupported": ["attestation"],
        "keyAttestationsRequired": {
            "key_storage": ["iso_18045_high"],
            "user_authentication": ["iso_18045_high"]
        }
    }
}
```

- `proofTypesSupported` limits the accepted proof types, `jwt` and `attestation` (default: both). A proof of another type is rejected with `invalid_proof`.
- `keyAttestationsRequired` is published as `key_attestations_required` for every supported proof type in the issuer metadata; an empty object announces a key attestation without constraints. EUDIPLO does not check the attested levels against it.

Wallets send key attestations in two ways:

- **`attestation` proof** (`proofs.attestation`): the key attestation JWT itself. EUDIPLO issues one credential per key in its `attested_keys`, at most the issuance `batchSize`.
- **`jwt` proof with `key_attestation` header**: a holder proof whose signing key must be one of the attested keys.

Every presented key attestation must be signed by a wallet provider in the issuance-level `walletProviderTrustLists`; lists on an authorization server are not used for keys. A `jwt` proof without `key_attestation` is accepted even when `keyAttestationsRequired` is set. To require a key attestation, allow only the `attestation` proof type.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Wallet attestation is required but not provided`              | The wallet sends no attestation headers. Use a wallet that supports wallet attestation, or set `walletAttestationRequired: false`. |
| `No wallet provider trust lists configured ...`                | Neither the authorization server nor the issuance configuration has `walletProviderTrustLists` (for key attestations: the issuance configuration). |
| `... signer is not trusted by configured wallet provider trust lists` | The provider's certificate is not in the lists, or listed without a `WalletSolution` service type.             |
| `Wallet attestation verification failed: ...` or `Attestation proof x5c chain could not be validated` | Often a trust list problem: the list cannot be fetched or its signature does not match `verifierX509Der`/`verifierKey`. Check the server log for the reason. |
