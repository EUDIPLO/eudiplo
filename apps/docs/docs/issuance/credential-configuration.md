---
title: Configure a credential
sidebar_label: Credential configuration
---

A credential configuration defines one credential type your tenant issues: its format, type identifier, claims, wallet display and signing behavior. This page walks through the decisions; every field is listed in the [credential configuration reference](../reference/credential-configuration.md).

**Prerequisites:** a tenant and a client with the `issuance:manage` role, and an issuer [signing key and certificate](../trust/keys-and-certificates.md). The [first-credential cookbook](../cookbooks/first-credential.md) shows the same steps in the web client (**Credential Issuance → Credential Configs**).

## 1. Choose format and type

| Format | `config.format` | Type identifier | Notes |
| --- | --- | --- | --- |
| SD-JWT VC | `dc+sd-jwt` | `vct` (required) | A string is used as is. An object (`name`, `description`, `extends`, `schema_uri`, …) is hosted by EUDIPLO at `/issuers/{tenant}/credentials-metadata/vct/{id}`, and that URL becomes the `vct`. |
| mDOC (ISO 18013-5) | `mso_mdoc` | `config.docType` | Claims are grouped by the `namespace` of each field. |

SD-JWT VCs are issued with `iss` = `{PUBLIC_URL}/issuers/{tenant}` and the certificate chain in the `x5c` header. Set `sdJwtTrustFormat: "federation"` to use the [OpenID Federation](../trust/federation.md) entity ID instead.

## 2. Define the claims

