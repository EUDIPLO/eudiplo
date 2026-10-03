---
title: Transaction Data
---

Transaction data binds a presentation to a concrete transaction, such as a payment. The wallet shows it to the user, and the holder's signature over the presentation includes a hash of it, so your backend knows the user approved exactly this transaction. EUDIPLO implements [OpenID4VP transaction data](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-transaction-data) and validates the TS12 strong customer authentication types.

## Add transaction data

Set `transaction_data` in the presentation configuration, or per request in `POST /api/verifier/offer`. Request-level `transaction_data` replaces the configured list for that session; the two are not merged. ISO 18013-7 requests ignore transaction data.

Each entry needs:

| Field            | Description                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `type`           | Transaction data type. Wallets must reject types they do not support, so use one your target wallets know, such as a TS12 type. |
| `credential_ids` | IDs of the DCQL credential queries the transaction applies to.                              |
| other fields     | Type-specific content. TS12 types put it in `payload`.                                       |

EUDIPLO sends each entry base64url-encoded as JSON in the `transaction_data` parameter of the signed request.

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

For TS12 entries, the key binding JWT must additionally contain:

- a non-empty `jti`,
- `response_mode` equal to the request's response mode (`direct_post.jwt`, or `dc_api.jwt` with the DC API),
- `transaction_data_hashes_alg` set to `sha-256`,
- an `amr` array with factors from at least two of the categories `knowledge`, `possession` and `inherence`.

## How EUDIPLO checks the binding

The check applies to SD-JWT VC credentials; EUDIPLO does not check transaction data for mDOC presentations. For every presented SD-JWT VC, EUDIPLO takes the entries whose `credential_ids` contain the credential's query ID and requires in the key binding JWT:

- `transaction_data_hashes` with one hash per entry, in request order,
- each hash computed over the base64url-encoded entry exactly as sent in the request, with the algorithm from `transaction_data_hashes_alg` (`sha-256` by default, `sha-384` and `sha-512` also accepted).

EUDIPLO does not check that `credential_ids` exist in the DCQL query: an entry whose IDs match no presented SD-JWT VC is sent to the wallet but not verified. If a hash is missing or does not match, the presentation fails and the session is set to `failed` (see [Session Outcome](../reference/session-outcome.md)). On success, the session and the [webhook](../reference/webhooks.md) contain the `transaction_data` that was sent, so your backend can match the result to its transaction.
