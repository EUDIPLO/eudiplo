---
title: Trust
---

Wallets and verifiers only accept EUDIPLO if they trust its certificates, and EUDIPLO only accepts credentials and wallets it can trust. This section covers both directions. Pick the page for your task:

| I want to...                                                                                    | Read                                                              |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Create or import the keys that sign credentials, status lists, trust lists and requests        | [Keys and Certificates](keys-and-certificates.md)                 |
| Know which certificates a specific wallet needs                                                 | [Wallet and Registrar Requirements](wallet-registrars.md)         |
| Get access and registration certificates from the German registrar, publish schema metadata    | [Registrar](registrar.md)                                         |
| Tell wallets what my verifier may request or which credentials my issuer provides               | [Registration Certificates](registration-certificates.md)         |
| Accept credentials only from specific issuers, or publish a list of my own issuers             | [Trust Lists](trust-lists.md)                                     |
| Decide trust through OpenID Federation trust anchors                                            | [OpenID Federation](federation.md)                                |
| Issue only to trusted wallet apps and to keys with a certain security level                     | [Wallet and Key Attestation](attestation.md)                      |

## Who proves what to whom

| Direction                      | What is presented                                                                                                                       | Checked against                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| EUDIPLO as verifier → wallet   | Presentation requests signed with the **access certificate**, optionally with a **registration certificate** that authorizes the requested data | The wallet's trust in the access certificate's issuer and the registrar |
| EUDIPLO as issuer → wallet     | Credentials signed with an **attestation** key chain; optionally signed issuer metadata (access certificate) and a registration certificate in `issuer_info` | Trust lists or the ecosystem's trust anchors, in the wallet           |
| Wallet → EUDIPLO as verifier   | Credentials with the issuer's certificate chain, status lists signed by the issuer's revocation certificate                              | [Trust lists](trust-lists.md) or [federation](federation.md) in `trusted_authorities` |
| Wallet → EUDIPLO as issuer     | **Wallet attestation** at the authorization server, **key attestation** for holder keys                                                  | [Wallet-provider trust lists](attestation.md)                         |

Wallets never present registration certificates; issuers and verifiers present theirs to wallets.

Where keys are stored (database, Vault, AWS KMS, HSM and others) is an operator decision: see [KMS](../operate/kms.md).