Each entry of `fields[]` describes one claim: its `path`, `type`, whether it is `mandatory` and, for SD-JWT VC, whether it is `disclosable`. Both default to `false`, so set `disclosable: true` for every claim the holder should be able to disclose selectively. `iss`, `nbf`, `exp`, `cnf`, `vct`, `vct#integrity` and `status`, and claims below them, cannot be disclosable: issuing then fails. For a date in an mDOC credential, add `"format": "date"` (or `"date-time"`) to its `string` field, so it is issued as `full-date` or `tdate` as ISO/IEC 18013-5 and the PID Rulebook require ([Dates](claims.md#dates)).

```json
{
    "fields": [
        {
            "path": ["name"],
            "type": "string",
            "mandatory": true,
            "disclosable": true,
            "display": [
                { "locale": "en", "name": "Name" },
                { "locale": "de", "name": "Name" }
            ]
        },
        {
            "path": ["address"],
            "type": "object",
            "disclosable": true,
            "children": [
                { "path": ["locality"], "type": "string", "disclosable": true }
            ]
        },
        {
            "path": ["nationalities"],
            "type": "array",
            "disclosable": true,
            "children": [
                { "path": [null], "type": "string", "disclosable": true }
            ]
        }
    ]
}
```

- Nest claims with `children`; child paths are relative to the parent. `null` in a path stands for every array element (the web client writes it as `nationalities.*`), an integer for one element. The issuer metadata publishes these paths with `null` and integers as well.
- A disclosable element path gives every element of the issued array its own disclosure (SD-JWT, RFC 9901 Section 4.2.2), so the holder can disclose some elements and withhold others. In the example the array and its elements are both disclosable, as the EUDI PID rules require (ARF Annex 2, PID_21); with only `["nationalities"]` disclosable, the holder discloses the array as a whole. The elements are taken from the claims being issued: an empty array has no element disclosures, and an index beyond the end of the array is ignored. Properties of array elements work the same way, for example `["addresses", null, "street"]`.
- `display` entries use `{ "locale", "name" }` and are published in the issuer metadata.
- For mDOC, set `namespace` on each field, for example `eu.europa.ec.eudi.pid.1`. Without it, the first segment of a nested path or the document type is used.
- `defaultValue` provides a static value. Where claim values come from and how they are validated is described in [Claims](claims.md).

## 3. Set the wallet display

`config.display[]` controls how wallets render the credential, one entry per locale:

```json
{
    "config": {
        "format": "dc+sd-jwt",
        "display": [
            {
                "name": "Membership",
                "locale": "en",
                "description": "Example membership card",
                "background_color": "#12107c",
                "text_color": "#FFFFFF",
                "logo": { "uri": "https://issuer.example.com/logo.png" },
                "background_image": { "uri": "https://issuer.example.com/card.png" }
            }
        ]
    }
}
```

Only `name` and `locale` are required, and each locale may appear once. Colors are CSS Color Level 3 numerical values, as OID4VCI requires: `#rgb`, `#rrggbb`, `transparent`, or lowercase `rgb()`, `rgba()`, `hsl()` or `hsla()` with comma-separated values, for example `rgb(18, 16, 124)`. Without `background_color` or `text_color`, wallets use their own colors.

Images use `uri`. To host them in EUDIPLO, see [Object storage](../operate/object-storage.md).

## 4. Choose key binding and proofs

- `keyBinding: true` puts the wallet's key into the SD-JWT VC (`cnf`), so the holder must prove possession when presenting. mDOCs always carry the device key: `keyBinding` does not apply to them, and they always need a proof.
- Without `keyBinding` (`false` is the default) and without `config.keyAttestationsRequired`, the SD-JWT VC is bound to no key. Its issuer metadata then has neither `cryptographic_binding_methods_supported` nor `proof_types_supported`, and the wallet sends its credential request without `proofs` (OpenID4VCI 1.0 sections 8.2 and 12.2.4). Each request yields one credential, whatever `batchSize` says. Proofs that a wallet sends anyway are ignored: they are not verified, consume no nonce and add no credentials. `config.proofTypesSupported` has no effect then.
- `config.keyAttestationsRequired` without `keyBinding` still needs a proof with a key attestation in every request, so the wallet unit is known (for example for `revokeWithWalletUnit`). The metadata then keeps `cryptographic_binding_methods_supported` and `proof_types_supported`, and the SD-JWT VC still carries no `cnf`.
- Wallets prove their key at the credential endpoint with a JWT proof or a key attestation. `config.proofTypesSupported` limits the accepted proof types (`jwt`, `attestation`; default both). `config.keyAttestationsRequired` requires a trusted key attestation with an accepted `key_storage` and `user_authentication` level for every proof, and publishes it as `key_attestations_required` under both `jwt` and `attestation` in `proof_types_supported`. With the `attestation` proof type, one key attestation may carry up to `batchSize` keys and yields one credential per key. How key attestations are verified and trusted is described in [Wallet and key attestation](../trust/attestation.md).

## 5. Set the lifetime and signing key

- `lifeTime` (seconds) sets the expiry. SD-JWT VCs without `lifeTime` have no `exp`, unless `revokeWithWalletUnit` bounds it. mDOCs default to one year and never outlive the signing certificate. Issuance and expiry times are rounded to the hour so that credentials of one batch cannot be linked by their timestamps. With `revokeWithWalletUnit`, the expiry also ends before the status maintenance period of the wallet and key attestations ([Expiry within the status maintenance period](../trust/attestation.md#expiry-within-the-status-maintenance-period)).
- `keyChainId` selects the signing key chain. Without it, the tenant's default attestation key chain signs the credential.

## 6. Enable revocation

Set `statusManagement: true` to add a status list entry to every credential, so you can revoke or suspend it later. See [Revoke and suspend credentials](revocation.md).

### Keep one active credential per subject

`activeCredentials` keeps at most one active credential of this configuration per person: when the same subject receives a new credential, EUDIPLO revokes the previous ones.

```json
{
    "statusManagement": true,
    "activeCredentials": { "enabled": true, "tracking": "internal" }
}
```

- Requires `statusManagement: true`. Since 9.0, the API and the configuration import reject the policy without it.
- The subject is the `iss` and `sub` of an [external authorization server's](authorization-servers.md#external) access token. Tokens of the built-in, chained and OID4VP authorization servers carry no durable subject that EUDIPLO binds to the session, so the policy is skipped for them.
- All credentials issued with one access token form one set (for example a batch of 40 fetched in four requests). The first credential issued with a new access token, including a refreshed one, revokes the previous set.
- A different issuer or subject identifier counts as a different person. EUDIPLO stores only a pseudonymous, configuration-scoped fingerprint of the subject, derived from the encryption root key, so that key must stay stable while active credentials exist.
- Revocation is only seen by verifiers that check the status list.

How the fingerprints and the revocation sequence work is described in [Issuance under the hood](../concepts/issuance.md).

### Revoke credentials with their wallet unit

`revokeWithWalletUnit: true` revokes a credential when the wallet provider revokes a wallet unit attestation it was issued under: the key attestation of the proof, or the wallet attestation presented at the token endpoint of the built-in authorization server. It requires `statusManagement: true` and `config.keyAttestationsRequired`. See [Revoke credentials with their wallet unit](../trust/attestation.md#revoke-credentials-with-their-wallet-unit).

## 7. Publish EUDI policies (optional)

### Publish a reuse policy

`config.credentialReusePolicy` publishes how wallets should use a batch of credentials, as defined in ARF Annex II. EUDIPLO publishes it as `credential_metadata.credential_reuse_policy` of the credential configuration in the issuer metadata; it does not enforce it.

```json
{
    "config": {
        "credentialReusePolicy": {
            "id": "arf_annex_ii",
            "options": [
                {
                    "details": ["once_only"],
                    "batch_size": 10,
                    "reissue_trigger_unused": 2
                },
                {
                    "details": ["limited_time"],
                    "reissue_trigger_lifetime_left": 86400
                }
            ]
        }
    }
}
```

`details` accepts `once_only`, `limited_time` (or `limited-time`), `rotating-batch` and `per-relying-party`. The required companion fields per value are listed in the [reference](../reference/credential-configuration.md). Wallets fetch several credentials at once only if the issuer's [`batchSize`](issuance-configuration.md) is larger than 1 and the configuration needs key proofs (one credential per proven key); a configuration without key binding yields one credential per request ([section 4](#4-choose-key-binding-and-proofs)).

### Publish an embedded disclosure policy

`embeddedDisclosurePolicy` tells wallets to which relying parties the credential may be disclosed. EUDIPLO publishes it as `disclosure_policy` of the credential configuration in the issuer metadata. The `policy` field selects the variant:

| `policy` | `values` |
| --- | --- |
| `none` | none |
| `allowList` | Array of relying party identifiers |
| `rootOfTrust` | One trust anchor identifier |
| `attestationBased` | Array of requirements, each with `credentials` (and optional `claims`, `credential_sets`) the relying party must present |

```json
{
    "embeddedDisclosurePolicy": {
        "policy": "allowList",
        "values": ["https://verifier.example.com"]
    }
}
```

#### Revoke credentials when the policy changes

The EUDI Wallet ARF (Annex 2, EDP_11) requires an attestation provider to revoke the attestations whose embedded disclosure policy is added, changed or deleted. EUDIPLO does this only when you ask for it in the update, with the query parameter `revokeOnDisclosurePolicyChange=true`:

```bash
curl -X PATCH "$EUDIPLO_URL/api/issuer/credentials/membership?revokeOnDisclosurePolicyChange=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"embeddedDisclosurePolicy": {"policy": "allowList", "values": ["https://verifier-b.example.com"]}}'
```

- Without the parameter (or with `false`), an update changes the policy and revokes nothing. The parameter is not stored, and any other value is rejected with `400`.
- With it, the update revokes every credential the tenant issued under this credential configuration that has a [status list entry](revocation.md), in the same status lists that `POST /api/session/revoke` changes, so verifiers see the change as described in [Check the result](revocation.md#3-check-the-result). Credentials issued without status management have no entry and stay valid. Revocation is final.
- It revokes only when `embeddedDisclosurePolicy` is in the body and differs from the stored one. Policies are compared by value: key order and `$schema` do not count, the order of `values` does. Sending the stored policy again, or an update without the field, revokes nothing.
- The credentials are revoked before the new policy is stored. If revoking fails, the update answers with an error and the stored policy is unchanged; send the same request again to finish. After storing the policy, EUDIPLO revokes once more the credentials issued while the update ran. That second pass is best effort: if it fails, the update still succeeds and the failure is logged. A credential issued under the new policy in that short window is revoked too, and an issuance that read the old policy but gets its status entry only after the second pass is not covered.
- It needs no role beyond `issuance:manage`, which already allows `POST /api/session/revoke`. With the parameter, a client [limited to some credential configurations](../operate/tenants-and-access.md#api-clients-with-least-privilege) gets `403` for any other configuration, even if the policy does not change.
- Imports from the configuration folder and configuration bundles never revoke credentials, and neither does the Web Client's edit form. Use the API to revoke.

Issuer registration certificates are covered in [Registration certificates](../trust/registration-certificates.md#issuer-registration-certificate). TS11 schema metadata (`schemaMeta`) is stored with the configuration; EUDIPLO currently publishes it nowhere ([field reference](../reference/credential-configuration.md)).

## 8. Create the configuration

```bash
curl -X POST "$EUDIPLO_URL/api/issuer/credentials" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @membership.json
```

Update a configuration with `PATCH /api/issuer/credentials/{id}`, list them with `GET /api/issuer/credentials`, and remove one with `DELETE /api/issuer/credentials/{id}`. To manage configurations as files, see [Configuration as code](../operate/configuration-as-code.md).

**Check:** the credential appears in `credential_configurations_supported` of `GET /.well-known/openid-credential-issuer/issuers/{tenant}`. Next, [create an offer](credential-offers.md).
