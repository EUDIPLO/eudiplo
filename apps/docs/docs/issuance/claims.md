---
title: Claim sources
sidebar_label: Claims
---

Decide where the claim values of a credential come from. EUDIPLO picks exactly one source per credential, validates the result against the credential configuration and only then signs.

## Sources and priority

For each credential configuration in an offer, EUDIPLO uses the first source that applies:

| Priority | Source | Where it is set |
| --- | --- | --- |
| 1 | **Offer claims** (`credentialClaims`): `inline` values, an `attributeProvider` reference or a one-off `webhook` | [Offer request](credential-offers.md#choose-the-claim-source) |
| 2 | **Configuration attribute provider** | `attributeProviderId` of the [credential configuration](credential-configuration.md) |
| 3 | **Static defaults** | `defaultValue` of each entry in `fields[]` |

Sources are not merged. If an offer passes inline claims, the configuration's attribute provider is not called and the static defaults are ignored; if an attribute provider answers, its claims replace all defaults. Return every claim from the source you use, including fixed values such as the issuing country.

An attribute provider or webhook may also answer that the credential is not ready yet; see [Deferred issuance](deferred-issuance.md).

### When to use which source

- **Static defaults:** demos, tests and credentials whose values never change.
- **Inline offer claims:** your backend already knows the values when it creates the offer, typically with the pre-authorized code flow.
- **Attribute provider:** the values depend on who authenticated (authorization code flow) or on a previous presentation, or you do not want claim values in the offer. Configure it once on the credential configuration; override it per offer with `credentialClaims` only when needed. See [Attribute providers](attribute-provider.md).

## External authorization servers need a dynamic source

When the wallet's access token comes from an [external authorization server](authorization-servers.md#external), static defaults are not accepted: the claims must come from the offer (`credentialClaims`) or from the configuration's attribute provider. Otherwise the credential request fails. All other flows fall back to the static defaults.

## Identity passed to attribute providers

Attribute providers and offer webhooks receive an `identity` object with `iss`, `sub` and `token_claims`. It always describes the access token that the wallet presented at the credential endpoint, with one exception for the chained authorization server:

| Flow | `iss` | `sub` | `token_claims` |
| --- | --- | --- | --- |
| Pre-authorized code, built-in authorization server, [interactive authorization](interactive-authorization.md) | EUDIPLO credential issuer URL | Session ID | Claims of EUDIPLO's access token |
| [External](authorization-servers.md#external) | External authorization server | Subject of its token | Claims of the external access token |
| [Chained](authorization-servers.md#chained) | Upstream OpenID provider | Upstream user ID | Upstream ID token claims merged over the upstream access token claims |
| [OID4VP](authorization-servers.md#oid4vp) | OID4VP authorization server URL | The wallet's `client_id` | Claims of EUDIPLO's access token |

After a presentation (OID4VP authorization server or an interactive authorization presentation step), the request also contains the verified presented claims in `credentials`. The exact request and response format is in the [Attribute provider API](../reference/attribute-provider-api.md).

## Validation

When a credential configuration defines `fields`, EUDIPLO derives a JSON schema from them and validates the final claims of every source right before signing. Since 9.0, this also covers claims returned by attribute providers and webhooks and claims supplied when completing a [deferred transaction](deferred-issuance.md). Inline offer claims are additionally checked when the offer is created; invalid ones are rejected with `409`.

A credential is not issued if the claims:

- miss a claim marked `mandatory: true`,
- contain a value of a different `type`,
- contain a claim that is not defined in `fields` (at the top level or inside an object with `children`), or
- contain an invalid nested structure.

The wallet receives `credential_request_denied` with the affected paths, for example `/address/street_address: must be string`. Claim values are never included in the message.

To allow additional properties inside an object, set `additionalProperties` in its `constraints`. An `object` field without `children` accepts any properties.

```json
{
    "path": ["metadata"],
    "type": "object",
    "constraints": { "additionalProperties": true },
    "children": [{ "path": ["source"], "type": "string" }]
}
```

Configurations without `fields` are not validated.
