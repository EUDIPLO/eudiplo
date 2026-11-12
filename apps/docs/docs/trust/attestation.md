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

Wallet-provider trust lists are LoTE JWTs whose entities offer the service types `http://uri.etsi.org/19602/SvcType/WalletSolution`, `.../WalletSolution/Issuance` or `.../WalletSolution/Revocation`. In an `EUWalletProvidersList` where no service has a type, every service counts as `WalletSolution/Issuance` ([Service status and type](trust-lists.md#service-status-and-type)). Wallet and key attestations must be signed under a certificate listed as `WalletSolution` or `WalletSolution/Issuance`; a certificate listed only as `WalletSolution/Revocation` signs status lists, not attestations. A certificate the list names takes the place of a certificate in the attestation's `x5c` with the same subject and key. When the list names several such certificates, for example a provider's CA and its renewal, attestations are chained to the one that is currently valid, whichever the list names first. A list without a valid `NextUpdate`, or whose `NextUpdate` has passed, is discarded like every [trust list](trust-lists.md#how-a-trust-list-is-used): providers listed only in it are not trusted, providers in the other lists still are. Reference the lists like any [trust list](trust-lists.md):

- **External list**, for example the wallet provider list published for your ecosystem: `{ "url": "https://...", "verifierX509Der": "MIIB..." }`. Instead of the certificate, you can pin the signer's public key: as a JWK in `verifierKey`, or as a PEM public key (`-----BEGIN PUBLIC KEY-----`) in `verifierKeyPem`. The Web Client asks only for the certificate, as PEM or Base64 DER, and stores it as `verifierX509Der`; a public key already on an entry is kept until you enter a different certificate, and while it is there EUDIPLO verifies the list with the key only. Obtain this material through a trusted channel; it authenticates the list, not the providers in it.
- **Managed list** of this tenant: `{ "trustListId": "wallet-providers" }`. Create it under **Trust Lists** and set **Provider type → Wallet provider** on each entity (`"providerType": "wallet-provider"`). EUDIPLO then publishes `WalletSolution/Issuance` and `WalletSolution/Revocation` services; a list with only wallet-provider entities uses the wallet-provider scheme of ETSI TS 119 602 Annex E. In the Web Client, **Add managed trust list** offers the lists of the tenant that have a wallet provider entity; a list without one cannot match any attestation. If wallet and key attestations are signed by different provider CAs, list both.

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

EUDIPLO verifies both signatures, builds a certificate path from `x5c` to a wallet provider in the trust lists, requires every certificate of that path, from the one that signs the attestation to the one the list names, to be within its validity period at the time of the request (both `notBefore` and `notAfter` included, without `CRYPTO_TOLERANCE`) and, if the attestation has a `status` claim, checks its entry in the status list. The status list must be signed under one of the provider's revocation certificates (any of its `WalletSolution/Revocation` services, or else any of its `EAA/Revocation` services), or under the certificate that signs its attestations if the provider lists neither. It must also be typed `statuslist+jwt`, carry the attestation's status list URI as `sub`, have an `iat`, not be past its `exp` (allowing `CRYPTO_TOLERANCE` seconds of clock skew) and contain the attestation's index ([Token Status List, Section 8.3](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-status-list#section-8.3)). A list that decompresses to more than 16 MiB is rejected. `walletAttestationStatusCheckMode` decides what happens when the check fails or cannot be completed:

| Mode                    | Revoked or suspended | Status list cannot be fetched (network error, timeout, non-2xx, blocked URL) | Status list unreadable, not the named list, expired, index outside the list |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `strict`                | Rejected             | Rejected                                                                     | Rejected                                       |
| `best_effort` (default) | Rejected             | Accepted, with a warning in the log                                          | Rejected                                       |
| `disabled`              | Accepted             | Accepted, the list is not fetched                                            | Accepted                                       |

A status list signed by another key is rejected unless the mode is `disabled`, and so is a malformed `status` claim: one that is not a JSON object, an empty object, or one whose `status_list` is not an object with a `uri` that is an absolute URI and a non-negative integer `idx`. An attestation without a `status` claim is accepted in every mode, as is one whose `status` claim has no `status_list` (another status mechanism, which EUDIPLO does not check).

Each EUDIPLO-managed authorization server resolves three settings independently:

| Setting                            | Value used                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `walletAttestationRequired`        | The authorization server's value, else the issuance configuration's, else `false`    |
| `walletProviderTrustLists`         | The authorization server's list, else the issuance configuration's, else none        |
| `walletAttestationStatusCheckMode` | The authorization server's value, else the issuance configuration's, else `best_effort` |

With `true`, requests without attestation are rejected; with `false`, a wallet may omit it, but an attestation it sends must still be valid and trusted. An empty list on the authorization server disables inheritance and rejects every presented attestation. The authorization server metadata advertises `attest_jwt_client_auth` only when attestation is required. In the Web Client, the authorization server settings offer **Use issuer default** (for **Wallet Attestation** and **Wallet Attestation Status Check**) and **Use shared wallet provider trust lists**. An external authorization server checks wallets according to its own configuration.

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
- `keyAttestationsRequired` is published as `key_attestations_required` for every supported proof type in the issuer metadata and enforced at the credential endpoint:
    - Every proof must carry a key attestation: an `attestation` proof or a `jwt` proof with `key_attestation`.
    - Every key the proof proves must be listed in the attestation's `attested_keys`.
    - For a non-empty `key_storage` or `user_authentication` list, the attestation must state at least one of the listed values in the claim of the same name.

    An empty object requires a key attestation without level constraints; empty lists add no constraint and are not published. A proof that fails is rejected with `invalid_proof`. Without `keyAttestationsRequired`, a key attestation is optional.

Wallets send key attestations in two ways:

- **`attestation` proof** (`proofs.attestation`): the key attestation JWT itself. EUDIPLO issues one credential per key in its `attested_keys`, at most the issuance `batchSize`.
- **`jwt` proof with `key_attestation` header**: a holder proof whose signing key must be one of the attested keys.

Every presented key attestation must be signed by a wallet provider in the issuance-level `walletProviderTrustLists`, whether it is required or not; lists on an authorization server are not used for keys. The certificates of its path must be within their validity period, as for a [wallet attestation](#2-require-wallet-attestation).

If a key attestation has a `status` claim, its status list entry is checked like that of a [wallet attestation](#2-require-wallet-attestation), in the issuance configuration's `walletAttestationStatusCheckMode` (default `best_effort`): the same signer rules, the same checks of the list and the same table of modes. A rejected key attestation answers `invalid_proof` with a message that starts with `Key attestation` instead of `Wallet attestation`. In the EUDI Wallet, the key attestation is the wallet unit attestation (WUA), and its status list says whether the wallet provider revoked the wallet unit.

### Revoke credentials with their wallet unit

A wallet provider revokes a wallet unit attestation when the wallet unit can no longer be trusted, for example after its device was compromised. Credentials issued to that wallet unit should be revoked as well. Set `revokeWithWalletUnit: true` on the credential configuration:

```json
{
    "statusManagement": true,
    "revokeWithWalletUnit": true,
    "config": {
        "keyAttestationsRequired": {}
    }
}
```

In the Web Client, turn on **Revoke with Wallet Unit** under **Credential Features** in the credential configuration's settings. While it is on, **Status Management** and **Require Key Attestation** stay on and cannot be turned off.

- Requires `statusManagement: true` and `config.keyAttestationsRequired`; the API and the configuration import reject it otherwise.
- At issuance, EUDIPLO stores the status list reference (`status.status_list`) and the `x5c` of the key attestation with the status entry of every credential issued for the keys it attests. A key attestation without `status_list`, or with a malformed `status` claim, is not followed.
- Every `WALLET_UNIT_STATUS_CHECK_INTERVAL` seconds (default 3600, `0` turns the check off), and once after startup, EUDIPLO reads the status of every followed wallet unit. The provider must still be in the issuance configuration's `walletProviderTrustLists`, and its status list must pass the checks above. The validity periods of the key attestation's certificates are not checked again, so a wallet unit can still be revoked after they have expired. A fetched list is reused for its `ttl` (5 minutes without one), at most one hour and not past its `exp`.
- When the status is revoked (`1`), EUDIPLO revokes the credentials issued under that wallet unit attestation and sends the [wallet unit revocation webhook](../reference/webhooks.md#wallet-unit-revocation-webhook). Within a run, a status list is verified once per attestation certificate chain and batch of up to 500 credentials. Revocation is final. Other values, such as suspended (`2`), are logged and change nothing.
- When the status cannot be read (the list cannot be fetched or verified, or the provider is no longer in the trust lists), nothing is revoked: the reason is logged as a warning and the next run tries again.
- A credential is no longer checked once it is revoked, has expired (its `lifeTime`, one year for mDOC credentials without one; an mDOC also expires with its signing certificate), or its configuration no longer has `revokeWithWalletUnit`. The setting applies to credentials issued while it is enabled.
- The check does not use `walletAttestationStatusCheckMode`: with `disabled`, issuance accepts revoked key attestations, but their status list reference is still recorded and the check still revokes the credentials once the wallet unit is revoked. Set `revokeWithWalletUnit: false` to stop following it.
- Several instances sharing one database each run the check; a revocation is applied once, but its webhook may be sent by more than one instance.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Wallet attestation is required but not provided`              | The wallet sends no attestation headers. Use a wallet that supports wallet attestation, or set `walletAttestationRequired: false`. |
| `No wallet provider trust lists configured ...`                | Neither the authorization server nor the issuance configuration has `walletProviderTrustLists` (for key attestations: the issuance configuration). |
| `No trusted wallet providers found in configured trust lists` | The lists contain no entity with a `WalletSolution`, `WalletSolution/Issuance` or `WalletSolution/Revocation` service, or all such services are ignored for their `ServiceStatus` or a missing type ([Service status and type](trust-lists.md#service-status-and-type)). Check that you reference the wallet-provider list, not a list of credential issuers. If the message ends with `(... outdated trust list(s) left out ...)`, the providers may be in a list discarded as outdated: `Discarded outdated trust list(s) ...` in the log names it. |
| `Wallet provider certificate is not trusted ...` or `... signer is not trusted by configured wallet provider trust lists` | The provider's certificate is not in the lists, is listed without a `WalletSolution` or `WalletSolution/Issuance` service type (a `WalletSolution/Revocation` service does not sign attestations), or its service is ignored for its `ServiceStatus` or a missing type ([Service status and type](trust-lists.md#service-status-and-type)). If the message ends with `(... outdated trust list(s) left out ...)`, the provider may be listed only in a list discarded as outdated: `Discarded outdated trust list(s) ...` in the log names it. |
| `Wallet attestation certificate chain is not valid: ...` or `Attestation proof certificate chain is not valid: ...` | A certificate of the attestation's path has expired or is not yet valid at the time of the request. The message names it, `Signing certificate` (the one in `x5c` that signs the attestation), `Intermediate certificate` or `Trust list certificate` (the one the wallet-provider list names), with its `notAfter` or `notBefore` and the time of the check. A certificate the list names that signs attestations itself, such as a listed end-entity certificate, is reported as `Signing certificate`. Ask the wallet provider to sign its attestations under a current certificate, or the list's publisher to list a current one; for a listed certificate that signs attestations itself, both. For `is not yet valid`, check the clocks of the server and of the wallet provider. |
| `The credential configuration requires a key attestation ...`  | The wallet sent a `jwt` proof without `key_attestation`. Use a wallet that sends key attestations, or remove `keyAttestationsRequired`. |
| `The key attestation does not state an accepted key_storage value ...` (or `user_authentication`) | The attested level is not in the configured list. Add the level your wallets attest, if it meets your requirements. |
| `The proof contains a key that is not listed in attested_keys ...` | The `jwt` proof is signed with a key the attestation does not cover.                                          |
| `Wallet attestation status check failed` | The attestation's `status` claim is malformed, or the status list could not be fetched (`strict` only), is not a status list JWT, or its signature could not be checked. The server log names the reason, and the list if the claim names one. A malformed claim is a problem of the wallet provider's attestation format. Otherwise, check that the wallet provider serves the list at the `status.status_list.uri` of the attestation. To accept attestations while the list is unreachable, set `walletAttestationStatusCheckMode: "best_effort"`. |
| `Wallet attestation is not valid: ...` | The wallet provider has revoked or suspended this wallet instance. |
| `Status list JWT signature verification failed ...` or `Wallet attestation status list rejected: ...` | The attestation's status list has no `x5c` header or is signed under another certificate than the provider's revocation or attestation certificate, or it is not the list the attestation names (`sub`), has expired, is not typed `statuslist+jwt` or does not contain the index. Add the provider's status list signing certificate to the trust list as a `WalletSolution/Revocation` service, or ask the provider to fix the list. |
| `Key attestation is not valid: ...`, `Key attestation status list rejected: ...` or `Key attestation status check failed` | Answer of the credential endpoint (`invalid_proof`) for the key attestation's status list, with the causes of the rows above for wallet attestations. A status list signed by the wrong certificate answers `Status list JWT signature verification failed ...` here too. |
| `Client attestation validation failed` | `error_description` of the `invalid_client` answer for every rejected wallet attestation at the PAR endpoint of each EUDIPLO-managed authorization server (HTTP 400) and at the token endpoint of chained and OID4VP authorization servers (HTTP 401). The built-in token endpoint answers `invalid_client` with HTTP 401 and, as `error_description`, the reason when it is about the attestation or its provider, such as one of the messages above, and a fixed text when the server failed: `Wallet attestation status check failed` (above) or one of the next two rows. At each of these endpoints, the server log line `Client attestation validation failed for ...: ...` has the reason. |
| `Wallet provider trust lists could not be loaded` or `Attestation proof x5c chain could not be validated` | A wallet-provider list cannot be fetched or read, or its signature does not match `verifierX509Der`, `verifierKey` or `verifierKeyPem`. The credential endpoint also answers its message when the key attestation's header cannot be read or its `x5c` holds a certificate that cannot be parsed. The answer names no list: it reaches the wallet, and the URL of a managed list can name an internal address (`INTERNAL_URL`). For wallet attestations, the log line `Client attestation validation failed for ...: Wallet provider trust lists could not be loaded: ...` names the list and the reason; for key attestations at the credential endpoint, the log line `Key attestation validation failed for tenant ...: Attestation proof x5c chain could not be validated: ...` does. The credential endpoint also answers this text for a wallet-provider reference that defines no `verifierX509Der`, `verifierKey` or `verifierKeyPem` with content, for example one that is only whitespace. |
| `Wallet attestation verification failed` | Answer of the built-in token endpoint for any other server-side failure, for example a `verifierX509Der` that is only whitespace. The log line `Client attestation validation failed for ...: Wallet attestation verification failed: ...` has the reason. With `: ...` after it in the answer, the text gives the reason: about the attestation the wallet sent, for example its signature, audience or expiry, or, with `No configured trust list is current`, every wallet-provider list is outdated (next row). |
| `... No configured trust list is current ...` | Every configured wallet-provider list is outdated: no valid `NextUpdate` or one that has passed, or no valid `LoTESequenceNumber` or a lower one than a list accepted before ([Older versions of a list](trust-lists.md#older-versions-of-a-list)). The built-in token endpoint answers `Wallet attestation verification failed: No configured trust list is current ...`, the credential endpoint `invalid_proof` with this text. `Discarded outdated trust list(s), no current list is left: ...` in the log names the lists. Ask their publisher for current ones; for a managed list, look for `Failed to renew trust list` in the log. |
