---
title: Wallet Compatibility
---

EUDIPLO is designed to work with **EUDI-compliant wallets** that implement the supported protocols ([OID4VCI](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html), [OID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html), and [SD-JWT VC](https://www.ietf.org/archive/id/draft-ietf-oauth-selective-disclosure-jwt-08.html)).

This page provides information about tested wallets, compatibility status, and guidance for testing new wallets with EUDIPLO.

## Conformance Testing

With the rapidly evolving EUDI wallet ecosystem and frequent updates across multiple wallets, it is not feasible to manually test every wallet with every EUDIPLO release. Instead, EUDIPLO ensures interoperability through **automated conformance testing**.

EUDIPLO is tested with every code change against the [OpenID Foundation Conformance Test Suite](https://openid.net/certification/about-conformance-suite/) for both **issuance (OID4VCI)** and **presentation (OID4VP)**. This ensures that EUDIPLO consistently adheres to the official specifications.

:::tip[Compatibility Guarantee]
Any wallet that also passes the OIDF Conformance Test Suite should be compatible with EUDIPLO out of the box. If you encounter issues with a conformant wallet, please [report it](https://github.com/openwallet-foundation/eudiplo/issues/new) so we can investigate.
:::

## Tested Wallets

The following wallets have been tested and verified to work with EUDIPLO:

| Wallet                      | Provider                                                                       | Download                                                                                                                                              | Features                                |
| --------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| EU Reference Implementation | [EC](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui) | [Android](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui/releases)                                                          | [Details](#reference-implementation)    |
| Paradym Wallet              | [Animo](https://animo.id)                                                      | [Android](https://play.google.com/store/apps/details?id=id.paradym.wallet) / [iOS](https://apps.apple.com/nl/app/paradym-wallet/id6449846111?l=en-GB) | [Details](#paradym-wallet)              |
| Multipaz                    | [Multipaz](https://multipaz.com)                                               | [Android](https://apps.multipaz.org/)                                                                                                                 | [Details](#multipaz)                    |
| AV Reference Implementation | [EC](https://github.com/eu-digital-identity-wallet/av-app-android-wallet-ui)   | [Android](https://github.com/eu-digital-identity-wallet/av-app-android-wallet-ui/releases)                                                            | [Details](#av-reference-implementation) |

### Feature Support Details

#### Feature Legend

- **Issuance (OID4VCI)**
    - **Auth**: Authorization Code Flow
    - **Pre**: Pre-authorized Code Flow
    - **IAE**: Interactive Authorization Endpoint (IAE) support
    - **DPoP**: DPoP proof of possession
    - **Att**: Wallet attestation support
- **Presentation (OID4VP)**
    - **DC API**: Digital Credentials API support
- **Presentation (ISO 18013-7)**
    - **Annex C**: `org-iso-mdoc` protocol via the Digital Credentials API
- **Credential Format**
    - **SD-JWT**: SD-JWT VC support

:::note[KISS: Keep It Simple, Stupid]
The legend above explains the abbreviations used in the feature matrix below. If you think any other features should be tracked, please let us know!
:::

#### Feature Matrix

| Wallet                      | Auth | Pre | IAE | DPoP | Att | DC API | Annex C | SD-JWT | Mdocs |
| --------------------------- | ---- | --- | --- | ---- | --- | ------ | ------- | ------ | ----- |
| Reference Implementation    | ✅   | ✅  | n/a | ✅   | ✅  | n/a    | —       | ✅     | ✅    |
| Paradym Wallet              | ✅   | ✅  | n/a | ✅   | n/a | ✅     | —       | ✅     | ✅    |
| Multipaz                    | ✅   | ✅  | n/a | ✅   | n/a | ✅     | —       | ✅     | ✅    |
| AV Reference Implementation | —    | ✅  | n/a | —    | —   | —      | ✅      | n/a    | ✅    |

("—" means not yet tested against EUDIPLO.)

#### Individual Wallet Details

##### Reference Implementation

- **Version tested**: 2026.02.26-Demo
- **Last verified**: February 26, 2026
- **Notes**:
    - Forces Wallet attestation
- **Log access**: Inside the app, go to "Setting" > "Retrieve Logs"

##### Paradym Wallet

- **Version tested**: 1.20.2
- **Last verified**: Sep 21, 2026
- **Notes**:
    - Needs to use the same certificate for status list and signed credential. Cannot handle different `trusted_authorities` in the DCQL during presentation yet (which result in no match).
- **Log access**: Inside the app, go to "Settings" > "Export Logs"

:::note[Help us expand this list!]
If you have successfully tested EUDIPLO with a wallet not listed here, please [reach out to us](https://github.com/openwallet-foundation/eudiplo/issues/new?template=wallet-compatibility.md) so we can add it to this list.
:::

##### Multipaz

- **Version tested**: 2026.W24.0-impl-verification-links-17-git-6cfc8e8
- **Last verified**: June 17, 2026
- **Notes**:
    - Using the logo for the card of a credential

##### AV Reference Implementation

- **Version tested**: July 2026 demo build (Android, via Chrome DC API)
- **Last verified**: July 9, 2026
- **Notes**:
    - Tested for the ISO 18013-7 Annex C flow: mdoc issuance (pre-authorized code flow) and `org-iso-mdoc` presentation via the Digital Credentials API, including HPKE response decryption and DeviceAuth verification.
    - mdoc-only wallet; SD-JWT VC is not applicable.
    - Its reference IACA/DS certificates carry a malformed `issuerAltName` extension; EUDIPLO parses them through a tolerant X.509 extension parser registered at startup (reported upstream).

## Testing New Wallets

EUDIPLO validates protocol interoperability automatically (OIDF conformance), but wallet-specific behavior should still be verified manually.

The following workflow is the recommended way to test a new wallet end-to-end.

### 1. Setup a Test Environment

1. Start EUDIPLO using the [Quick Start](../cookbooks/foundation.md).
2. Complete the initial tenant and credential setup from [Issue Your First Credential](../cookbooks/first-credential.md).
3. For testing with a mobile wallet, expose EUDIPLO on a public HTTPS URL and set `PUBLIC_URL` to that URL (for example via ngrok as described in [Running Locally](../contributing/development-setup.md)).

Minimal backend example:

```bash
docker run -d \
  --name eudiplo \
  -p 3000:3000 \
  -e PUBLIC_URL=https://your-public-host.example \
  -e MASTER_SECRET=$(openssl rand -base64 32) \
  -e AUTH_CLIENT_ID=demo \
  -e AUTH_CLIENT_SECRET=demo-secret \
  ghcr.io/openwallet-foundation-labs/eudiplo:latest
```

### 2. Prepare Wallet-Compatible Test Data

Use a minimal, known-good configuration first:

1. Create a credential configuration from a template (for example PID SD-JWT VC).
2. Configure issuance with **DPoP disabled** for initial compatibility checks.
3. Ensure signing keys/certificates are available for the tenant.
