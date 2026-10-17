---
title: OpenID Federation
---

EUDIPLO can use [OpenID Federation](https://openid.net/specs/openid-federation-1_0.html) trust anchors to decide whether to trust external authorization servers, the upstream provider of a chained authorization server, and the issuers of presented SD-JWT VCs. It resolves the trust chain from the entity to a configured trust anchor and verifies every statement in it, or delegates this to an external trust engine.

## How trust is decided

For an entity ID and the configured trust anchors, EUDIPLO:

1. fetches the entity's entity configuration from `{entityId}/.well-known/openid-federation` and follows its `authority_hints` up to a trust anchor;
2. fetches each superior's subordinate statement about the entity below it from the superior's `federation_fetch_endpoint`;
3. validates the chain as [Section 10](https://openid.net/specs/openid-federation-1_0.html#section-10) describes: every statement is signed, current (`iat`, `exp`) and has no unknown `crit` claims; an entity configuration is about the requested entity (`sub`) and signed with a key its superior lists; each subordinate statement is issued by the superior about the subject and signed with a key the statement above lists; the last one with the trust anchor's keys;
4. applies the `max_path_length` and `allowed_entity_types` constraints and the metadata policies of the chain, and returns the entity's resolved metadata.

An entity is not trusted because its entity configuration names a trust anchor in `authority_hints`: the trust anchor, or an intermediate below it, must list it in a signed subordinate statement.

Protocol keys come from the resolved metadata, never from the federation keys of the entity configuration: the key that signs a credential is looked up by `kid` in `metadata.openid_credential_issuer.jwks`.

Resolution uses [`@openid-federation/core`](https://github.com/openwallet-foundation-labs/openid-federation-ts). Not supported:

- Chains with `naming_constraints` are rejected, as the constraint is not evaluated.
- Trust marks are not verified, and they do not decide trust.
- Trust anchor keys cannot be configured yet: the trust anchor's entity configuration is checked against the keys it publishes itself, so trust rests on TLS for the trust anchor's host, not on keys distributed out of band as Section 10.2 expects.
- A credential without a `kid` header is rejected, also when the issuer's metadata lists one key.
- An authorization server's federation metadata must have an `issuer` equal to its entity ID. The metadata EUDIPLO uses for the server is still fetched from its `.well-known` URL; policies of the chain do not change it.
- Protocol keys must be in `jwks`; `jwks_uri` and `signed_jwks_uri` in the metadata are not used.
- EUDIPLO does not publish its own entity configuration yet ([#1047](https://github.com/EUDIPLO/eudiplo/issues/1047)).

## Where federation is checked

| Check                                                    | Configured in                                     | Behavior                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| External authorization servers, chained upstream provider | `federation` of the issuance configuration       | The server's issuer URL must be a federation entity with `oauth_authorization_server` or `openid_provider` metadata whose chain leads to a trust anchor; there is no LoTE fallback. Without `federation`, no check. |
| Issuers of presented SD-JWT VCs                           | `openid_federation` in DCQL `trusted_authorities` | Without an `etsi_tl` entry in the same query, the credential's `iss` must be a federation entity whose chain leads to one of the listed trust anchors, and the credential must be signed with the key `kid` of its `openid_credential_issuer` metadata. An `x5c` header is not used. With an `etsi_tl` entry, the trust list decides. |
| Status lists of those SD-JWT VCs                          | the same                                          | The status list JWT must be signed with a key `kid` of the same entity's `openid_credential_issuer` metadata. |

mDOCs cannot be verified through OpenID Federation, as they name no issuer entity: a query for `mso_mdoc` with only an `openid_federation` entry rejects every presentation. Use an `etsi_tl` trust list for mDOCs.

`mode` accepts `hybrid` (default) and `federation-only`; both check authorization servers the same way. For LoTE-only behavior, leave `federation` unset or `null`.

## Choose the resolver

`FEDERATION_RESOLVER` selects who resolves trust chains for the whole instance ([environment variables](../reference/environment-variables.md#federation)):

| Value             | Behavior                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` (default) | EUDIPLO fetches and validates the statements itself.                                                                                                             |
| `http`            | EUDIPLO sends `POST {FEDERATION_RESOLVER_URL}/resolve` to an external trust engine, with `FEDERATION_RESOLVER_TOKEN` as bearer token, and uses its answer.        |

The trust engine receives:

```json
{
    "entityId": "https://issuer.example.org",
    "trustAnchors": ["https://ta.example.org"],
    "metadataTypes": ["openid_credential_issuer"]
}
```

and answers with a `2xx` status and the validated resolution (redirects are not followed):

```json
{
    "entityId": "https://issuer.example.org",
    "trustAnchor": "https://ta.example.org",
    "trustChain": ["<entity configuration>", "<subordinate statement>", "<trust anchor entity configuration>"],
    "metadata": {
        "openid_credential_issuer": { "jwks": { "keys": [{ "kid": "credential-key", "kty": "EC", "...": "..." }] } }
    },
    "expiresAt": "2026-10-18T12:00:00Z"
}
```

This is an EUDIPLO-specific API, not the Resolve endpoint of OpenID Federation (Section 8.3), and the answer is not signed. `metadata` is the metadata after the chain's policies were applied; `expiresAt` is the earliest `exp` of the chain. EUDIPLO checks that the answer is about the requested entity and one of the requested trust anchors, has not expired and contains one of the requested metadata types. A `4xx` answer other than `401`, `403`, `408` and `429` means the entity is not trusted; those (for `401` and `403`, check `FEDERATION_RESOLVER_TOKEN`), `5xx` answers, invalid answers and failed requests (10 seconds, 1 MiB) mean the federation is unavailable. EUDIPLO trusts the engine's validation and does not check the chain again.

## Limits and outbound requests

Entity configurations name the URLs EUDIPLO fetches, so every request goes through the [outbound URL policy](../concepts/security-model.md#https-and-tls) (HTTPS and public addresses unless allowed otherwise, `OUTBOUND_URL_ALLOWED_HOSTS`), except requests to EUDIPLO's own `PUBLIC_URL` or `INTERNAL_URL` origin. TLS certificates of federation entities are always verified, also outside `NODE_ENV=production`. The request to a trust engine is subject to the policy as well; its URL must use HTTPS.

One local resolution follows at most 8 superiors and 10 distinct `authority_hints` per entity, sends at most 32 requests, waits at most 5 seconds per request and reads at most 256 KiB per statement. Statements may differ from EUDIPLO's clock by `CRYPTO_TOLERANCE` seconds.

## Caching

A resolution is cached for `cacheTtlSeconds` of the issuance configuration (default 300, at least 5 seconds), never beyond the `exp` of its trust chain; DCQL queries use the default. Tenants with the same trust anchors share the cache, and each uses a resolution only within its own `cacheTtlSeconds`. A failed resolution is retried after 10 seconds.

When the federation cannot be reached (a timeout, a failed request, a `429` or `5xx` answer), the last successful resolution is used for at most 15 minutes after it was obtained, and only while its chain is valid. A chain that fails validation (a signature, an expired statement, an entity the superior does not list) is rejected and never replaced by an earlier resolution.

## Configure federation for issuance

Set `federation` in the issuance configuration (`POST /api/issuer/config`, or **Issuer Settings → Trust → OpenID Federation** in the Web Client):

```json
{
    "federation": {
        "mode": "hybrid",
        "entityId": "https://eudiplo.example.com/issuers/membership-demo",
        "cacheTtlSeconds": 300,
        "trustAnchors": [
            {
                "entityId": "https://ta.example.org",
                "entityConfigurationUri": "https://ta.example.org/.well-known/openid-federation"
            }
        ]
    }
}
```

| Field                                   | Behavior                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `trustAnchors[].entityId`               | Trust anchor. Its entity configuration is fetched from `{entityId}/.well-known/openid-federation`. Entity IDs are compared exactly, so `https://ta.example.org/` and `https://ta.example.org` are different trust anchors. |
| `trustAnchors[].entityConfigurationUri` | Required by the schema but not used.                                                                             |
| `entityId`                              | Your issuer's entity ID; used as `iss` of SD-JWT VCs with the `federation` trust format (below).                |
| `cacheTtlSeconds`                       | How long resolutions are cached; default 300, at least 5. See [Caching](#caching).                              |
| `role`                                  | Only `leaf` (the default) is accepted; EUDIPLO does not act as a trust anchor or intermediate.                  |
| `enforceSigningPolicy`                  | Only `true` (the default) is accepted; federation checks are always enforced.                                    |

With this configuration, external authorization servers are checked before EUDIPLO fetches their metadata, and a chained authorization server's upstream provider before its discovery document is fetched.

### SD-JWT VC trust format

A credential configuration can sign SD-JWT VCs for federation instead of X.509: set `sdJwtTrustFormat` to `federation` (**Credential Types → SD-JWT Trust Format**). EUDIPLO then sets `iss` to the federation `entityId` and omits the `x5c` header. It falls back to `x5c` (the default) when no federation `entityId` is configured. The signing key chain is used in both cases. EUDIPLO does not yet set a `kid` header or publish an entity configuration with the signing key ([#1047](https://github.com/EUDIPLO/eudiplo/issues/1047)), so verifiers, EUDIPLO included, cannot verify credentials issued this way yet.

## Reference trust anchors in DCQL

Add an `openid_federation` entry with trust anchor entity IDs to `trusted_authorities`. The entry is sent to the wallet unchanged. If it is the only entry, EUDIPLO accepts only SD-JWT VCs whose issuer chains to one of these trust anchors. An `etsi_tl` entry in the same query takes precedence: the issuer must then be in the trust list, as a credential is checked one way.

```json
{
    "trusted_authorities": [
        { "type": "openid_federation", "values": ["https://ta.example.org"] }
    ]
}
```

A credential verified through federation needs an `iss` claim and a `kid` header:

```json
{ "alg": "ES256", "typ": "dc+sd-jwt", "kid": "credential-key" }
```

## Errors

| Where                               | Error                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Chained authorization server        | `400`: `Upstream issuer is not trusted by OpenID Federation policy: <reason>`                             |
| External authorization server       | `400`: `Authorization server is not trusted by OpenID Federation policy: <reason>`                        |
| Credential verification             | Failure code `no_trust_chain_to_root` (no valid chain, or no key `kid`), `trust_list_unavailable` (federation unreachable), `signature_invalid` or `verification_error` (no `iss` or `kid`, or an mDOC); the reason is in the server log |
| Issuance configuration              | `400`: `Only the federation role 'leaf' is supported ...` or `enforceSigningPolicy cannot be disabled ...` |

Common reasons:

- `<entity> does not chain to a configured trust anchor`: the `authority_hints` do not lead to a configured trust anchor.
- `no valid trust chain from <entity> to a configured trust anchor: <why>`: a chain was found but failed validation, for example `... has expired`, `... is not signed with a key listed by ...`, `request to '<fetch endpoint>?sub=...' failed with status 404` (the superior does not list the entity) or `... has subject ...` (an entity configuration about another entity).
- `could not fetch federation statements for <entity>: <why>`: a timeout (5 seconds), a failed request or a URL the outbound URL policy blocks, and no valid earlier resolution.
- `federation entity <entity> has no oauth_authorization_server or openid_provider metadata` (or `openid_credential_issuer`).
- `oauth_authorization_server issuer of <entity> is missing or not its entity identifier`.
- `openid_credential_issuer metadata of <entity> has no key '<kid>'`.
- `trust chain resolution exceeded 32 requests` or `... entity visits`: too many entities or `authority_hints`.
- `federation mode requires trust anchors, none configured`.

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `could not fetch federation statements`                  | Check that the entity configurations and fetch endpoints are reachable over HTTPS with a valid certificate on a public address, and answer with `application/entity-statement+jwt`. |
| `does not chain to a configured trust anchor`            | Check the trust anchor entity IDs, compared exactly, and the entity's `authority_hints`.                                  |
| `failed with status 404` from a fetch endpoint           | The superior does not list the entity as its subordinate; register the entity there.                                     |
| `has no key '<kid>'`                                     | The credential's `kid` must be in the `jwks` of the issuer's `openid_credential_issuer` metadata.                         |
| A changed federation still gives the old decision        | Resolutions are cached (see [Caching](#caching)). Clear the cache with `DELETE /api/cache/trust-list` or `DELETE /api/cache`. |

Cache activity is reported as the OpenTelemetry counters `federation_trust_cache_hits_total`, `federation_trust_cache_misses_total`, `federation_trust_cache_stale_total` and `federation_trust_fetches_total`.
