---
title: Transaction Data
---

Transaction data binds a presentation to a concrete transaction, such as a payment. The wallet shows it to the user, and the holder's signature over the presentation includes a hash of it, so your backend knows the user approved exactly this transaction. EUDIPLO implements [OpenID4VP transaction data](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-transaction-data) and validates the TS12 strong customer authentication types.

## Add transaction data

Set `transaction_data` in the presentation configuration, or per request in `POST /api/verifier/offer`. Request-level `transaction_data` replaces the configured list for that session; the two are not merged. ISO 18013-7 requests cannot carry transaction data: creating one answers `400` when there are entries to send, so send `"transaction_data": []` to use a configuration with transaction data over ISO 18013-7.

Each entry needs:

| Field            | Description                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `type`           | Transaction data type. Wallets must reject types they do not support, so use one your target wallets know, such as a TS12 type. |
| `credential_ids` | IDs of the DCQL credential queries that may authorize the transaction. Each must be a `dc+sd-jwt` query of the DCQL query ([see below](#which-credentials-an-entry-may-reference)). |
| `transaction_data_hashes_alg` | Optional non-empty array of hash algorithms the wallet may use for this entry, for example `["sha-256", "sha-384"]`. Defaults to `sha-256` only. EUDIPLO can check `sha-256`, `sha-384` and `sha-512`; a hash with another listed algorithm fails. |
| other fields     | Type-specific content. TS12 types put it in `payload`.                                       |

EUDIPLO sends each entry base64url-encoded as JSON in the `transaction_data` parameter of the signed request.

### Which credentials an entry may reference

`credential_ids` tells the wallet which credentials it may authorize the entry with. EUDIPLO checks transaction data only in SD-JWT VC presentations, so every ID must be a `dc+sd-jwt` query: a wallet that authorized with an mDOC would be rejected. Saving the configuration and `POST /api/verifier/offer` answer `400` when an entry:

- names no credential query,
- names an ID that is not a query of the configuration's DCQL query (`transaction_data[<index>].credential_ids names ids that are not in the DCQL query: ...`), or
- names an `mso_mdoc` query (`transaction_data[<index>].credential_ids names credential queries that are not dc+sd-jwt: ...`).

`<index>` is the entry's zero-based position in `transaction_data`. The offer checks the transaction data it sends, so a configuration stored by an earlier version that breaks the rule answers `400` for every request that does not set its own `transaction_data`. In a [configuration bundle](../reference/config-bundle-format.md) or configuration folder, such a presentation configuration fails with `TRANSACTION_DATA_UNCHECKABLE`.

An entry may reference queries that `credential_sets` offer as alternatives. The wallet must then present one of the credentials the entry references and authorize the entry with it; the response fails otherwise (see below).

## TS12 SCA transaction data

Types starting with `urn:eudi:sca:` are validated when you save the configuration or create the request. Unsupported `urn:eudi:sca:` types and incomplete payloads are rejected with `400`.

| `type`                                  | Required `payload` fields                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `urn:eudi:sca:payment:1`                | `transaction_id`, `payee.name`, `payee.id`, `currency` (three upper-case letters), `amount` (number)          |
| `urn:eudi:sca:login_risk_transaction:1` | `transaction_id`, `action`                                                                                    |
| `urn:eudi:sca:account_access:1`         | `transaction_id`                                                                                              |
| `urn:eudi:sca:emandate:1`               | `transaction_id`                                                                                              |

A payment confirmation request, with the credential query `payment_credential` defined in the configuration's DCQL query:

```json
{
    "response_type": "uri",
    "requestId": "payment-confirmation",
    "transaction_data": [
        {
            "type": "urn:eudi:sca:payment:1",
            "credential_ids": ["payment_credential"],
            "payload": {
                "transaction_id": "order-4711",
                "payee": { "name": "Example Shop", "id": "merchant-001" },
                "currency": "EUR",
                "amount": 49.99
            }
        }
    ]
}
```

For TS12 entries, every key binding JWT that carries the entry's hash must additionally contain:

- a non-empty `jti`,
- `response_mode` equal to the request's response mode (`direct_post.jwt`, or `dc_api.jwt` with the DC API),
- `transaction_data_hashes_alg` set to `sha-256`,
- an `amr` array with factors from at least two of the categories `knowledge`, `possession` and `inherence`.

## How EUDIPLO checks the binding

The check applies to SD-JWT VC credentials; EUDIPLO does not check transaction data in mDOC presentations, whose format OpenID4VP leaves to each transaction data type. It runs once all credentials in the response are verified.

The wallet uses only one of the credentials an entry's `credential_ids` reference to authorize it ([OpenID4VP 1.0, section 5.1](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#section-5.1)). So for every entry, at least one presented SD-JWT VC it references must carry the entry's hash in `transaction_data_hashes` of its key binding JWT. The other referenced credentials do not need it. For example, with `"credential_ids": ["pid", "bank_card"]` and both credentials presented, the hash in the `bank_card` key binding JWT is enough. If a credential query allows several presentations (`multiple: true`) and the wallet uses that credential, each of its presentations must carry the hash, because the result does not say which one authorized the transaction; the hash in only some of them fails the response. Since mDOC presentations are not checked, a session created before the upgrade to 10.0 whose entry references an mDOC query needs the hash in a presented SD-JWT VC.

An entry for which the response contains no SD-JWT VC it references fails the response with `Transaction data entry <index> references no presented SD-JWT VC (...)`. This happens when the wallet answers `credential_sets` with an option that leaves out every credential the entry references. A hash of the entry in another credential's key binding JWT does not count.

Each hash is computed over the base64url-encoded entry exactly as sent in the request, with the algorithm from `transaction_data_hashes_alg` in the key binding JWT (`sha-256` when absent). The algorithm must be one the entry's own `transaction_data_hashes_alg` allows, so `sha-384` and `sha-512` are only accepted when the entry lists them. Hashes may come in any order.

EUDIPLO also rejects the response when:

- two identical entries share one hash: each entry needs a hash of its own,
- the key binding JWT of a credential that an entry references contains a hash that matches no entry referencing that credential, for example the hash of an entry whose `credential_ids` do not list it, or of data EUDIPLO never sent. The same entry's hash in several referenced credentials is accepted. Key binding JWTs of credentials that no entry references are not checked.
- the key binding JWT of a credential that an entry references has `transaction_data_hashes` that is not an array of strings, or a `transaction_data_hashes_alg` that is not a string.

If a hash is missing or does not match, the presentation fails and the session is set to `failed` (see [Session Outcome](../reference/session-outcome.md)). On success, the session and the [webhook](../reference/webhooks.md) contain the `transaction_data` that was sent, so your backend can match the result to its transaction.
