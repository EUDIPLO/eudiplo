---
title: Wallet Compatibility
description: Wallets tested with EUDIPLO, their supported features and how to test a new wallet.
---

# Wallet compatibility

This page records which wallets have been tested with EUDIPLO and which features worked. EUDIPLO itself is tested against the [OpenID Foundation conformance suite](https://openid.net/certification/about-conformance-suite/) for OID4VCI and OID4VP with every change, so a wallet that passes the same suite should work without wallet-specific configuration.

If a conformant wallet does not work with EUDIPLO, [open an issue](https://github.com/openwallet-foundation/eudiplo/issues/new).

## Tested wallets

| Wallet                      | Provider                                                                       | Download                                                                                                                                              | Details                                 |
| --------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| EU Reference Implementation | [EC](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui) | [Android](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui/releases)                                                          | [Details](#reference-implementation)    |
| Paradym Wallet              | [Animo](https://animo.id)                                                      | [Android](https://play.google.com/store/apps/details?id=id.paradym.wallet) / [iOS](https://apps.apple.com/nl/app/paradym-wallet/id6449846111?l=en-GB) | [Details](#paradym-wallet)              |
| Multipaz                    | [Multipaz](https://multipaz.com)                                               | [Android](https://apps.multipaz.org/)                                                                                                                 | [Details](#multipaz)                    |
| AV Reference Implementation | [EC](https://github.com/eu-digital-identity-wallet/av-app-android-wallet-ui)   | [Android](https://github.com/eu-digital-identity-wallet/av-app-android-wallet-ui/releases)                                                            | [Details](#av-reference-implementation) |

### Feature matrix

| Wallet                      | Auth | Pre | IAE | DPoP | Att | DC API | Annex C | SD-JWT | mdoc |
| --------------------------- | ---- | --- | --- | ---- | --- | ------ | ------- | ------ | ---- |
| Reference Implementation    | ✅   | ✅  | n/a | ✅   | ✅  | n/a    | —       | ✅     | ✅   |
| Paradym Wallet              | ✅   | ✅  | n/a | ✅   | n/a | ✅     | —       | ✅     | ✅   |
| Multipaz                    | ✅   | ✅  | n/a | ✅   | n/a | ✅     | —       | ✅     | ✅   |
| AV Reference Implementation | —    | ✅  | n/a | —    | —   | —      | ✅      | n/a    | ✅   |

| Column  | Meaning                                                                                   |
| ------- | ----------------------------------------------------------------------------------------- |
| Auth    | OID4VCI authorization code flow                                                           |
| Pre     | OID4VCI pre-authorized code flow                                                          |
| IAE     | OID4VCI interactive authorization endpoint                                                |
| DPoP    | DPoP-bound access tokens                                                                  |
| Att     | Wallet attestation (OAuth client attestation)                                             |
| DC API  | OID4VP over the Digital Credentials API                                                   |
| Annex C | ISO 18013-7 Annex C (`org-iso-mdoc`) over the Digital Credentials API                     |
| SD-JWT  | SD-JWT VC credentials (`dc+sd-jwt`)                                                       |
| mdoc    | mdoc credentials (`mso_mdoc`)                                                             |
| Values  | ✅ works · — not yet tested with EUDIPLO · n/a the wallet does not support the feature    |

### Reference Implementation

- **Version tested:** 2026.02.26-Demo
- **Last verified:** February 26, 2026
- **Notes:** requires wallet attestation.
- **Logs:** in the app, **Settings → Retrieve Logs**.

### Paradym Wallet

- **Version tested:** 1.20.2
- **Last verified:** September 21, 2026
- **Notes:** the status list and the credential must be signed with the same certificate. The wallet cannot yet handle differing `trusted_authorities` in a DCQL query; such queries result in no match.
- **Logs:** in the app, **Settings → Export Logs**.

### Multipaz

- **Version tested:** 2026.W24.0-impl-verification-links-17-git-6cfc8e8
- **Last verified:** June 17, 2026
- **Notes:** shows the credential's logo on the card.

### AV Reference Implementation

- **Version tested:** July 2026 demo build (Android, Digital Credentials API in Chrome)
- **Last verified:** July 9, 2026
- **Notes:**
    - Tested for ISO 18013-7 Annex C: mdoc issuance with the pre-authorized code flow, and `org-iso-mdoc` presentation over the Digital Credentials API, including HPKE response decryption and DeviceAuth verification.
    - mdoc-only wallet; SD-JWT VC does not apply.
    - Its reference IACA and document signer certificates carry a malformed `issuerAltName` extension. EUDIPLO parses them with a tolerant X.509 extension parser (reported upstream).

## Testing a new wallet

Protocol conformance is tested automatically; wallet-specific behavior still needs a manual run.

1. **Set up EUDIPLO.** Follow [Foundation](../cookbooks/foundation.md) and [Issue your first credential](../cookbooks/first-credential.md). A mobile wallet needs a public HTTPS URL, so set `PUBLIC_URL` to a tunnel or public host. Without the CLI, a minimal container is:

   ```bash
   docker run -d --name eudiplo -p 3000:3000 \
     -e PUBLIC_URL=https://your-public-host.example \
     -e MASTER_SECRET="$(openssl rand -base64 32)" \
     -e AUTH_CLIENT_ID=root \
     -e AUTH_CLIENT_SECRET="$(openssl rand -base64 24)" \
     ghcr.io/openwallet-foundation/eudiplo:latest
   ```

2. **Start with a known-good configuration.** Create a credential configuration from a template (for example PID as SD-JWT VC), make sure the tenant has signing keys and certificates, and leave DPoP off for the first run.
3. **Test issuance.** The pre-authorized code flow is required: create an offer, scan it, and confirm the credential is stored. Then test the authorization code flow if the wallet supports it, and confirm that a redeemed or expired offer is rejected.
4. **Test presentation.** Create a request from a presentation configuration and run it cross-device (QR code on another device) and, if supported, same-device. Confirm the session completes with the expected claims, then repeat with a query that requests fewer claims to check selective disclosure.
5. **Record the result.** Note the wallet name and exact version, device and OS version, which flows passed or failed, configuration changes you needed (for example DPoP off), and error messages or wallet logs.

## Report results

- **Wallet works:** open an issue with the [wallet compatibility template](https://github.com/openwallet-foundation/eudiplo/issues/new?template=wallet-compatibility.md) and include the results from step 5, so the wallet can be added to this page.
- **Wallet fails:** check the notes above, then open an [issue](https://github.com/openwallet-foundation/eudiplo/issues/new) with reproduction steps, EUDIPLO and wallet versions, and the [session logs](../operate/logging.md).
- **Questions:** ask in the [Discord community](https://discord.gg/58ys8XfXDu).
