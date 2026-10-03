---
title: Credential Presentation
---

EUDIPLO provides comprehensive credential presentation capabilities using OpenID4VP (OpenID for Verifiable Presentations). This system allows verifiers to request specific credentials and claims from users, enabling secure identity verification and attribute validation.

## Overview

Credential presentation enables verifiers to:

- **Request specific credentials** from users' wallets
- **Verify authenticity** of presented credentials
- **Extract required claims** for authorization or validation
- **Maintain privacy** by requesting only necessary information
- **Support multiple presentation flows** for different use cases

EUDIPLO supports both standalone presentation flows and presentation as part of credential issuance via the [Interactive Authorization Endpoint (IAE)](../issuance/interactive-authorization.md), providing flexibility for various business requirements.

## Key Concepts

### Presentation Flows

EUDIPLO supports multiple presentation scenarios:

- **Standard Presentation Flow**
    - Direct credential verification requests
    - Used for access control and identity verification
    - Returns verified claims to the requesting service

- **Presentation via Interactive Authorization (IAE)**
    - Credentials presented as part of the issuance authorization flow
    - Enables qualification-based credential issuance
    - Supports multi-step workflows combining presentations with web-based verification
    - See [Interactive Authorization Endpoint](../issuance/interactive-authorization.md) for details

- **ISO 18013-7 Presentation (Digital Credentials API)**
    - Requests an mdoc credential through the browser using the `org-iso-mdoc` protocol (ISO/IEC TS 18013-7:2025 Annex C)
    - Covers browsers that do not implement the OpenID4VP profile of the Digital Credentials API (e.g. Safari on iOS/macOS)
    - See [Presentation Requests](requests.md#iso-18013-7-requests) for the request payload

### DCQL (Digital Credentials Query Language)

EUDIPLO uses [DCQL](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-digital-credentials-query-l) to define presentation requests:

- **Structured queries** for specific credentials and claims
- **Format specification** (e.g., `dc+sd-jwt`)
- **Selective disclosure** of only required attributes
- **VCT (Verifiable Credential Type) targeting** for precise credential matching

### Registration Certificates

All presentation requests include registration certificates that provide:

- **Legal basis** for data processing
- **Privacy policy** information
- **Contact details** for data protection inquiries
- **Purpose statements** explaining why data is requested

### Single-Use Requests (Replay Prevention)

All presentation requests are **single-use and non-replayable**. Once a wallet submits a presentation response to a request:

- The request is marked as consumed and cannot be used again
- Any subsequent attempts to submit presentations for the same request will be rejected with a `400 Bad Request` error
- The `consumedAt` timestamp records when the request was first used

**Important Considerations:**

- **Create a new request for each presentation**: If you need to verify credentials multiple times, create a fresh presentation request via the API
- **Request expiration**: Combine single-use enforcement with TTL-based session cleanup (configured per-tenant) to ensure expired requests don't accumulate
- **Security benefit**: This prevents presentation request replay attacks where an attacker could reuse an intercepted request to submit fraudulent credentials

This design is consistent with OAuth 2.0 security best practices and protects against presentation replay attacks.

## Architecture

### Tenant-Based Configuration

EUDIPLO uses a tenant-based architecture where:

- Each tenant has isolated presentation configurations
- Configurations are stored securely in the database
- API access is scoped to the authenticated tenant
- Multi-tenant deployments maintain strict data isolation

### Session Management

Presentation flows create sessions that:

- Track the presentation request lifecycle
- Store temporary data during the exchange
- Enable asynchronous processing via webhooks
- Maintain audit trails for compliance

## Quick Start

Use the verifier section in the [API Documentation](../reference/api.md) to manage presentation configurations and create presentation requests.

For request payloads, examples, and runtime override behavior, see [Presentation Requests](requests.md).

## In This Section

- [Presentation Configuration](configure-verification.md) — Define reusable presentation templates
- [Presentation Requests](requests.md) — Create presentation requests and override configuration
- [DCQL](dcql.md) — Digital Credentials Query Language for structured queries
- [Transaction Data](transaction-data.md) — Contextual data displayed to users during presentation
- [Handling Results](receive-results.md) — Retrieve verified claims and session status

## Security Considerations

### Direct Post Security Model (OID4VP §13.3)

EUDIPLO implements the `direct_post.jwt` response mode with the full security model defined in [OID4VP Section 13.3](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#section-13.3). This model separates identifiers across different actors to prevent session fixation and cross-reference attacks.

**Key security properties:**

| Identifier      | Purpose                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `session.id`    | Internal (backend / verifier) session identifier — never exposed to the wallet                           |
| `walletNonce`   | Wallet-facing identifier used as `state` in the authorization request — cannot be linked to `session.id` |
| `nonce`         | Binds the VP Token to this specific request — prevents replay attacks                                    |
| `response_code` | One-time code appended to `redirect_uri` during same-device redirect — prevents session fixation         |

**Same-device redirect flow:**

When a `redirect_uri` is configured, EUDIPLO generates a one-time `response_code` and appends it to the redirect URI after the wallet submits its response. The verifier's frontend receives this code via the redirect and uses it to retrieve the session result. This ensures the browser that initiated the flow is the same one that receives the result — an attacker who observes the `walletNonce` in the QR code cannot hijack the redirect.

:::warning[Same-device flows with redirect]
For same-device flows that use a `redirect_uri`, the `response_code` is the **only safe way** to retrieve the session result. The verifier must extract it from the redirect URL and use it to look up the completed session.
:::

### Data Minimization

- **Request only necessary claims** to protect user privacy
- **Use selective disclosure** to limit exposed information
- **Implement purpose limitation** through clear registration certificates

### Authentication

- **OAuth 2.0 bearer tokens** for API authentication
- **Tenant isolation** prevents cross-tenant data access
- **Session-based security** with automatic cleanup

### Trust Verification

- **Cryptographic validation** of presented credentials
- **Issuer verification** against trusted entities in trust lists
- **Revocation status checking** using the correct revocation certificate from the same trusted entity

For detailed information on how trust verification works, see [Trust Lists](../trust/trust-lists.md).

## Related Documentation

- [Interactive Authorization Endpoint](../issuance/interactive-authorization.md) — Presentation as part of issuance
- [Trust Lists](../trust/trust-lists.md) — Trust verification and validation
- [Sessions](../concepts/sessions.md) — Session lifecycle and cleanup
- [API Reference](../reference/api.md) — Verifier API endpoints
