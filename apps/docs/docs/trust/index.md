---
title: Trust Management
---

# Trust Management

Trust is the foundation of verifiable credential systems. EUDIPLO provides comprehensive trust management through key chains, certificates, registrar integration, and trust lists.

## Key Concepts

EUDIPLO's trust infrastructure ensures that:

- **Credentials are signed** by authorized entities with proper key management
- **Wallets are authenticated** using registration certificates
- **Issuers are trusted** through verifiable trust lists
- **Keys are protected** with pluggable KMS backends

## Trust Components

- **[Key Chains](keys-and-certificates.md)** — Unified key and certificate management abstraction
- **[Certificates](keys-and-certificates.md#certificates)** — Self-signed, CA-issued, and imported certificates
- **[Registrar](registrar.md)** — EUDI Wallet access and registration certificates
- **[Registration Certificates](registration-certificates.md)** — Authorization for credential requests
- **[Trust Lists](trust-lists.md)** — ETSI TS 119 602 compliant trusted entity registries

## Why Trust Matters

Every credential issuance and verification flow in EUDIPLO relies on cryptographic trust:

1. **Issuers** sign credentials with keys from key chains
2. **Verifiers** validate credentials against trusted issuer certificates in trust lists
3. **Wallets** present registration certificates to prove authorization
4. **Status lists** are signed by trusted revocation certificates

Without proper trust configuration, credentials may be rejected by wallets or verifiers.

For deep technical details on KMS backends (Vault, AWS KMS, PKCS#11, HTTP, CSC), see [KMS Configuration](../operate/kms.md).
