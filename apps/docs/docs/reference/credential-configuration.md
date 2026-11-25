---
title: Credential configuration reference
sidebar_label: Credential configuration
description: Every field of a credential configuration, generated from the schema the backend validates with.
---

import SchemaReference from "@site/src/components/SchemaReference";

Fields of a credential configuration, as accepted by `POST /api/issuer/credentials`, `PATCH /api/issuer/credentials/{id}` (any subset of the fields; `null` clears an optional one) and configuration import. The tables are generated from the Zod schema the backend validates with; unknown fields are rejected with `400`. The fields that a `GET` response adds (`tenantId` and the resolved references) are ignored, so a configuration read with `GET` can be sent back. For how to use the fields, see [Configure a credential](../issuance/credential-configuration.md).

## Configuration

<SchemaReference name="credential-configuration" mode="table" />

Notes on fields whose generated description is incomplete:

| Field | Note |
| --- | --- |
| `config.display[].locale` | A BCP 47 language tag. The Web Client offers the 24 official EU languages as language-only tags such as `en` and `de`, which wallets match for every regional setting of that language; a stored tag such as `de-DE` is kept when you edit the configuration. Compared case-insensitively: `en-US` and `en-us` count as the same locale. A new entry in the Web Client starts in a language no entry has yet, and a language an entry already has, even as `en-US`, is not offered for another entry; stored regional pairs such as `en-US` and `en-GB` stay valid. |
| `config.scope` | Published as `scope` in the issuer metadata only. EUDIPLO does not map OAuth scopes to credential configurations; wallets select credentials with `authorization_details`. |
| `config.proofTypesSupported` | Defaults to both `jwt` and `attestation`. Applies only to configurations whose requests carry key proofs. |
| `keyBinding` | Defaults to `false`. `true` puts the proven holder key into the SD-JWT VC (`cnf`). Without it and without `config.keyAttestationsRequired`, the metadata publishes no binding methods or proof types and requests carry no proofs. No effect on mDOCs, which are always bound to their device key. See [Choose key binding and proofs](../issuance/credential-configuration.md#4-choose-key-binding-and-proofs). |
| `config.credentialReusePolicy.options[]` | `batch_size` (minimum 2) is required for `once_only`, `rotating-batch` and `per-relying-party`. `reissue_trigger_unused` is required for `once_only` and must be lower than `batch_size`. `reissue_trigger_lifetime_left` (seconds) is required for `limited_time`, `rotating-batch` and `per-relying-party`. `options` is required when `id` is `arf_annex_ii`. See [Reuse policy](../issuance/credential-configuration.md#publish-a-reuse-policy). |
| `webhookEndpointId` | Receives the [wallet unit revocation webhook](webhooks.md#wallet-unit-revocation-webhook). Notifications use the `webhookEndpointId` of the [credential offer](../issuance/notifications.md). |
| `iaeActions` | Actions of the [Interactive Authorization Endpoint](../issuance/interactive-authorization.md). |
| `activeCredentials` | Rejected unless `statusManagement` is `true`. See [Single active credential](../issuance/credential-configuration.md#keep-one-active-credential-per-subject). |
| `revokeWithWalletUnit` | Rejected unless `statusManagement` is `true` and `config.keyAttestationsRequired` is set. Exports include it only when it is `true`. See [Revoke credentials with their wallet unit](../trust/attestation.md#revoke-credentials-with-their-wallet-unit). |
| `sdJwtTrustFormat` | `x5c` (default) or `federation`. See [OpenID Federation](../trust/federation.md). |
| `schemaMeta` | TS11 schema metadata of the credential type (version, rulebook, level of security, binding, schema URIs, trusted authorities). Stored and exported with the configuration; EUDIPLO currently publishes it nowhere. |

## Claim field (`fields[]`)

Each entry of `fields` describes one claim. `children` holds nested entries with the same shape.

<SchemaReference name="credential-field" mode="table" />

Defaults that are not part of the schema: `mandatory` and `disclosable` are `false` when omitted. `namespace` (mDOC only) of a top-level field defaults to the first path segment of a nested path, otherwise to the document type's namespace (`org.iso.18013.5.1` for `org.iso.18013.5.1.mDL`, the document type itself for any other). A field in `children` without `namespace` uses its parent's, including that default; when neither the child nor any parent sets one and the top-level path is nested, the first segment of the child's full path is used. The issuer metadata starts every mDOC claim path with the field's namespace (OID4VCI 1.0 Appendix C.2), once, also when `path` already starts with it: `path: ["given_name"]` in an mDL is published as `["org.iso.18013.5.1", "given_name"]`, and its value and default are issued in that namespace. A field whose `path` is only its namespace is not published. In `path`, `null` stands for every element of an array. `format` (`date`, `date-time`) is accepted on `string` fields only; see [Dates](../issuance/claims.md#dates) for how each credential format issues it.

## Example

```json
{
    "id": "membership",
    "description": "Membership card",
    "config": {
        "format": "dc+sd-jwt",
        "display": [
            {
                "name": "Membership",
                "locale": "en",
                "background_color": "#12107c",
                "text_color": "#FFFFFF",
                "logo": { "uri": "https://issuer.example.com/logo.png" }
            }
        ]
    },
    "vct": "urn:example:membership:1",
    "keyBinding": true,
    "statusManagement": true,
    "lifeTime": 31536000,
    "fields": [
        {
            "path": ["name"],
            "type": "string",
            "mandatory": true,
            "disclosable": true,
            "display": [{ "locale": "en", "name": "Name" }]
        },
        {
            "path": ["member_id"],
            "type": "string",
            "mandatory": true,
            "disclosable": true,
            "display": [{ "locale": "en", "name": "Member ID" }]
        }
    ]
}
```
