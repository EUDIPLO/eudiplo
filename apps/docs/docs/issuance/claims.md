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

Sources are not merged. If an offer passes inline claims, the configuration's attribute provider is not called and the static defaults are ignored; if an attribute provider answers, its claims replace all defaults. An attribute provider or webhook that answers without claims for the configuration fails the credential request ([errors](../reference/attribute-provider-api.md#errors)); EUDIPLO does not fall back to the static defaults. Return every claim from the source you use, including fixed values such as the issuing country.

An attribute provider or webhook may also answer that the credential is not ready yet; see [Deferred issuance](deferred-issuance.md).

### When to use which source

- **Static defaults:** demos, tests and credentials whose values never change.
- **Inline offer claims:** your backend already knows the values when it creates the offer, typically with the pre-authorized code flow.
- **Attribute provider:** the values depend on who authenticated (authorization code flow) or on a previous presentation, or you do not want claim values in the offer. Configure it once on the credential configuration; override it per offer with `credentialClaims` only when needed. See [Attribute providers](attribute-provider.md).

## External authorization servers need a dynamic source

When the wallet's access token comes from an [external authorization server](authorization-servers.md#external), static defaults are not accepted: the claims must come from the offer (`credentialClaims`) or from the configuration's attribute provider. Otherwise the credential request fails. In all other flows, credentials without a dynamic source get the static defaults.

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

### Constraints

`constraints` adds JSON Schema 2020-12 rules to a field, for example a `pattern` for a date or `minItems` for an array. It accepts only these keywords, also inside subschemas such as `items` or `properties`:

- validation: `type`, `enum`, `const`, `multipleOf`, `maximum`, `exclusiveMaximum`, `minimum`, `exclusiveMinimum`, `maxLength`, `minLength`, `pattern`, `maxItems`, `minItems`, `uniqueItems`, `maxContains`, `minContains`, `maxProperties`, `minProperties`, `required`, `dependentRequired`;
- subschemas, each an object with these keywords or `true`/`false`: `items`, `contains`, `additionalProperties`, `propertyNames`, `not`, `if`, `then`, `else`, `unevaluatedItems`, `unevaluatedProperties`; a list of them in `prefixItems`, `allOf`, `anyOf`, `oneOf`; a map of them in `properties`, `patternProperties`, `dependentSchemas`;
- annotations: `title`, `description`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$comment`;
- `default`: fills in the claim at issuance when the claim source leaves it out.

At the top level of `constraints`, the field's own `type` and its display name, as `title`, win over these keywords; inside subschemas they apply as written.

Other keys, such as `format`, `$ref` or `x-` extensions, are refused with HTTP `400`; the error names the field and the keyword. This also keeps form hints like formly's `widget` out of the offer form in the Web Client. Configurations stored before 10.0 may still carry such keys: EUDIPLO ignores them when it validates claims, builds the offer form and exports the configuration, and sending its `fields` again answers `400` until you remove them.

Regular expressions in `constraints` (`pattern`, the keys of `patternProperties`, and `pattern` inside `propertyNames`) are matched with [RE2](https://github.com/google/re2/wiki/Syntax), which runs in linear time, so a pattern cannot stall issuance. `\s`, `\S` and `.` keep their JavaScript meaning. A configuration is rejected when it is saved or imported if a pattern uses lookarounds such as `(?=…)`, backreferences such as `\1`, inline flags, unknown escapes such as `\e`, `\S` inside a character class, the empty classes `[]` and `[^]`, long Unicode property names such as `\p{Letter}` (use `\p{L}`), is longer than 1000 characters or has too many or too large repetitions. A configuration stored before 10.0 with such a pattern fails at issuance until the pattern is replaced.
