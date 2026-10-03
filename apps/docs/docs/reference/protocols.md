---
title: Supported Protocols
description: Standards support matrix for issuance, presentation, credential formats, status and trust.
---

# Supported protocols

This page lists every standard and feature EUDIPLO implements, grouped by area, with a link to the guide that explains how to use it. EUDIPLO implements only the protocols of the EUDI Wallet ecosystem, so it stays interoperable with the reference wallets and uses one trust model.

**Legend:** ✅ supported · ⚠️ partial or experimental (see note) · ❌ not supported

## Specifications

| Specification                                                                                                                                       | Role in EUDIPLO                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [OpenID for Verifiable Credential Issuance 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html) (OID4VCI)               | Issuance to wallets                             |
| [OpenID for Verifiable Presentations 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html) (OID4VP)                            | Presentation requests and verification          |
| [SD-JWT-based Verifiable Credentials](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/) (SD-JWT VC)                                    | Credential format `dc+sd-jwt`                   |
| [ISO/IEC 18013-5](https://www.iso.org/standard/69084.html) (mdoc)                                                                                   | Credential format `mso_mdoc`                    |
| ISO/IEC 18013-7 Annex C                                                                                                                             | mdoc presentation over the Digital Credentials API |
| [Token Status List](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/)                                                                 | Revocation and suspension                       |
| [OAuth 2.0 PAR (RFC 9126)](https://www.rfc-editor.org/rfc/rfc9126), [PKCE (RFC 7636)](https://www.rfc-editor.org/rfc/rfc7636), [DPoP (RFC 9449)](https://www.rfc-editor.org/rfc/rfc9449) | Authorization servers hosted by EUDIPLO         |
| [OAuth 2.0 Attestation-Based Client Authentication](https://datatracker.ietf.org/doc/draft-ietf-oauth-attestation-based-client-auth/)              | Wallet attestation                              |
| ETSI TS 119 602 List of Trusted Entities (LoTE)                                                                                                     | Trust lists                                     |
| [OpenID Federation 1.0](https://openid.net/specs/openid-federation-1_0.html)                                                                        | Federation-based trust (partial)                |

## OID4VCI (issuance)

| Feature                                    | Status | Notes                                                                                                                                       | Guide                                                         |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Pre-authorized code flow                   | ✅     | Optional `tx_code`; the code is locked after too many wrong attempts                                                                        | [Credential offers](../issuance/credential-offers.md)         |
| Authorization code flow                    | ✅     | Built-in, external, chained and OID4VP-based authorization servers                                                                          | [Authorization servers](../issuance/authorization-servers.md) |
| Pushed authorization requests (PAR)        | ✅     | Required by every authorization server EUDIPLO hosts; wallet-initiated requests without `issuer_state` are accepted                        | [Authorization servers](../issuance/authorization-servers.md) |
| PKCE                                       | ✅     | `S256` only, for every authorization code                                                                                                   | [Authorization servers](../issuance/authorization-servers.md) |
| Refresh tokens                             | ✅     | On by default for hosted authorization servers, 30-day lifetime                                                                             | [Authorization servers](../issuance/authorization-servers.md) |
| DPoP                                       | ✅     | Proofs verified per RFC 9449 (signature, `htm`/`htu`, freshness, single-use `jti`, `ath`, key binding)                                      | [Authorization servers](../issuance/authorization-servers.md) |
| Chained authorization server               | ✅     | EUDIPLO issues the tokens and delegates user login to an upstream OpenID Connect provider                                                   | [Authorization servers](../issuance/authorization-servers.md) |
| OID4VP-based authorization server          | ✅     | The wallet authorizes issuance by presenting a credential                                                                                   | [Authorization servers](../issuance/authorization-servers.md) |
| Interactive authorization endpoint         | ⚠️     | Experimental; behavior may change                                                                                                           | [Interactive authorization](../issuance/interactive-authorization.md) |
| Nonce endpoint                             | ✅     | `POST /issuers/{tenant}/vci/nonce`; nonces are single use                                                                                   | [Issuance under the hood](../concepts/issuance.md)            |
| Batch issuance                             | ✅     | Enabled when `batchSize` is greater than 1; one credential per holder key                                                                   | [Issuance configuration](../issuance/issuance-configuration.md) |
| Deferred issuance                          | ✅     | Your backend completes or fails the transaction later                                                                                       | [Deferred issuance](../issuance/deferred-issuance.md)         |
| Notification endpoint                      | ✅     | Can be disabled per tenant                                                                                                                  | [Notifications](../issuance/notifications.md)                 |
| Credential request and response encryption | ✅     | Offered in the issuer metadata; can be made mandatory per tenant                                                                            | [Issuance configuration](../issuance/issuance-configuration.md) |
| Signed issuer metadata                     | ✅     | Returned for `Accept: application/jwt`, signed with the tenant's access certificate                                                         | [Issuance configuration](../issuance/issuance-configuration.md) |
| Wallet attestation                         | ✅     | `OAuth-Client-Attestation` headers at PAR and token endpoints of hosted authorization servers                                               | [Wallet and key attestation](../trust/attestation.md)         |
| Key attestation                            | ✅     | `attestation` proof type, or a `key_attestation` header in `jwt` proofs                                                                     | [Wallet and key attestation](../trust/attestation.md)         |

## OID4VP (presentation)

| Feature                                   | Status | Notes                                                                                                                             | Guide                                                         |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Signed request object by reference        | ✅     | `request_uri` with `GET` or `POST`                                                                                                | [Presentation requests](../presentation/requests.md)          |
| `direct_post.jwt` response mode           | ✅     | Responses are always encrypted; plain `direct_post` is not accepted                                                              | [Presentation requests](../presentation/requests.md)          |
| DCQL                                      | ✅     | Including `credential_sets`, `claim_sets`, `values`, `multiple` and `trusted_authorities`                                         | [DCQL](../presentation/dcql.md)                               |
| Session separation and response code (§13.3) | ✅  | Wallet-facing identifier separate from the session ID; one-time `response_code` on same-device redirects                         | [Sessions](../concepts/sessions.md)                           |
| Client identifier prefixes                | ✅     | `x509_hash` (default) and `x509_san_dns`; other prefixes are not supported                                                        | [Presentation requests](../presentation/requests.md)          |
| Transaction data                          | ✅     | Hashes checked in the SD-JWT VC key binding JWT; TS12 types (`urn:eudi:sca:*`) are validated                                       | [Transaction data](../presentation/transaction-data.md)       |
| Registration certificate in the request   | ✅     | Sent as `verifier_info`                                                                                                           | [Registration certificates](../trust/registration-certificates.md) |
| Digital Credentials API                   | ✅     | `dc_api.jwt` response mode with `expected_origins`                                                                                | [Presentation requests](../presentation/requests.md)          |
| ISO 18013-7 Annex C                       | ✅     | `org-iso-mdoc` over the Digital Credentials API; ignores `redirectUri`, `transaction_data` and `clientIdScheme`                     | [Presentation requests](../presentation/requests.md)          |
| Status check of presented credentials     | ✅     | `statusCheckMode`: `strict` (default), `best_effort` or `disabled`                                                                | [Configure verification](../presentation/configure-verification.md) |

## Credential formats

| Format                         | Issue | Verify | Notes                                                                                                   | Guide                                                             |
| ------------------------------ | ----- | ------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| SD-JWT VC (`dc+sd-jwt`)        | ✅    | ✅     | Issuer trust signaled with an `x5c` header (default) or OpenID Federation (`sdJwtTrustFormat`)          | [Credential configuration](../issuance/credential-configuration.md) |
| mdoc (`mso_mdoc`)              | ✅    | ✅     | Over OID4VCI, OID4VP and ISO 18013-7 Annex C                                                            | [Credential configuration](../issuance/credential-configuration.md) |
| mdoc proximity (BLE, NFC)      | ❌    | ❌     | No device engagement or offline presentation flows                                                      |                                                                   |
| W3C VCDM formats               | ❌    | ❌     | `jwt_vc_json`, `ldp_vc` and similar are not supported                                                   |                                                                   |

## Status

| Feature                     | Status | Notes                                                                                      | Guide                                       |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Token Status List (publish) | ✅     | Served as JWT or CWT depending on the `Accept` header; status values 1 = revoked, 2 = suspended | [Revocation](../issuance/revocation.md)     |
| Status list aggregation     | ✅     | Enabled by default (`STATUS_ENABLE_AGGREGATION`)                                           | [Revocation](../issuance/revocation.md)     |
| Token Status List (verify)  | ✅     | Checked for presented credentials according to `statusCheckMode`                          | [Configure verification](../presentation/configure-verification.md) |
| CRL or OCSP for presented certificates | ❌ | Credential revocation relies on status lists                                           |                                             |

## Trust

| Feature                                  | Status | Notes                                                                                                                       | Guide                                                              |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| LoTE trust lists                         | ✅     | Host signed lists per tenant and consume external ones; ETSI TS 119 612 XML lists are not loaded                             | [Trust lists](../trust/trust-lists.md)                             |
| OpenID Federation                        | ⚠️     | Entity configurations are fetched and `authority_hints` followed, but statements are not yet verified cryptographically      | [OpenID Federation](../trust/federation.md)                        |
| Access certificates                      | ✅     | X.509 certificate of the access key chain signs requests and signed metadata and determines the `client_id`                  | [Keys and certificates](../trust/keys-and-certificates.md)         |
| Registration certificates                | ✅     | For verifiers (`verifier_info`) and issuers (`issuer_info`), issued by a registrar                                          | [Registration certificates](../trust/registration-certificates.md) |
| Credential reuse policy                  | ✅     | `credentialReusePolicy` published in the credential metadata                                                                | [Credential configuration](../issuance/credential-configuration.md) |
| Embedded disclosure policy               | ✅     | `embeddedDisclosurePolicy`: `none`, `allowList`, `rootOfTrust` or `attestationBased`                                         | [Credential configuration](../issuance/credential-configuration.md) |

## Conformance

EUDIPLO is tested against the [OpenID Foundation conformance suite](https://openid.net/certification/about-conformance-suite/) for OID4VCI and OID4VP. To run the suite yourself, see [Testing](../contributing/testing.md). Results with individual wallets are recorded in [Wallet compatibility](wallet-compatibility.md).
