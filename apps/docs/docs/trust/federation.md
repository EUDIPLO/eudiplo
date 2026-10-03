---
title: OpenID Federation
---

EUDIPLO can use [OpenID Federation](https://openid.net/specs/openid-federation-1_0.html) trust anchors to decide whether to trust external authorization servers, the upstream provider of a chained authorization server, and credential issuers. Federation support is limited; read the limitations before relying on it.

## Limitations

Federation support is not yet a full OpenID Federation trust-chain resolution ([#1046](https://github.com/openwallet-foundation/eudiplo/issues/1046)). Treat federation trust as unauthenticated and prefer LoTE [trust lists](trust-lists.md) in production:

- Entity configurations and subordinate statements are not verified against the trust anchor. EUDIPLO only checks that the entity's `sub` matches and that its `authority_hints` lead to a configured trust anchor. A JWT entity configuration is only verified against the certificate in its own `x5c` header, if present, and its `exp` is not checked. Membership is therefore self-asserted: any entity whose entity configuration names your trust anchor in `authority_hints` is trusted.
- For credentials, the entity ID is taken from the credential's leaf certificate (SAN or CN); the signing key is not bound to the entity's federation metadata.
- In presentation verification, the credential's certificate chain is not checked when federation decides; only the entity ID in its leaf certificate is.
- Federation fetches do not use the outbound URL policy, and TLS certificates are not checked outside `NODE_ENV=production`.
- EUDIPLO does not publish its own entity configuration yet ([#1047](https://github.com/openwallet-foundation/eudiplo/issues/1047)).

## Where federation is checked

| Check                                                    | Configured in                                     | Behavior                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| External authorization servers, chained upstream provider | `federation` of the issuance configuration       | The server must chain to a trust anchor; there is no LoTE fallback. Without `federation`, no check. |
| Credential issuers in presentations                       | `openid_federation` in DCQL `trusted_authorities` | Without an `etsi_tl` entry in the same query, the issuer must chain to one of the listed trust anchors. With one, the trust list decides and the federation entry is not evaluated. |

`mode` accepts `hybrid` (default) and `federation-only`; both check authorization servers the same way. For LoTE-only behavior, leave `federation` unset or `null`.

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
| `trustAnchors[].entityId`               | Trust anchor. Entity configurations are always fetched from `{entityId}/.well-known/openid-federation`.         |
| `trustAnchors[].entityConfigurationUri` | Required by the schema but not used.                                                                             |
| `entityId`                              | Your issuer's entity ID; used as `iss` of SD-JWT VCs with the `federation` trust format (below).                |
| `cacheTtlSeconds`                       | How long trust decisions are cached; default 300, at least 5.                                                    |
| `role`                                  | Only `leaf` (the default) is accepted; EUDIPLO does not act as a trust anchor or intermediate.                  |
| `enforceSigningPolicy`                  | Only `true` (the default) is accepted; federation checks are always enforced.                                    |

With this configuration, external authorization servers are checked before EUDIPLO fetches their metadata, and a chained authorization server's upstream provider before its discovery document is fetched.

### SD-JWT VC trust format

A credential configuration can sign SD-JWT VCs for federation instead of X.509: set `sdJwtTrustFormat` to `federation` (**Credential Types → SD-JWT Trust Format**). EUDIPLO then sets `iss` to the federation `entityId` and omits the `x5c` header. It falls back to `x5c` (the default) when no federation `entityId` is configured. The signing key chain is used in both cases. EUDIPLO's own verifier requires `x5c`, so it cannot verify credentials issued this way.

## Reference trust anchors in DCQL

Add an `openid_federation` entry with trust anchor entity IDs to `trusted_authorities`. The entry is sent to the wallet unchanged. If it is the only entry, EUDIPLO accepts only issuers that chain to one of these trust anchors. Entries of a query are alternatives for the wallet, but because federation membership is not yet authenticated ([limitations](#limitations)), an `etsi_tl` entry in the same query takes precedence: the issuer must then be in the trust list.

```json
{
    "trusted_authorities": [
        { "type": "openid_federation", "values": ["https://ta.example.org"] },
        { "type": "etsi_tl", "values": [{ "trustListId": "membership-issuers" }] }
    ]
}
```

## Errors

| Where                               | Error                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Chained authorization server        | `400`: `Upstream issuer is not trusted by OpenID Federation policy: <reason>`                             |
| External authorization server       | `400`: `Authorization server is not trusted by OpenID Federation policy: <reason>`                        |
| Credential verification             | Failure code `verification_error`; the reason is in the server log                                        |
| Issuance configuration              | `400`: `Only the federation role 'leaf' is supported ...` or `enforceSigningPolicy cannot be disabled ...` |

Common reasons:

- `could not fetch federation entity configuration`: network error, timeout (5 seconds), unparsable response or invalid `x5c` signature, and no cached result from the last hour.
- `entity did not chain to configured trust anchor`: the `authority_hints` do not lead to a configured trust anchor.
- `federation entity subject does not match entity id`: the entity configuration's `sub` differs from the requested entity ID.
- `federation authority_hints chain exceeded maximum depth`, `... contains a cycle` or `... traversal exceeded resolution limit`: the chain is longer than 8 levels, loops, or needs more than 32 fetches (at most 10 hints per entity).
- `federation mode requires trust anchors, none configured`.
- `could not extract entity id from certificate SAN/CN` (credential verification only).

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `could not fetch federation entity configuration`        | Check that `{entityId}/.well-known/openid-federation` is publicly reachable and returns a JSON or JWT entity configuration. |
| `entity did not chain to configured trust anchor`        | Check the trust anchor entity IDs and the entity's `authority_hints`.                                                     |
| A changed federation still gives the old decision        | Decisions are cached for `cacheTtlSeconds` (failed fetches for 10 seconds). Clear the cache with `DELETE /api/cache/trust-list` or `DELETE /api/cache`. |

Cache activity is reported as the OpenTelemetry counters `federation_trust_cache_hits_total`, `federation_trust_cache_misses_total`, `federation_trust_cache_stale_total` and `federation_trust_fetches_total`.
