---
title: Protocol Mapping
---

# Protocol Mapping

This page provides a reference table mapping EUDIPLO's internal concepts to their corresponding protocol elements in OID4VCI, OID4VP, and related standards. Use this as a quick lookup when translating between EUDIPLO configuration and protocol-level interactions.

---

## Core Entity Mapping

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

## Issuance Flow Mapping

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

## Presentation Flow Mapping

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

## Credential Format Mapping

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

## Trust and Security Mapping

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

## Authorization Server Mapping

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

## Metadata Discovery Mapping

| EUDIPLO Concept           | Protocol Concept        | Discovery Endpoint                                                    | Notes                                                                                      |
| ------------------------- | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Issuer Metadata**       | OID4VCI issuer metadata | `/.well-known/openid-credential-issuer/issuers/{tenant}`              | Published credential configurations and endpoints                                          |
| **AS Metadata (OID4VCI)** | OAuth AS metadata       | `/.well-known/oauth-authorization-server/issuers/{tenant}`            | Published AS endpoints and capabilities                                                    |
| **AS Metadata (Chained)** | OAuth AS metadata       | `/.well-known/oauth-authorization-server/issuers/{tenant}/chained-as` | Chained AS metadata                                                                        |
| **Verifier Metadata**     | OID4VP client metadata  | `client_metadata` in authorization request                            | Verifier capabilities (supported formats, algorithms)                                      |
| **JWKS (AS)**             | JSON Web Key Set        | `/.well-known/jwks.json/issuers/{tenant}`                             | Public key of the tenant's issuance signing key; verifies access tokens of the built-in AS |
| **JWKS (Chained AS)**     | JSON Web Key Set        | `/.well-known/jwks.json/issuers/{tenant}/chained-as`                  | Public keys for verifying Chained AS access tokens                                         |

---

## Session and State Mapping

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

## API Mapping

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

## Next Steps

- **Core Concepts**: [Entities and Relationships](./core-concepts.md)
- **Issuance Flow**: [Issuance Architecture](./issuance.md)
- **Presentation Flow**: [Presentation Architecture](./presentation.md)
- **Supported Protocols**: [Protocol Coverage](../reference/protocols.md)
- **Configuration Model**: [Configuration Import and Portability](./configuration-model.md)
