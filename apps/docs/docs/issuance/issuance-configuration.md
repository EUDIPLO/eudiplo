---
title: Issuance Configuration
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Registration Certificate in Issuer Metadata' -> trust/registration-certificates.md
  - 'Refresh Tokens' -> issuance/authorization-servers.md
  - 'Wallet and Key Attestation' -> trust/attestation.md
-->

Issuance configurations define runtime behavior for issuing credentials, such as authorization, token behavior, and trust-related requirements.

## Guided setup in the Web Client

Open **Credential Issuance → Issuer Settings → Use guided setup**. The editor also starts in guided mode when the issuer has no display information yet. Setup uses four steps:

1. **Identity** — enter the issuer display name(s), locale, and optional logo.
2. **Wallet access** — configure authorization servers. Expand **Issuance behavior (advanced)** to change batch size, DPoP requirement, credential request/response encryption, and notifications.
3. **Trust** — review trust requirements, including the transaction-code attempt limit, wallet attestation defaults, wallet provider trust lists, OpenID Federation, and issuer registration certificates.
4. **Review** — check the resulting configuration before choosing **Save settings**. Signing keys and certificates are managed under **Keys**; credential signing keys are selected in each credential configuration.

Press Enter in a single-line field or choose **Continue** to advance. Missing fields are highlighted when you continue. **Show all settings** enables direct tab navigation; profiles with existing display information open this way unless you explicitly choose guided setup. Both modes use the same form and preserve your changes. Errors in collapsed sections open those sections for correction. After saving, use **Configure a credential type** on the issuer overview to define what you issue.

## Basic Structure

**Example Issuance Configuration:**

```json
{
    "authorizationServers": [
        {
            "type": "external",
            "id": "external-corp-idp",
            "label": "Corporate IdP",
            "issuer": "https://auth.example.com"
        }
    ],
    "batchSize": 1,
    "dPopRequired": true,
    "walletAttestationRequired": false,
    "display": [
        {
            "name": "Demo Issuer",
            "locale": "en-US"
        }
    ]
}
```

:::info
The auto generated schema reference can be found in the [API Documentation](../reference/api.md)
:::

## Configuration Fields

- `authorizationServers` (array, required): Managed authorization server definitions. Must contain at least one entry and supports `external`, `oid4vp`, `chained`, and `built-in` types. See [Authorization](authorization-servers.md) for detailed configuration.
    - Each entry must define a non-empty `id`.
    - `id` values must be unique within the array.
    - `id` values `built-in` and `chained-as` are reserved and cannot be used.
