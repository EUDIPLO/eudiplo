---
title: Supported Protocols
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - appended 'Credential Formats' (removed reference/credential-formats.md): fold into one standards support matrix
  - appended 'Protocol Mapping' (removed architecture/protocol-mapping.md): delete or reduce to a short glossary
  - add the coverage tables from concepts/issuance.md and concepts/presentation.md ('Protocol Coverage')
-->

# Supported Protocols

EUDIPLO is **deliberately limited** to protocols that are part of the European Digital Identity Wallet (EUDI Wallet) ecosystem. This focused scope reduces implementation complexity, improves long-term maintainability, and ensures a consistent trust model across services.

Rather than being a general-purpose verifiable credentials broker, EUDIPLO aligns strictly with the specifications endorsed by the EU regulatory and technical framework.

## Protocol Overview

| Protocol                                                                                                                          | Description                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [OpenID for Verifiable Credential Issuance (OID4VCI)](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html) | Enables issuers to deliver verifiable credentials to EUDI Wallets using OAuth-based flows |
| [OpenID for Verifiable Presentations (OID4VP)](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)              | Allows services to request and verify credentials presented by EUDI Wallet holders        |
| [Selective Disclosure JWT VC (SD-JWT VC)](https://www.ietf.org/archive/id/draft-ietf-oauth-selective-disclosure-jwt-08.html)     | Data model for credentials allowing selective disclosure of individual claims by the user |
| [Mobile Driving License (mDOC/mDL)](https://www.iso.org/standard/69084.html)                                                      | ISO 18013-5 standard for mobile driving licenses and other mobile documents               |
| [OAuth Token Status List](https://drafts.oauth.net/draft-ietf-oauth-status-list/draft-ietf-oauth-status-list.html)               | Mechanism for determining revocation or suspension status of issued credentials           |

## OID4VCI Features

EUDIPLO implements the following OID4VCI (OpenID for Verifiable Credential Issuance) features:

| Feature                                  | Status | Description                                                      |
| ---------------------------------------- | ------ | ---------------------------------------------------------------- |
| Pre-Authorized Code Flow                 | ✅     | Issue credentials without user authentication at the issuer      |
| Authorization Code Flow                  | ✅     | Issue credentials with user authentication                       |
| Batch Credential Issuance                | ✅     | Issue multiple credentials in a single request                   |
| **Deferred Credential Endpoint**         | ✅     | Support for credentials that cannot be issued immediately        |
| Notification Endpoint                    | ✅     | Receive wallet acknowledgment of credential acceptance/rejection |
| DPoP (Demonstrating Proof-of-Possession) | ✅     | Enhanced security with proof-of-possession tokens                |
| Wallet Attestation                       | ✅     | Verify wallet provider trustworthiness                           |

:::tip[Deferred Issuance]
The **Deferred Credential Endpoint** allows issuers to handle scenarios where credentials cannot be issued immediately (e.g., pending manual approval, external data sources). Wallets can poll the endpoint to retrieve credentials once they become available.
:::

## OID4VP Features

EUDIPLO implements the following OID4VP (OpenID for Verifiable Presentations) features:

| Feature                                          | Status | Description                                                                               |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `direct_post.jwt` Response Mode                  | ✅     | Wallet posts the VP Token directly to the verifier, encrypted as a JWE                    |
| DCQL (Digital Credentials Query Language)        | ✅     | Structured credential queries with selective disclosure                                   |
| Session Identifier Separation (§13.3)            | ✅     | Wallet-facing identifier (`walletNonce`) is distinct from the internal session ID         |
| Response Code for Same-Device Redirect (§13.3)   | ✅     | One-time `response_code` appended to `redirect_uri` prevents session fixation on redirect |
| JWE-Encrypted Authorization Responses            | ✅     | VP Tokens are encrypted to the verifier's key                                             |
| `x509_san_dns` / `x509_san_uri` Client ID Scheme | ✅     | Verifier identification via X.509 certificates                                            |
| Wallet Attestation Verification                  | ✅     | Validate wallet provider trustworthiness before accepting presentations                   |
| Digital Credentials API (DC API)                 | ✅     | Browser-native credential exchange without QR codes or redirects                          |

:::tip[Security Features]
EUDIPLO implements advanced security features from the OID4VP specification including session identifier separation (§13.3), response code verification for same-device flows, and JWE-encrypted responses to prevent token leakage.
:::

## Why This Limited Scope?

By **limiting scope to official EUDI Wallet protocols**, EUDIPLO avoids:

- ❌ Incompatibilities with reference implementations
- ❌ Bloated code from supporting rarely used formats
- ❌ Uncertain trust assumptions from broader ecosystems

This makes EUDIPLO especially suitable for:

- ✅ Public sector services integrating with national wallet pilots
- ✅ Companies targeting pan-European credential workflows
- ✅ Developers seeking a reliable, minimal abstraction layer over complex specs

:::note[Evolving Standards]
These standards are evolving in coordination with EU-level pilot projects and working groups. EUDIPLO tracks these developments closely to provide early, stable support as specifications mature.
:::

## OIDF Conformance

EUDIPLO has been tested against the **OpenID Foundation (OIDF) Conformance Suite** to ensure strict compliance with protocol specifications:

- ✅ **OID4VCI (OpenID for Verifiable Credential Issuance)** — Conformance tested
- ✅ **OID4VP (OpenID for Verifiable Presentations)** — Conformance tested

These conformance tests validate that EUDIPLO correctly implements the protocol flows, security requirements, and interoperability features specified by the OpenID Foundation.

### Running Conformance Tests

To run the OIDF conformance tests yourself:

1. Deploy EUDIPLO to a publicly accessible instance (required for the hosted OIDF test suite)
2. Run the conformance test suite:

```bash
cd apps/backend
pnpm run test:oidf
```

These tests execute against your running instance and communicate with the hosted OIDF conformance suite to validate protocol compliance.

For more details on testing, see the [Conformance Testing guide](../contributing/testing.md#oidf-conformance-testing).

## Related Topics

- [Credential Configuration](../issuance/credential-configuration.md) — Configure credentials for issuance
- [Presentation Configuration](../presentation/configure-verification.md) — Configure credential requests
- [Status Management](../issuance/revocation.md) — Revocation and suspension
- [Trust Lists](../trust/trust-lists.md) — Trust architecture and key management

## Credential Formats

EUDIPLO supports the credential formats specified in the European Digital Identity Wallet (EUDI Wallet) ecosystem. This page documents the supported formats and their specific features.

### Supported Formats

EUDIPLO supports two primary credential formats:

| Format                 | Description                                                                     | Specification                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **SD-JWT VC**          | Selective Disclosure JWT Verifiable Credential                                  | [IETF OAuth SD-JWT](https://www.ietf.org/archive/id/draft-ietf-oauth-selective-disclosure-jwt-08.html)                               |
| **mDOC / mDL**         | ISO mobile driving license and mobile documents                                 | [ISO 18013-5](https://www.iso.org/standard/69084.html)                                                                               |

Both formats support selective disclosure, allowing users to reveal only the specific claims requested by a verifier rather than the entire credential.

### SD-JWT VC (Selective Disclosure JWT Verifiable Credential)

#### Overview

SD-JWT VC combines JSON Web Tokens (JWT) with selective disclosure capabilities, enabling fine-grained control over which claims are revealed during presentation.

#### Key Features

- **Selective Disclosure**: Users can reveal only specific claims from the credential
- **JSON-based**: Familiar JSON structure for claims and metadata
- **JWT Security**: Standard JWT signing and verification mechanisms
- **Compact**: Efficient encoding for mobile and web use cases

#### Trust Signaling

SD-JWT credentials support two trust signaling modes:

| Mode          | Description                                                     | Use Case                                    |
| ------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `x5c`         | Embeds X.509 certificate chain in JWT header                   | Traditional PKI-based trust (default)       |
| `federation`  | Uses OpenID Federation for trust resolution via issuer (`iss`) | Federation-based trust evaluation           |

Configure the trust format per credential in the issuance configuration:

```json
{
  "credentialConfigId": "pid",
  "sdJwtTrustFormat": "federation"
}
```

See [OpenID Federation](../trust/federation.md) for federation configuration details.

#### Verification

EUDIPLO verifies SD-JWT VCs by:

1. Validating the JWT signature against trusted issuer keys
2. Checking certificate chains (when using `x5c` mode)
3. Evaluating federation trust (when using `federation` mode and `openid_federation` is specified in DCQL `trusted_authorities`)
4. Verifying selective disclosure proofs for requested claims
5. Checking revocation status via OAuth Status Lists

### mDOC / mDL (Mobile Documents / Mobile Driving License)

#### Overview

mDOC is the ISO 18013-5 standard for mobile documents, originally designed for mobile driving licenses (mDL) but extensible to other document types.

#### Key Features

- **Selective Disclosure**: Attribute-level selective disclosure using CBOR
- **Offline Verification**: Supports offline presentation with device binding
- **ISO Standard**: Internationally recognized standard for mobile documents
- **CBOR Encoding**: Compact binary encoding optimized for mobile devices

#### Trust Mechanisms

mDOC credentials use X.509 certificate chains embedded in the credential for trust validation. EUDIPLO verifies:

1. Certificate chain validity and trust anchor
2. Document signer certificate (DS certificate)
3. Mobile Security Object (MSO) signature
4. Issuer-signed attributes and selective disclosure

#### Verification

EUDIPLO verifies mDOC credentials by:

1. Validating the certificate chain against configured trust anchors
2. Verifying the MSO signature
3. Checking selective disclosure proofs for requested attributes
4. Validating device authentication (for device-bound credentials)
5. Checking revocation status via OAuth Status Lists (CWT format)

See [mDOC verification details](../presentation/configure-verification.md) for detailed verification flows.

### Status Management

Both credential formats support revocation and suspension through the **OAuth Token Status List** mechanism:

- **Status List Format**: JWT (for SD-JWT VC) or CWT (for mDOC)
- **Status Types**: Revocation and suspension
- **Efficient Encoding**: Bit-packed status lists for scalability
- **Privacy-Preserving**: No correlation between status checks

See [Status Management](../issuance/revocation.md) for configuration details.

### Format Selection

Choose the credential format based on your use case:

#### Use SD-JWT VC when

- You need JSON-based claim structures
- Your system already uses JWT/JWS infrastructure
- You want federation-based trust evaluation
- Web-based verification is primary

#### Use mDOC when

- You're implementing mobile driving licenses or similar documents
- Offline verification is required
- Compact binary encoding is preferred
- ISO standardization is important

---

### References

- [Supported Protocols](./protocols.md) — Full protocol support matrix
- [Issuance Configuration](../issuance/issuance-configuration.md) — Configure credential issuance
- [Presentation Configuration](../presentation/configure-verification.md) — Configure credential verification

## Protocol Mapping

This page provides a reference table mapping EUDIPLO's internal concepts to their corresponding protocol elements in OID4VCI, OID4VP, and related standards. Use this as a quick lookup when translating between EUDIPLO configuration and protocol-level interactions.

---

### Core Entity Mapping

| EUDIPLO Concept                | Protocol Concept                                         | Protocol         | Notes                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**                     | (no direct equivalent)                                   | —                | Tenant isolation is an EUDIPLO abstraction for multi-tenancy; not visible in protocols                                                            |
| **Credential Configuration**   | `credential_configurations_supported`                    | OID4VCI          | Published in OID4VCI issuer metadata (`/.well-known/openid-credential-issuer/issuers/{tenant}`)                                                   |
| **Credential Offer**           | `CredentialOffer` object                                 | OID4VCI          | Contains `credential_issuer`, `credential_configuration_ids`, and `grants`                                                                        |
| **Issuance Configuration**     | Authorization server metadata                            | OID4VCI          | Published in AS metadata (`/.well-known/oauth-authorization-server/issuers/{tenant}`)                                                             |
| **Presentation Configuration** | Authorization Request (DCQL)                             | OID4VP           | Provides the `dcql_query` (including `trusted_authorities`) and optional `transaction_data`; `nonce` and `response_uri` are generated per session |
| **Session**                    | `issuer_state` (issuance) / `walletNonce` (presentation) | OID4VCI / OID4VP | Used for session correlation; for OID4VP the wallet-facing `walletNonce` replaces the session ID                                                  |
| **Key Chain**                  | Signing/verification key material                        | All              | JWK or X.509 certificate used for signing/verifying JWTs, CWTs, status lists, etc.                                                                |
| **Trust List**                 | `trusted_authorities` (ETSI TL / OpenID Federation)      | OID4VP           | Specifies which issuers are trusted when verifying credentials                                                                                    |
| **Status List**                | OAuth Token Status List                                  | OID4VCI / OID4VP | Revocation/suspension status encoded as JWT or CWT                                                                                                |
| **Attribute Provider**         | (no direct equivalent)                                   | —                | EUDIPLO abstraction for external claim sources; not part of OID4VCI spec                                                                          |
| **Webhook Endpoint**           | (no direct equivalent)                                   | —                | EUDIPLO abstraction for notification delivery; not part of core protocols                                                                         |

---

### Issuance Flow Mapping

| EUDIPLO Concept               | Protocol Concept                  | Protocol Element                                                    | Notes                                                                                                   |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Credential Offer Creation** | Credential offer generation       | `POST /api/issuer/offer` (EUDIPLO API)                              | Returns `credential_offer_uri` or `credential_offer` JSON                                               |
| **Authorization Request**     | OAuth 2.0 authorization request   | `GET /issuers/{tenant}/authorize`                                   | Redirects wallet to AS for user authentication                                                          |
| **Authorization Code**        | OAuth 2.0 authorization code      | `code` parameter in callback                                        | Exchanged for access token at `/issuers/{tenant}/authorize/token`                                       |
| **Access Token**              | OAuth 2.0 access token (JWT)      | `access_token`                                                      | Built-in AS: session ID in `sub`, `cnf.jkt` (DPoP), `client_id`; Chained AS tokens carry `issuer_state` |
| **DPoP Proof**                | Demonstrating Proof-of-Possession | `DPoP` header                                                       | JWT signed by wallet's key proving possession                                                           |
| **Wallet Attestation**        | OAuth Client Attestation          | `OAuth-Client-Attestation` / `OAuth-Client-Attestation-PoP` headers | Proves wallet provider trustworthiness                                                                  |
| **Credential Request**        | Credential request                | `POST /issuers/{tenant}/vci/credential`                             | Wallet requests credential using access token and proof                                                 |
| **Credential Response**       | Credential response               | JSON response with `credential` field                               | Contains SD-JWT VC or mDOC credential                                                                   |
| **Batch Issuance**            | Batch credential request          | `credential_requests` array                                         | Multiple credentials in one request                                                                     |
| **Deferred Credential**       | Deferred credential issuance      | `transaction_id`                                                    | Wallet polls `POST /issuers/{tenant}/vci/deferred_credential` for credential availability               |
| **Notification**              | Notification endpoint             | `POST /issuers/{tenant}/vci/notification`                           | Wallet notifies EUDIPLO of credential acceptance/rejection                                              |

---

### Presentation Flow Mapping

| EUDIPLO Concept                   | Protocol Concept                   | Protocol Element                                            | Notes                                                                                                                   |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Presentation Request Creation** | Authorization request generation   | `POST /api/verifier/offer` (EUDIPLO API)                    | Returns `openid4vp://` URIs with a `request_uri` for the wallet to dereference                                          |
| **Presentation Request**          | OID4VP authorization request       | `GET /presentations/{walletNonce}/oid4vp/request`           | Signed request object with DCQL query, trusted authorities, and security parameters                                     |
| **DCQL Query**                    | Digital Credentials Query Language | `dcql_query` in the authorization request                   | Specifies required credentials, formats, claims, and value constraints                                                  |
| **Trusted Authorities**           | Trust anchors                      | `trusted_authorities` array in a DCQL credential query      | ETSI TL or OpenID Federation trust roots; `etsi_tl` entries are sent to wallets as `type: "aki"`                        |
| **Wallet Response**               | VP Token submission                | `POST /presentations/{walletNonce}/oid4vp`                  | Wallet posts encrypted VP Token (`direct_post.jwt`, or `dc_api.jwt` with the DC API)                                    |
| **VP Token**                      | Verifiable Presentation Token      | `vp_token` object keyed by DCQL credential `id`             | Contains presented credentials with key binding                                                                         |
| **JWE Encryption**                | JWE-encrypted response             | `response` parameter (JWE)                                  | Always required; encrypted to an ephemeral per-request key (`ECDH-ES`, `A128GCM`/`A256GCM`) from `client_metadata.jwks` |
| **Response Code**                 | Same-device redirect code (§13.3)  | `response_code` query parameter                             | One-time code to prevent session fixation                                                                               |
| **Wallet Nonce**                  | Session identifier (§13.3)         | Path segment of `request_uri` / `response_uri`, and `state` | Wallet-facing identifier distinct from internal session ID; the request `nonce` is a separate random value              |
| **Verification Result**           | (no direct equivalent)             | Webhook payload                                             | EUDIPLO sends result to configured webhook endpoint                                                                     |

---

### Credential Format Mapping

| EUDIPLO Concept          | Protocol Concept                               | Format Identifier                                      | Notes                                                      |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| **SD-JWT VC**            | Selective Disclosure JWT Verifiable Credential | `dc+sd-jwt`                                            | JWT with selective disclosure and key binding              |
| **mDOC**                 | Mobile Document (ISO 18013-5)                  | `mso_mdoc`                                             | CBOR-encoded document; the MSO is signed with `COSE_Sign1` |
| **VCT (SD-JWT VC)**      | Verifiable Credential Type                     | `vct` claim in JWT                                     | Type identifier (e.g., `urn:eu:diploma`)                   |
| **DocType (mDOC)**       | Document Type                                  | `docType` field in CBOR (`meta.doctype_value` in DCQL) | Type identifier (e.g., `org.iso.18013.5.1.mDL`)            |
| **Credential Fields**    | Claim definitions                              | `claims` array in credential configuration             | Path, type, display, selective disclosure policy           |
| **Selective Disclosure** | SD-JWT disclosures                             | `_sd` claim and disclosure tilde-separated suffix      | Hidden claims revealed via disclosures                     |
| **Key Binding**          | Key binding JWT (SD-JWT VC)                    | Final segment after tildes                             | Proves wallet's possession of credential                   |

---

### Trust and Security Mapping

| EUDIPLO Concept                    | Protocol Concept                   | Protocol Element                                                                         | Notes                                                                                                                |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Trust List (ETSI TL)**           | ETSI Trusted List                  | `type: "etsi_tl"` in `trusted_authorities`                                               | JWT-encoded trust list of trusted issuers; values are `{ trustListId }` or `{ url, verifierKey \| verifierX509Der }` |
| **Trust List (OpenID Federation)** | OpenID Federation Entity Statement | `type: "openid_federation"` in `trusted_authorities`                                     | Federation metadata and trust chains                                                                                 |
| **Trust List Verifier Key**        | Trust list signing key             | JWK in `verifierKey` or DER certificate in `verifierX509Der` of the trust list reference | Used to verify an external trust list JWT signature; the `trustList` key chain signs EUDIPLO's own trust lists       |
| **Status List**                    | OAuth Token Status List            | `status` claim in credential                                                             | References status list JWT and bit index                                                                             |
| **Status List Index**              | Bit index in status list           | `status_list.idx`                                                                        | Position in status list bit array                                                                                    |
| **Status List URI**                | Status list JWT URL                | `status_list.uri`                                                                        | Where to fetch the status list JWT                                                                                   |
| **Revocation Status**              | Status bit value                   | `0x01`                                                                                   | Credential is revoked (permanently)                                                                                  |
| **Suspension Status**              | Status bit value                   | `0x02`                                                                                   | Credential is suspended (temporarily)                                                                                |
| **Certificate Chain**              | X.509 certificate chain            | `x5c` header in JWT or COSE                                                              | Leaf certificate first, then intermediates/root                                                                      |
| **DPoP Key Thumbprint**            | DPoP confirmation claim            | `cnf.jkt` in access token                                                                | SHA-256 thumbprint of DPoP public key                                                                                |

---

### Authorization Server Mapping

| EUDIPLO Concept            | Protocol Concept                                | Protocol Element                                                          | Notes                                                               |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Built-in AS**            | Embedded OAuth AS                               | EUDIPLO-hosted AS endpoints                                               | Minimal AS for development/testing                                  |
| **External AS**            | External OAuth AS                               | Any OAuth AS whose access tokens carry a session binding claim            | EUDIPLO correlates tokens via the configured `sessionBinding.claim` |
| **Chained AS**             | OAuth AS facade                                 | EUDIPLO-hosted AS that delegates to upstream OIDC                         | No upstream AS modifications required                               |
| **OID4VP AS**              | OAuth AS with presentation-based authentication | EUDIPLO-hosted AS that authenticates the user with an OID4VP presentation | Tokens carry `issuer_state`                                         |
| **OID4VP-Based AS**        | Credential-to-credential authorization          | OID4VP presentation as authentication                                     | Prove existing credentials before issuance                          |
| **PAR Endpoint**           | Pushed Authorization Request                    | `POST /issuers/{tenant}/authorize/par`                                    | Wallet pushes authorization parameters before redirect              |
| **Token Endpoint**         | OAuth token endpoint                            | `POST /issuers/{tenant}/authorize/token`                                  | Exchanges authorization code for access token                       |
| **Authorization Endpoint** | OAuth authorization endpoint                    | `GET /issuers/{tenant}/authorize`                                         | User authentication and consent                                     |

---

### Metadata Discovery Mapping

| EUDIPLO Concept           | Protocol Concept        | Discovery Endpoint                                                    | Notes                                                                                      |
| ------------------------- | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Issuer Metadata**       | OID4VCI issuer metadata | `/.well-known/openid-credential-issuer/issuers/{tenant}`              | Published credential configurations and endpoints                                          |
| **AS Metadata (OID4VCI)** | OAuth AS metadata       | `/.well-known/oauth-authorization-server/issuers/{tenant}`            | Published AS endpoints and capabilities                                                    |
| **AS Metadata (Chained)** | OAuth AS metadata       | `/.well-known/oauth-authorization-server/issuers/{tenant}/chained-as` | Chained AS metadata                                                                        |
| **Verifier Metadata**     | OID4VP client metadata  | `client_metadata` in authorization request                            | Verifier capabilities (supported formats, algorithms)                                      |
| **JWKS (AS)**             | JSON Web Key Set        | `/.well-known/jwks.json/issuers/{tenant}`                             | Public key of the tenant's issuance signing key; verifies access tokens of the built-in AS |
| **JWKS (Chained AS)**     | JSON Web Key Set        | `/.well-known/jwks.json/issuers/{tenant}/chained-as`                  | Public keys for verifying Chained AS access tokens                                         |

---

### Session and State Mapping

| EUDIPLO Concept            | Protocol Concept                   | Protocol Element                                              | Notes                                                                                                                                                                              |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session ID**             | Session correlation                | UUID                                                          | Issuance: used as `issuer_state` and in the `credential_offer_uri` path; OID4VP: never exposed to the wallet (the `walletNonce` is used instead)                                   |
| **Issuer State**           | Session correlation (issuance)     | `issuer_state` in credential offer (authorization code grant) | Correlates credential offer with session; built-in AS tokens carry the session ID in `sub`, Chained AS tokens in `issuer_state`                                                    |
| **Wallet Nonce (OID4VP)**  | Session correlation (presentation) | Path segment of `request_uri` / `response_uri`, and `state`   | Wallet-facing session identifier (§13.3)                                                                                                                                           |
| **Response Code (OID4VP)** | Same-device redirect code          | `response_code` in redirect URI                               | One-time code for same-device flows (§13.3)                                                                                                                                        |
| **Session Status**         | (internal state)                   | `active`, `fetched`, `completed`, `expired`, `failed`         | Tracks session lifecycle                                                                                                                                                           |
| **Session Consumed**       | Replay prevention flag             | `consumed: true`                                              | Prevents double-spending of sessions                                                                                                                                               |
| **Session TTL**            | Expiration policy                  | `expiresAt` timestamp                                         | Presentation requests expire after the configuration's `lifeTime` (default 300 s); stored sessions are cleaned up after the global `SESSION_TTL`, optionally overridden per tenant |

---

### API Mapping

Management endpoints use the global `/api` prefix; wallet-facing protocol endpoints (`/issuers/{tenant}/...`, `/presentations/...`, `/.well-known/...`) are served without it.

| EUDIPLO Concept                 | Protocol Concept                  | EUDIPLO Endpoint                                   | Notes                                                                        |
| ------------------------------- | --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Create Credential Offer**     | Generate credential offer         | `POST /api/issuer/offer`                           | Returns `credential_offer_uri`                                               |
| **Create Presentation Request** | Generate authorization request    | `POST /api/verifier/offer`                         | Returns `openid4vp://` URIs with a `request_uri`                             |
| **Fetch Credential Offer**      | Dereference credential offer      | `GET /issuers/{tenant}/vci/credential-offers/{id}` | Returns `CredentialOffer` JSON                                               |
| **Fetch Presentation Request**  | Dereference authorization request | `GET /presentations/{walletNonce}/oid4vp/request`  | Returns the signed authorization request (`application/oauth-authz-req+jwt`) |
| **Token Endpoint**              | OAuth token exchange              | `POST /issuers/{tenant}/authorize/token`           | Exchanges code for access token                                              |
| **Credential Endpoint**         | Credential issuance               | `POST /issuers/{tenant}/vci/credential`            | Issues credential                                                            |
| **Deferred Endpoint**           | Deferred credential retrieval     | `POST /issuers/{tenant}/vci/deferred_credential`   | Retrieves deferred credential                                                |
| **Notification Endpoint**       | Wallet notification               | `POST /issuers/{tenant}/vci/notification`          | Receives credential acceptance/rejection                                     |
| **Direct Post Endpoint**        | VP Token submission               | `POST /presentations/{walletNonce}/oid4vp`         | Receives encrypted VP Token                                                  |

---

### Next Steps

- **Core Concepts**: [Entities and Relationships](../concepts/index.md#core-concepts)
- **Issuance Flow**: [Issuance Architecture](../concepts/issuance.md)
- **Presentation Flow**: [Presentation Architecture](../concepts/presentation.md)
- **Supported Protocols**: [Protocol Coverage](protocols.md)
- **Configuration Model**: [Configuration Import and Portability](../operate/configuration-as-code.md#configuration-model)
