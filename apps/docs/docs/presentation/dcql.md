---
title: DCQL (Digital Credentials Query Language)
sidebar_label: DCQL
---

The `dcql_query` of a presentation configuration tells the wallet which credentials and claims to present. EUDIPLO uses the [DCQL of OpenID4VP 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-digital-credentials-query-l) and checks the response against the same query. Every field is listed in the [presentation configuration reference](../reference/presentation-configuration.md).

## Request a credential

Each entry in `credentials` is one credential query. `id`, `format` and `meta` are required; `meta` identifies the credential type.

```json
{
    "credentials": [
        {
            "id": "membership",
            "format": "dc+sd-jwt",
            "meta": { "vct_values": ["urn:example:membership:1"] },
            "claims": [{ "path": ["name"] }, { "path": ["member_id"] }]
        }
    ]
}
```

For mDOC, `meta.doctype_value` names the document type and each claim path is `[namespace, element]`:

```json
{
    "credentials": [
        {
            "id": "pid",
            "format": "mso_mdoc",
            "meta": { "doctype_value": "eu.europa.ec.eudi.pid.1" },
            "claims": [
                { "path": ["eu.europa.ec.eudi.pid.1", "given_name"] },
                { "path": ["eu.europa.ec.eudi.pid.1", "family_name"] }
            ]
        }
    ]
}
```

- `credentials` needs at least one query. Query IDs use letters, digits, `_` and `-` and are unique; results, `credential_sets` and transaction data refer to them. EUDIPLO rejects configurations that break these rules.
- SD-JWT VC paths are property names, with numbers as array indexes (`["address", "locality"]`, `["nationalities", 0]`).
- Without `claim_sets`, the presented credential must disclose every listed claim; otherwise the presentation fails.

## Accept specific values

`values` lists the accepted values of a claim. It is sent to the wallet, which only offers matching credentials:

```json
{ "path": ["membership_level"], "values": ["gold", "platinum"] }
```

EUDIPLO does not compare the presented value with `values` again. If the decision matters, check the claim in your backend.

## Alternative claims

`claim_sets` lists alternative claim combinations by claim `id`. The credential must disclose every claim of at least one set; list the preferred set first. Each ID must match the `id` of a claim in the same query, otherwise the configuration is rejected:

```json
{
    "id": "pid",
    "format": "mso_mdoc",
    "meta": { "doctype_value": "eu.europa.ec.eudi.pid.1" },
    "claims": [
        { "id": "over18", "path": ["eu.europa.ec.eudi.pid.1", "age_over_18"] },
        { "id": "birth_date", "path": ["eu.europa.ec.eudi.pid.1", "birth_date"] }
    ],
    "claim_sets": [["over18"], ["birth_date"]]
}
```

## Alternative credentials

`credential_sets` combines credential queries by `id`. Each entry has `options`, a list of alternatives; every option lists queries that must be presented together. A set is required unless it has `"required": false`. Without `credential_sets`, every query in `credentials` is required.

This query accepts the PID either as SD-JWT VC or as mDOC, and optionally a membership credential:

```json
{
    "credentials": [
        {
            "id": "pid_sd_jwt",
            "format": "dc+sd-jwt",
            "meta": { "vct_values": ["urn:eudi:pid:1"] },
            "claims": [{ "path": ["family_name"] }]
        },
        {
            "id": "pid_mdoc",
            "format": "mso_mdoc",
            "meta": { "doctype_value": "eu.europa.ec.eudi.pid.1" },
            "claims": [{ "path": ["eu.europa.ec.eudi.pid.1", "family_name"] }]
        },
        {
            "id": "membership",
            "format": "dc+sd-jwt",
            "meta": { "vct_values": ["urn:example:membership:1"] },
            "claims": [{ "path": ["member_id"] }]
        }
    ],
    "credential_sets": [
        { "options": [["pid_sd_jwt"], ["pid_mdoc"]] },
        { "options": [["membership"]], "required": false }
    ]
}
```

EUDIPLO rejects a response that does not satisfy one option of every required set. Your backend sees which queries were answered by the `id` of each entry in the result.

## Several credentials of one type

By default a query matches one credential, and a response with several presentations for the same query fails. Set `"multiple": true` to accept several, for example all employee badges in the wallet:

```json
{
    "id": "badges",
    "format": "dc+sd-jwt",
    "meta": { "vct_values": ["urn:example:employee-badge:1"] },
    "multiple": true,
    "claims": [{ "path": ["badge_id"] }]
}
```

## Intent to retain (mDOC)

For `mso_mdoc` claims, `intent_to_retain: true` tells the wallet and the user that you store the element after the presentation. It is sent in OpenID4VP requests; [ISO 18013-7 requests](requests.md#iso-18013-7-annex-c) always send `false`.

```json
{ "path": ["eu.europa.ec.eudi.pid.1", "family_name"], "intent_to_retain": true }
```

## Accept only trusted issuers

Without `trusted_authorities`, EUDIPLO verifies the credential's signature but not who issued it. Add `trusted_authorities` to a credential query to accept only issuers from a trust list or an OpenID Federation:

```json
{
    "trusted_authorities": [{ "type": "etsi_tl", "values": [{ "trustListId": "membership-issuers" }] }]
}
```

How trust lists are resolved, what the wallet receives (`aki` values) and how the issuer chain is checked is described in [Trust Lists](../trust/trust-lists.md#use-a-trust-list-in-a-presentation); federation trust anchors in [OpenID Federation](../trust/federation.md).
