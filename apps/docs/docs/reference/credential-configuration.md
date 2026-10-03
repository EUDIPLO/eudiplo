---
title: Credential configuration reference
sidebar_label: Credential configuration
description: Every field of a credential configuration, generated from the schema the backend validates with.
---

import SchemaReference from "@site/src/components/SchemaReference";

Fields of a credential configuration, as accepted by `POST /api/issuer/credentials` and by configuration import. The tables are generated from the Zod schema the backend validates with; unknown fields are rejected. For how to use the fields, see [Configure a credential](../issuance/credential-configuration.md).

## Configuration

<SchemaReference name="credential-configuration" mode="table" />

Notes on fields whose generated description is incomplete:

| Field | Note |
| --- | --- |
| `config.display[].name`, `.locale`, `.description` | Name, locale and description of the credential (the schema shares these descriptions with claim display entries). |
| `config.scope` | Published as `scope` in the issuer metadata only. EUDIPLO does not map OAuth scopes to credential configurations; wallets select credentials with `authorization_details`. |
| `config.proofTypesSupported` | Defaults to both `jwt` and `attestation`. |
| `config.credentialReusePolicy.options[]` | `batch_size` (minimum 2) is required for `once_only`, `rotating-batch` and `per-relying-party`. `reissue_trigger_unused` is required for `once_only` and must be lower than `batch_size`. `reissue_trigger_lifetime_left` (seconds) is required for `limited_time`, `rotating-batch` and `per-relying-party`. `options` is required when `id` is `arf_annex_ii`. See [Reuse policy](../issuance/credential-configuration.md#publish-a-reuse-policy). |
| `webhookEndpointId` | Stored with the configuration but not used. Notifications use the `webhookEndpointId` of the [credential offer](../issuance/notifications.md). |
| `iaeActions` | Actions of the [Interactive Authorization Endpoint](../issuance/interactive-authorization.md). |
| `activeCredentials` | Rejected unless `statusManagement` is `true`. See [Single active credential](../issuance/credential-configuration.md#keep-one-active-credential-per-subject). |
| `sdJwtTrustFormat` | `x5c` (default) or `federation`. See [OpenID Federation](../trust/federation.md). |
| `schemaMeta` | See [Schema metadata](../trust/registrar.md). |

## Claim field (`fields[]`)

Each entry of `fields` describes one claim. `children` holds nested entries with the same shape.

<SchemaReference name="credential-field" mode="table" />

Defaults that are not part of the schema: `mandatory` and `disclosable` are `false` when omitted. `namespace` (mDOC only) defaults to the first path segment of a nested path, otherwise to the document type (`org.iso.18013.5.1` for `org.iso.18013.5.1.mDL`). In `path`, `null` stands for every element of an array.

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
                "locale": "en-US",
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
            "display": [{ "locale": "en-US", "name": "Name" }]
        },
        {
            "path": ["member_id"],
            "type": "string",
            "mandatory": true,
            "disclosable": true,
            "display": [{ "locale": "en-US", "name": "Member ID" }]
        }
    ]
}
```