- `batchSize` (number, optional): Value to determine the amount of credentials that are issued in a batch. Default is 1.
- `dPopRequired` (boolean, optional): Indicates whether DPoP is required for the issuance process. Default value is true.
- `signingKeyId` (string, optional): Key ID used for signing access tokens. If omitted, the default signing key for the tenant is used.
- `authorizationServers[].token.refreshTokenEnabled` (boolean, optional): Controls whether the token endpoint returns a refresh token in OID4VCI token responses. Default is `true`.
- `authorizationServers[].token.refreshTokenExpiresInSeconds` (number, optional): Lifetime of issued refresh tokens in seconds. Default is `2592000` (30 days).
- `txCodeMaxAttempts` (number, optional): Maximum failed `tx_code` attempts before invalidating pre-authorized code flow.
- `walletAttestationRequired` (boolean, optional): Default wallet attestation policy for EUDIPLO-managed authorization servers. Per-authorization-server values take precedence. Default value is false. See [Wallet and Key Attestation](#wallet-and-key-attestation) below.
- `walletProviderTrustLists` (array, optional): Shared trust lists for key attestations at the credential endpoint and default wallet authentication at managed authorization servers. Per-AS overrides apply only to wallet authentication.
- `credentialRequestEncryption` (boolean, optional): Advertise support for encrypted credential requests (`credential_request_encryption`).
- `credentialResponseEncryption` (boolean, optional): Advertise support for encrypted credential responses (`credential_response_encryption`).
- `federation` (object, optional): OpenID Federation trust configuration for auth-server/upstream trust evaluation. See [OpenID Federation](../trust/federation.md).
- `registrationCertificate` (object, optional): Controls whether a registration certificate is published in issuer metadata (`issuer_info`) and whether it is imported as JWT or generated from selected schema metadata.
- `display` (array of objects, required): The display information from the [OID4VCI spec](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-credential-issuer-metadata:~:text=2%20or%20greater.-,display,-%3A%20OPTIONAL.%20A%20non). To host images or logos, you can use the [storage](../operate/object-storage.md) system provided by EUDIPLO.

:::warning[Migration Note]
`authServers` and `chainedAs` are legacy fields. New configurations should use `authorizationServers` only. See [Migrating from 4.x to 5.0](https://github.com/openwallet-foundation/eudiplo/blob/v8.1.0/apps/docs/docs/migration/4.x-to-5.0.md) for the breaking-change mapping.
:::

## Authorization Servers

Authorization servers define how wallets authenticate before receiving credentials. EUDIPLO supports four types: `external`, `oid4vp`, `chained`, and `built-in`.

EUDIPLO-managed authorization servers (`oid4vp`, `chained`, and `built-in`) can define their own wallet attestation policy:

- `walletAttestationRequired` (boolean, optional): Require `OAuth-Client-Attestation` and `OAuth-Client-Attestation-PoP` headers on PAR and token requests for this AS.
- `walletProviderTrustLists` (array, optional): Trust lists used to validate wallet provider certificates for this AS.

When omitted on an authorization server, EUDIPLO falls back to the issuance-level `walletAttestationRequired` and `walletProviderTrustLists` values.

For complete configuration details and examples for each type, see the dedicated [Authorization](authorization-servers.md) page.

## Registration Certificate in Issuer Metadata

EUDIPLO can publish a registration certificate in the OID4VCI issuer metadata under `issuer_info` using:

- `import` mode: use an existing JWT from configuration.
- `generate` mode: derive provided attestations from configured credential types and generate via the registrar.

### Example Configuration

```json
{
    "registrationCertificate": {
        "enabled": true,
        "mode": "generate",
        "privacyPolicy": "https://issuer.example/privacy",
        "supportUri": "mailto:support@issuer.example"
    }
}
```

### When `generate` Mode Runs

Generation is **lazy/on-demand**. It is triggered when issuer metadata is built, for example when a wallet calls:

- `/.well-known/openid-credential-issuer/issuers/{tenant}`

Saving issuance configuration does not immediately generate a new registration certificate.

### Cache and Refresh Behavior

For `generate` mode, EUDIPLO caches the generated JWT in issuance configuration.

It reuses cache when:

- the effective registration certificate config fingerprint is unchanged, and
- the cached JWT is still active (not expired / not-before valid).

It regenerates when:

- `registrationCertificate` inputs or the derived credential-type attestation data change, or
- cached JWT is expired or not active.

### Mode-Specific Fields

- `import` mode:
    - `jwt` (required): existing registration certificate JWT.
- `generate` mode:
    - Attestation data is derived from configured credential types; `schemaMetadataIds` is not an issuer-settings input.
    - Enable the registrar for the tenant and configure supported credential types before generating a certificate.
    - `privacyPolicy` / `supportUri` (optional, can also be provided via registrar defaults).

### Notes

- If generation fails, issuer metadata is still returned, but `issuer_info` omits the registration certificate entry.
- Schema metadata management is documented in [Schema Metadata](../trust/registrar.md#schema-metadata-ts11).

## Refresh Tokens

EUDIPLO can issue refresh tokens from the OID4VCI token endpoint so wallets can obtain a new access token without re-running the authorization flow.

### Configuration

Configure refresh tokens in each managed authorization server’s `token` settings:

```json
{
    "authorizationServers": [
        {
            "id": "issuer-built-in",
            "type": "built-in",
            "enabled": true,
            "token": {
                "refreshTokenEnabled": true,
                "refreshTokenExpiresInSeconds": 2592000
            }
        }
    ]
}
```

### Field Reference

| Field                          | Type    | Required | Description                                                             |
| ------------------------------ | ------- | -------- | ----------------------------------------------------------------------- |
| `refreshTokenEnabled`          | boolean | No       | Enables refresh token issuance on the token endpoint. Default: `true`.  |
| `refreshTokenExpiresInSeconds` | number  | No       | Refresh token validity period in seconds. Default: `2592000` (30 days). |

### Behavior

When `refreshTokenEnabled` is `true`:

1. The token endpoint includes a `refresh_token` in the token response.
2. EUDIPLO stores the refresh token and its expiration time in the issuance session.
3. A wallet can later call the token endpoint with `grant_type=refresh_token` and the previously issued `refresh_token`.
4. EUDIPLO validates both the token value and the configured expiration before issuing a new access token.

When `refreshTokenEnabled` is `false`, no refresh token is returned.

### Web Client

The web client exposes both settings in the Issuance Configuration editor under Basic Information:

- `Issue Refresh Tokens`
- `Refresh Token Lifetime (seconds)`

## Wallet and Key Attestation

Wallet authentication and credential-key validation use separate attestations and configuration scopes:

| Attestation        | Verified at                                      | Trust configuration                                                 | Requirement setting                                                         |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Wallet attestation | Authorization server PAR and token endpoints     | AS `walletProviderTrustLists`, falling back to issuance-level lists | AS `walletAttestationRequired`, falling back to the issuance default        |
| Key attestation    | Credential endpoint, including deferred issuance | Issuance-level `walletProviderTrustLists`                           | Per-credential proof policy and advertised `config.keyAttestationsRequired` |

Wallet attestation authenticates the wallet as an OAuth client at the authorization server. When required, wallets provide OAuth Client Attestation headers at PAR and token endpoints, following [OID4VCI Appendix E](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#appendix-E). It is separate from the key attestation checked by the credential issuer during issuance.

### Wallet Authentication Flow

1. **Wallet Provider Signs Attestation**: The wallet provider (e.g., the wallet app vendor) signs a JWT attesting to the wallet instance's identity. This JWT includes an X.509 certificate chain in the `x5c` header.

2. **Wallet Sends Attestation**: At PAR and token endpoints, the wallet includes two headers:
    - `OAuth-Client-Attestation`: The wallet attestation JWT signed by the wallet provider
    - `OAuth-Client-Attestation-PoP`: A proof-of-possession JWT signed by the wallet instance

3. **Authorization Server Validates**: EUDIPLO validates the attestation by:
    - Verifying the JWT signature using the X.509 certificate from the `x5c` header
    - Verifying the proof-of-possession (PoP) JWT
    - Checking that the wallet provider's certificate is trusted according to the configured trust lists

### Wallet Authentication Configuration

To enable wallet attestation for one EUDIPLO-managed authorization server, set `walletAttestationRequired` and `walletProviderTrustLists` on that authorization server:

```json
{
    "authorizationServers": [
        {
            "type": "built-in",
            "id": "wallet-attested-as",
            "walletAttestationRequired": true,
            "walletProviderTrustLists": [
                {
                    "url": "https://trust-list.example.eu/wallet-providers",
                    "verifierX509Der": "MIIB..."
                }
            ]
        },
        {
            "type": "oid4vp",
            "id": "open-as",
            "presentationConfigId": "pid-flow",
            "walletAttestationRequired": false
        }
    ]
}
```

Issuance-level `walletAttestationRequired` and `walletProviderTrustLists` provide defaults for managed authorization servers. Omitted AS fields inherit independently; explicit `false` makes wallet attestation optional, while an explicit empty trust list disables inheritance and rejects any presented attestation. Optional means a wallet may omit attestation; any attestation it supplies must still be trusted.

The web editor offers **Use issuer default** for the requirement and **Use shared wallet provider trust lists** for trust. For an external authorization server, configure wallet authentication on that external server according to the credential issuer's trust policy.

### Key Attestation Trust

The issuance-level `walletProviderTrustLists` also validates key-attestation signers at the credential endpoint. This applies to both `proofs.attestation` and `key_attestation` in a JWT proof's protected header, including deferred issuance. AS-specific lists do not override this issuer policy. Configure the shared lists even if wallet authentication is optional or handled by an external AS.

For example, merge these settings into the issuance configuration to share provider trust between key validation and a built-in AS:

```json
{
    "walletProviderTrustLists": [
        {
            "url": "https://trust-list.example.eu/wallet-providers",
            "verifierX509Der": "MIIB..."
        }
    ],
    "authorizationServers": [
        {
            "type": "built-in",
            "id": "wallet-attested-as",
            "walletAttestationRequired": true
        }
    ]
}
```

Replace the example URL and certificate with your authenticated trust-list source. The AS inherits the shared list because its own `walletProviderTrustLists` is omitted. Defining a list only inside an AS entry does not configure key-attestation trust.

Each list reference contains its URL and a `verifierKey` or `verifierX509Der` that authenticates the list. The list supplies wallet-provider certificates used to validate attestation signing chains. Configure [credential proof types and key-attestation requirements](credential-configuration.md#key-attestation) separately to advertise key-security requirements.

Presented wallet and key attestations are rejected if no trust list is configured for their verification. Plain holder JWT proofs without a key attestation do not need provider trust lists. Deployments that previously relied on accepting attestations without configured provider trust must add trust lists before upgrading.

### Trust Lists

EUDIPLO consumes signed LoTE (List of Trusted Entities) JWTs. Wallet-provider entries use `http://uri.etsi.org/19602/SvcType/WalletSolution` or its `/Issuance` and `/Revocation` service roles.

Each trusted entity in the list includes X.509 certificates that identify authorized wallet providers. When a wallet presents an attestation, EUDIPLO verifies that the signing certificate chains to one of these trusted certificates.

### Wallet Attestation Status

The wallet attestation JWT may optionally contain a `status` claim that provides a URI for checking the current validity or revocation status of the attestation. According to the [OAuth Attestation-Based Client Authentication](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-attestation-based-client-auth) specification, this claim is **optional**.

EUDIPLO checks a supplied wallet-attestation status claim and rejects revoked or suspended attestations. Its current status checker logs fetch failures and continues; requiring provider trust does not change that existing behavior. This is not a complete implementation of all ARF lifecycle and revocation requirements.

:::warning[Important]
If `walletAttestationRequired` is set to `true` for an authorization server but neither that server nor the issuance-level defaults provide trust lists, **wallet requests to that authorization server will be rejected**. Always configure at least one trust list when enabling wallet attestation.
:::

:::info[EUDI Wallet Ecosystem]
The [ARF trust model](https://eudi.dev/latest/main/06-trust-model/#622-wallet-provider-notification) identifies the Commission-published Wallet Provider LoTE as the source of notified wallet-provider trust anchors for wallet and key attestations. Authenticate this list using verification material obtained through a trusted channel.
:::
