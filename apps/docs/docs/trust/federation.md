---
title: OpenID Federation
---

EUDIPLO can use [OpenID Federation](https://openid.net/specs/openid-federation-1_0.html) trust anchors to decide whether to trust external authorization servers, the upstream provider of a chained authorization server, and the issuers of presented SD-JWT VCs. It resolves the trust chain from the entity to a configured trust anchor and verifies every statement in it, or delegates this to an external trust engine. Every trust anchor must be [registered with its federation keys](#register-trust-anchors), which you obtain out of band.

A tenant can also take part in a federation itself, as a leaf entity: EUDIPLO then publishes its signed entity configuration, issues SD-JWT VCs that federation verifiers check through its credential issuer metadata, and can identify its OID4VP requests by its entity ID ([Publish your entity configuration](#publish-your-entity-configuration)).

## How trust is decided

For an entity ID and the configured trust anchors, EUDIPLO:

1. fetches the entity's entity configuration from `{entityId}/.well-known/openid-federation` and follows its `authority_hints` up to a trust anchor;
2. fetches each superior's subordinate statement about the entity below it from the superior's `federation_fetch_endpoint`;
3. validates the chain as [Section 10](https://openid.net/specs/openid-federation-1_0.html#section-10) describes: every statement is signed, current (`iat`, `exp`) and has no unknown `crit` claims; an entity configuration is about the requested entity (`sub`) and signed with a key its superior lists; each subordinate statement is issued by the superior about the subject and signed with a key the statement above lists; the last one with the trust anchor's keys. The trust anchor's own entity configuration must be signed with one of the keys you [registered](#register-trust-anchors) for it ([Section 10.2](https://openid.net/specs/openid-federation-1_0.html#section-10.2)), so a host serving other keys for the trust anchor is not trusted;
4. applies the `max_path_length` and `allowed_entity_types` constraints and the metadata policies of the chain, and returns the entity's resolved metadata.

An entity is not trusted because its entity configuration names a trust anchor in `authority_hints`: the trust anchor, or an intermediate below it, must list it in a signed subordinate statement.

Protocol keys come from the resolved metadata, never from the federation keys of the entity configuration: the key that signs a credential is looked up by `kid` in `metadata.openid_credential_issuer.jwks`.

Resolution uses [`@owf/openid-federation`](https://github.com/openwallet-foundation-labs/identity-common-ts/tree/main/packages/openid-federation). Not supported:

- Chains with `naming_constraints` are rejected, as the constraint is not evaluated.
- Trust marks are not verified, and they do not decide trust.
- A credential without a `kid` header is rejected, also when the issuer's metadata lists one key.
- An authorization server's federation metadata must have an `issuer` equal to its entity ID. The metadata EUDIPLO uses for the server is still fetched from its `.well-known` URL; policies of the chain do not change it.
- Protocol keys must be in `jwks`; `jwks_uri` and `signed_jwks_uri` in the metadata are not used.
- EUDIPLO only acts as a leaf entity: it issues no subordinate statements and offers no fetch, list, resolve or trust mark endpoints. Trust marks you configure are published as given, not checked.

## Register trust anchors

A trust anchor is trusted only when the tenant has registered it with its federation keys. Get the keys out of band, for example from the federation operator's published key set, not from the trust anchor's `.well-known` URL alone. Register each trust anchor once per tenant (`POST /api/federation-trust-anchor`, with `issuance:manage` or `presentation:manage`); issuance configurations and DCQL queries then name it by entity ID:

```json
{
    "id": "example-federation",
    "entityId": "https://ta.example.org",
    "description": "Example federation",
    "jwks": {
        "keys": [{ "kty": "EC", "crv": "P-256", "kid": "ta-2026", "x": "...", "y": "..." }]
    }
}
```

| Field         | Behavior                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Identifier in the tenant, also the file name in the config folder (`federation-trust-anchors/<id>.json`, [format](../reference/config-bundle-format.md)). |
| `entityId`    | The trust anchor's entity ID, an `https` URL without query or fragment, compared exactly. Each entity ID can be registered once per tenant.        |
| `description` | Optional text for operators.                                                                                                                   |
| `jwks`        | The trust anchor's federation keys: 1 to 20 public `EC`, `RSA` or `OKP` keys, each with a unique `kid` and at most 8192 characters of JSON. Private key members are rejected. |

In the Web Client, open **Cryptographic Assets → Federation Trust Anchors** (with `issuance:manage` or `presentation:manage`). **Register a trust anchor** asks for the ID, the entity ID and an optional description, and takes the keys as a JWK set in a JSON editor that checks them against the schema above. A trust anchor's page lists the pinned keys and which configurations name its entity ID; edit or delete it there. Where issuer settings and presentation configurations name a trust anchor, they offer the registered ones to choose from, flag an entity ID that is not registered and link to **Register trust anchor**, which opens in a new tab with the entity ID filled in.

`GET`, `PATCH` and `DELETE /api/federation-trust-anchor/{id}` read, change and remove a registration. For a key rollover, add the new key before the trust anchor signs with it and remove the old one afterwards. A change that adds an entity ID the tenant has not registered to an issuance configuration's `federation`, or to a presentation configuration's `openid_federation` entry (in a query without an `etsi_tl` entry, where federation decides), is rejected with `400`; so is a new configuration or an import naming one. A stored configuration naming an unregistered trust anchor still loads and can be changed otherwise; nothing is trusted through that trust anchor until it is registered. A configuration import ([config bundle or folder](../reference/config-bundle-format.md)) checks this in its plan, against the trust anchors of the tenant and of the import: a new or changed document is `blocked` with `MISSING_RESOURCE_REFERENCE`, so the import applies nothing, when it names an entity ID neither registers: a presentation config for every such entity ID, the issuance configuration only for one its stored version does not already name. A bundle can bring the trust anchor and the configurations naming it together.

### Delete a trust anchor

`DELETE /api/federation-trust-anchor/{id}`, and a `PATCH` that changes `entityId`, answer `409` while an issuance or presentation configuration of the tenant still names the entity ID: in the issuance configuration's `federation.trustAnchors`, or in an `openid_federation` entry of a query without an `etsi_tl` entry. The response names the configurations in `message` and lists them in `references`. Configurations the caller's roles cannot read are only counted, without ID and description: the issuance configuration needs `issuance:manage`, presentation configs `presentation:manage` or `presentation:request`. Changing `description` or `jwks` is not refused.

```json
{
    "statusCode": 409,
    "timestamp": "2026-10-17T12:00:00.000Z",
    "path": "/api/federation-trust-anchor/example-federation",
    "code": "FEDERATION_TRUST_ANCHOR_IN_USE",
    "message": "Federation trust anchor \"example-federation\" (https://ta.example.org) is still named by 1 presentation config (\"pid\") and the issuance configuration (federation.trustAnchors). Remove these references before deleting it.",
    "references": [
        { "kind": "PresentationConfig", "id": "pid", "description": "PID check" },
        { "kind": "IssuanceConfig" }
    ]
}
```

Remove the entity ID from these configurations first. To move to a new entity ID, register it as another trust anchor, switch the configurations to it, then delete the old registration. A configuration import that would give a trust anchor another entity ID, in any mode, or delete it, in `replace` mode, while a configuration surviving the import still names the old entity ID is `blocked` with `FEDERATION_TRUST_ANCHOR_IN_USE`; configurations the same import deletes or rewrites without the entity ID do not count.

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
    "trustAnchors": [
        { "entityId": "https://ta.example.org", "jwks": { "keys": [{ "kid": "ta-2026", "kty": "EC", "...": "..." }] } }
    ],
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

This is an EUDIPLO-specific API, not the Resolve endpoint of OpenID Federation (Section 8.3), and the answer is not signed. `metadata` is the metadata after the chain's policies were applied; `expiresAt` is the earliest `exp` of the chain. `trustAnchors` carries the registered keys of each trust anchor; the engine must accept only chains whose trust anchor entity configuration is signed with one of them, and must take the metadata from such a chain. EUDIPLO checks that the answer is about the requested entity and one of the requested trust anchors, that the last entry of `trustChain` is the trust anchor's entity configuration signed with a registered key, that it has not expired and that it contains one of the requested metadata types. A `4xx` answer other than `401`, `403`, `408` and `429` means the entity is not trusted; those (for `401` and `403`, check `FEDERATION_RESOLVER_TOKEN`), `5xx` answers, invalid answers and failed requests (10 seconds, 1 MiB) mean the federation is unavailable. Apart from the trust anchor's entity configuration, EUDIPLO trusts the engine's validation and does not check the chain again: the check proves that the engine resolved to the genuine trust anchor, not that the subordinate statements and `metadata` come from it. A compromised engine can still decide which keys are accepted, so run it with the same care as EUDIPLO.

## Limits and outbound requests

Entity configurations name the URLs EUDIPLO fetches, so every request goes through the [outbound URL policy](../concepts/security-model.md#https-and-tls) (HTTPS and public addresses unless allowed otherwise, `OUTBOUND_URL_ALLOWED_HOSTS`), except requests to EUDIPLO's own `PUBLIC_URL` or `INTERNAL_URL` origin. TLS certificates of federation entities are always verified, also outside `NODE_ENV=production`. The request to a trust engine is subject to the policy as well; its URL must use HTTPS.

One local resolution follows at most 8 superiors and 10 distinct `authority_hints` per entity, sends at most 32 requests, waits at most 5 seconds per request and reads at most 256 KiB per statement. Statements may differ from EUDIPLO's clock by `CRYPTO_TOLERANCE` seconds.

## Caching

A resolution is cached for `cacheTtlSeconds` of the issuance configuration (default 300, at least 5 seconds), never beyond the `exp` of its trust chain; DCQL queries use the default. Tenants with the same trust anchors and the same registered keys share the cache, and each uses a resolution only within its own `cacheTtlSeconds`. A failed resolution is retried after 10 seconds.

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
| `trustAnchors[].entityId`               | Trust anchor, [registered](#register-trust-anchors) with its keys. Its entity configuration is fetched from `{entityId}/.well-known/openid-federation`. Entity IDs are compared exactly, so `https://ta.example.org/` and `https://ta.example.org` are different trust anchors. |
| `trustAnchors[].entityConfigurationUri` | Required by the schema but not used.                                                                             |
| `entityId`                              | Your entity ID: `iss` of SD-JWT VCs with the `federation` trust format (below), `iss` and `sub` of the [published entity configuration](#publish-your-entity-configuration) and the `openid_federation:` client identifier. Leave it empty to only evaluate trust. Otherwise it must be an `https` URL with a host and without query, fragment, credentials or whitespace (OpenID Federation 1.0 Section 1.2); `POST /api/issuer/config` answers `400` for another value, and a startup import or bundle with one fails. `http` is accepted only with `OUTBOUND_URL_ALLOW_HTTP=true`, for local setups whose federation also allows it. |
| `cacheTtlSeconds`                       | How long resolutions are cached; default 300, at least 5. See [Caching](#caching).                              |
| `role`                                  | Only `leaf` (the default) is accepted; EUDIPLO does not act as a trust anchor or intermediate.                  |
| `enforceSigningPolicy`                  | Only `true` (the default) is accepted; federation checks are always enforced.                                    |

The fields of the published entity configuration are described [below](#publish-your-entity-configuration).

With this configuration, external authorization servers are checked before EUDIPLO fetches their metadata, and a chained authorization server's upstream provider before its discovery document is fetched.

### SD-JWT VC trust format

A credential configuration can sign SD-JWT VCs for federation instead of X.509: set `sdJwtTrustFormat` to `federation` (**Credential Types → SD-JWT Trust Format**). EUDIPLO then sets `iss` to the federation `entityId`, sets the `kid` header to the `kid` of the signing key and omits the `x5c` header. It falls back to `x5c` (the default) when no federation `entityId` or no trust anchor is configured, when a stored `entityId` breaks the rule above, or when `entityTypes` leaves out `openid_credential_issuer`, as verifiers would find the key nowhere else. The signing key chain is used in both cases.

```json
{ "alg": "ES256", "typ": "dc+sd-jwt", "kid": "<kid of the active key of the signing key chain>" }
```

A verifier finds that key in the `openid_credential_issuer` metadata of your entity configuration, which lists the public keys of all attestation and status list key chains of the tenant, the previous key of a rotation included. Status list JWTs always carry the `kid` of their signing key, so a verifier checks them against the same metadata. With `includeTrustChain`, the credential also carries your trust chain in the `trust_chain` header (Section 4.3 of OpenID Federation), resolved to your trust anchors like any other chain (and cached the same way); issuance fails when the chain cannot be resolved.

## Publish your entity configuration

A tenant with a federation `entityId` and at least one trust anchor publishes its signed entity configuration at:

```http
GET /issuers/{tenantId}/.well-known/openid-federation
```

The answer has the content type `application/entity-statement+jwt`; a tenant without `entityId` or trust anchors answers `404`. A federation fetches the entity configuration from `{entityId}/.well-known/openid-federation`, so set `entityId` to `{PUBLIC_URL}/issuers/{tenantId}`, the same identifier as the credential issuer. Another entity ID only works if your reverse proxy serves this endpoint at `{entityId}/.well-known/openid-federation`; `iss` and `sub` are always the configured `entityId`.

1. **Create a federation key** with usage type `federation` (**Cryptographic Assets → Keys → Create Key → OpenID Federation Entity Key**, or `POST /api/key-chain` with `"usageType": "federation", "type": "standalone"`). It only signs the entity configuration; credentials, status lists and requests are signed by the other key chains.
2. **Register the entity with your trust anchor** (or an intermediate): it needs the entity ID and the public key of the federation key chain for the subordinate statement it issues about you.
   Register the trust anchor with its keys in EUDIPLO too ([Register trust anchors](#register-trust-anchors)); without pinned keys it is not trusted, and `includeTrustChain` cannot resolve your chain.
3. **Configure the entity** in the `federation` block of the issuance configuration. The block describes the tenant's one federation entity, also when it acts only as a verifier:

    ```json
    {
        "federation": {
            "entityId": "https://eudiplo.example.com/issuers/membership-demo",
            "trustAnchors": [
                {
                    "entityId": "https://ta.example.org",
                    "entityConfigurationUri": "https://ta.example.org/.well-known/openid-federation"
                }
            ],
            "entityTypes": ["openid_credential_issuer", "openid_credential_verifier"],
            "authorityHints": ["https://ta.example.org"],
            "entityMetadata": { "organization_name": "Example Membership" },
            "includeTrustChain": false
        }
    }
    ```

| Field                                | Behavior                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entityTypes`                        | Metadata the entity configuration publishes: `openid_credential_issuer` (default) and `openid_credential_verifier`.                                            |
| `authorityHints`                     | `authority_hints`: HTTPS entity IDs of the superiors that issue a subordinate statement about you. Defaults to the trust anchor entity IDs.                    |
| `entityKeyChainId`                   | The federation key chain that signs the entity configuration. Without it, a key chain with usage type `federation` is used; set it when the tenant has several. |
| `entityConfigurationLifetimeSeconds` | `exp - iat` of the entity configuration, 60 to 31536000 seconds; default 86400.                                                                                |
| `trustMarks`                         | Trust mark JWTs issued to you, published in `trust_marks` with the `trust_mark_type` of each JWT. Saving a trust mark without `trust_mark_type` fails with `400`. |
| `entityMetadata`                     | `organization_name`, `contacts`, `logo_uri`, `policy_uri` and `homepage_uri` (HTTPS URLs) of the `federation_entity` metadata.                                  |
| `includeTrustChain`                  | Adds your trust chain as `trust_chain` header to federation SD-JWT VCs and to requests with the `openid_federation` client identifier.                          |

The entity configuration contains `iss` and `sub` (the entity ID), `iat`, `exp`, the active and previous public keys of the federation key chain in `jwks`, `authority_hints`, `trust_marks` and this `metadata`, built from the metadata EUDIPLO serves anyway:

| Metadata type                | Content                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `federation_entity`          | `entityMetadata`. No federation endpoints, as EUDIPLO provides none.                                                                                                        |
| `openid_credential_issuer`   | The [credential issuer metadata](../issuance/issuance-configuration.md) and, in `jwks`, the public keys of all attestation and status list key chains (`use: sig`).            |
| `oauth_authorization_server` | The metadata of the built-in authorization server, when it is advertised and its issuer equals the entity ID. External authorization servers publish their own entity.     |
| `openid_credential_verifier` | `vp_formats_supported`, `encrypted_response_enc_values_supported` and, in `jwks`, the public keys of all access key chains (`use: sig`) and the tenant encryption key (`use: enc`). |

EUDIPLO signs the entity configuration again at most once a minute, and at once after the `federation` block or the issuance configuration changes; a failure is answered for ten seconds before the next attempt. A key chain created, rotated or deleted in between shows within a minute. Only public key members (`kty`, `crv`, `x`, `y`, `n`, `e`, `kid`, `alg`, `use`) are published. `POST /api/issuer/config` replaces the whole `federation` block, so send the entity fields along with every update.

### Use an external trust engine

With `FEDERATION_ENTITY_PROVIDER=http`, EUDIPLO does not sign the entity configuration itself but sends `GET {FEDERATION_ENTITY_PROVIDER_URL}/entities/{tenantId}/entity-configuration` with `FEDERATION_ENTITY_PROVIDER_TOKEN` as bearer token, and serves the answer unchanged ([environment variables](../reference/environment-variables.md#federation)). Like a locally signed one, the answer is reused for up to a minute, or until the issuance configuration changes. The trust engine answers with `application/entity-statement+jwt` and the signed entity configuration; EUDIPLO only checks that it is an entity statement (`typ: entity-statement+jwt`) whose `iss` and `sub` equal the configured `entityId`. The trust engine then decides the keys and metadata, and the federation key chain and entity settings above other than `entityId` and `trustAnchors` are not used. The request is subject to the outbound URL policy, redirects are not followed, and an error answer, an invalid answer or a failed request (10 seconds, 256 KiB) answers `503`.

### OID4VP requests with a federation client identifier

With `openid_credential_verifier` in `entityTypes`, a presentation request can use `"clientIdScheme": "openid_federation"` ([Create requests](../presentation/requests.md#client-identifier)). The request then has `client_id` `openid_federation:<entityId>`, and its request object is signed with the access key chain as before, with a `kid` header of a key in the `openid_credential_verifier` metadata instead of `x5c`. A wallet takes the verifier metadata from your trust chain and ignores `client_metadata` (OID4VP 1.0 Section 5.9.3), so it encrypts the response to the tenant encryption key published there instead of a key for this request. Unlike `x509_hash` and `x509_san_dns` requests, whose response key exists only for one session, these responses can be decrypted with the long-lived tenant key: a leaked key exposes every captured federation response of the tenant. A response is still bound to its session by the `nonce` and `state` it must carry. Wallets may keep your trust chain until its `exp`, so after replacing the tenant encryption key, responses encrypted to the old key fail for up to `entityConfigurationLifetimeSeconds`. With `includeTrustChain`, the request object carries the trust chain in its `trust_chain` header; it is not sent as request parameter, because wallets built on `@openid4vc/openid4vp` 0.7 reject that parameter together with an `openid_federation:` client identifier. These wallets read the chain only from the parameter, so they ignore the header and resolve your trust chain themselves.

## Reference trust anchors in DCQL

Add an `openid_federation` entry with the entity IDs of [registered](#register-trust-anchors) trust anchors to `trusted_authorities`; without an `etsi_tl` entry in the query, a configuration naming an unregistered one is rejected. The entry is sent to the wallet unchanged. If it is the only entry, EUDIPLO accepts only SD-JWT VCs whose issuer chains to one of these trust anchors. An `etsi_tl` entry in the same query takes precedence: the issuer must then be in the trust list, as a credential is checked one way.

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
| Entity configuration endpoint       | OpenID Federation error responses (Section 8.9): `404` `not_found` when the tenant has no `entityId` or trust anchor, a stored `entityId` that the rule for `entityId` above refuses, for example one saved before 10.0 (the reason is in the server log), no key chain with usage type `federation`, or `entityKeyChainId` names no federation key chain; `503` `temporarily_unavailable` when the trust engine (`FEDERATION_ENTITY_PROVIDER=http`) does not deliver it; `500` `server_error` otherwise, with the reason in the server log |
| Presentation request                | `400`: `clientIdScheme openid_federation needs federation.entityId, at least one trust anchor and openid_credential_verifier in federation.entityTypes ...`, or `clientIdScheme openid_federation needs a valid federation.entityId ...` with the reason for a stored `entityId` saved before 10.0 |
| Request object fetched by the wallet | `400`: `The OpenID Federation verifier identity of this request is no longer configured`, when `entityId` or `entityTypes` changed after the request was created |
| Issuance or presentation configuration | `400`: `OpenID Federation trust anchors without pinned keys: <entity IDs>. ...`; [register](#register-trust-anchors) them first |
| Trust anchor registration           | `400` for an invalid entity ID or key; `409`: `Federation trust anchor '<id>' already exists`, `Trust anchor <entity ID> is already registered as '<id>'`, or `FEDERATION_TRUST_ANCHOR_IN_USE` ([Delete a trust anchor](#delete-a-trust-anchor)) |

Common reasons:

- `<entity> does not chain to a configured trust anchor`: the `authority_hints` do not lead to a configured trust anchor.
- `no trust anchor of <entity IDs> is registered with pinned keys`: none of the trust anchors is registered for the tenant, for example a configuration stored before 10.0 that names a trust anchor you have not registered yet. A warning in the log names trust anchors without keys.
- `... entity configuration of trust anchor '<entity ID>' is not signed with a configured key` (local resolver) or `entity configuration of trust anchor <entity ID> is not signed with a pinned key`: the trust anchor's host serves keys you did not register. Check the registered `jwks`, for example after a key rollover.
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
| `not signed with a configured key` or `... with a pinned key` | Compare the trust anchor's published keys with the registered `jwks` through a channel you trust, and update the registration. |
| `does not chain to a configured trust anchor`            | Check the trust anchor entity IDs, compared exactly, and the entity's `authority_hints`.                                  |
| `failed with status 404` from a fetch endpoint           | The superior does not list the entity as its subordinate; register the entity there.                                     |
| `has no key '<kid>'`                                     | The credential's `kid` must be in the `jwks` of the issuer's `openid_credential_issuer` metadata.                         |
| Your entity is not trusted by a verifier                 | Fetch `{entityId}/.well-known/openid-federation` and check `iss`, `authority_hints` and the keys; the trust anchor's subordinate statement must list the public key of your federation key chain. |
| A federation verifier rejects your credential's `kid`    | The `kid` must be in `openid_credential_issuer.jwks` of your entity configuration; it is renewed at most a minute after a key chain is created or rotated. |
| A changed federation still gives the old decision        | Resolutions are cached (see [Caching](#caching)). Clear the cache with `DELETE /api/cache/trust-list` or `DELETE /api/cache`. |

Cache activity is reported as the OpenTelemetry counters `federation_trust_cache_hits_total`, `federation_trust_cache_misses_total`, `federation_trust_cache_stale_total` and `federation_trust_fetches_total`.
