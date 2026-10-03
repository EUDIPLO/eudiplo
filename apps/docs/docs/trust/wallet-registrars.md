---
title: Wallet and Registrar Requirements
sidebar_label: Wallet and registrar requirements
---

Which certificates a wallet accepts depends on the wallet and its environment: a development wallet may accept self-signed certificates, while a reference implementation or national test environment may require certificates from its registrar. EUDIPLO's registrar integration supports the German registrar only; certificates from other ecosystems are imported. Read this after [Install and Connect](../cookbooks/foundation.md) and before [Issue Your First Credential](../cookbooks/first-credential.md); for wallets not listed here, the wallet's own documentation is authoritative.

## The certificates are different

Do not confuse the HTTPS certificate of `PUBLIC_URL` with the certificates of the credential protocols:

| Certificate or key       | Used for                                                                      | Typical source                                                      |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| HTTPS/TLS certificate    | Lets the phone reach the EUDIPLO backend securely                             | Your tunnel or deployment                                           |
| Attestation key chain    | Signs the credentials EUDIPLO issues                                          | Self-signed for testing; a CA or issuer PKI for production          |
| Access certificate       | Signs presentation requests; identifies EUDIPLO to the wallet                 | Self-signed in some test setups; the wallet ecosystem's registrar   |
| Registration certificate | Tells the wallet which data the verifier may request (or the issuer provides) | Issued by a registrar                                               |

Access and attestation certificates belong to key chains ([Keys and Certificates](keys-and-certificates.md#certificates)). A registration certificate is a JWT configured per presentation configuration ([Registration Certificates](registration-certificates.md)).

:::warning[Registration certificates need a registrar configuration]
EUDIPLO attaches a verifier registration certificate only when the tenant has a [registrar configuration](registrar.md), even if you paste the JWT into `registration_cert.jwt`. Without the German registrar integration, presentation requests are sent without a registration certificate. Issuers can publish an imported certificate without a registrar (`registrationCertificate.mode: "import"`).
:::

## Choose the wallet path

The exact acceptance rules can change between wallet releases and sandbox deployments.

| Wallet or environment                     | Access certificate                                                                          | Registration certificate                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Paradym Wallet test setup                 | Self-signed can be sufficient: **Access Certificate → Self-Signed Certificate**             | Usually not needed for a minimal test                                                                     |
| EU Reference Implementation               | Import the key and certificate from the ecosystem operator: **Access Certificate → External Certificate** | Cannot be attached without the German registrar integration (see above); use a test setup that does not require one |
| German wallet or German ecosystem sandbox | **Registrar Enrollment** through the integrated registrar, or import a certificate the German registrar already issued | Configure `registration_cert` in each presentation configuration; EUDIPLO obtains it from the registrar    |
| Other wallets                             | Check the wallet ecosystem's documentation                                                  | Check whether verifier requests must carry one; EUDIPLO can only attach it with the German registrar      |

The [wallet compatibility record](../reference/wallet-compatibility.md) tracks protocol support and known wallet limitations; it does not replace the current onboarding requirements of the wallet or registrar operator.

## Minimal Paradym test path

1. Create the credential-signing attestation key chain.
2. Create the access key chain with **Access Certificate → Self-Signed Certificate**.
3. Leave the registration certificate unset.
4. Issue and verify the test credential with the [cookbook](../cookbooks/index.md).

If Paradym rejects the certificate, check the wallet version and test environment. A self-signed certificate that works with one wallet is not evidence that another wallet accepts it.

## Imported certificate path (EU Reference Implementation)

1. Obtain the access key and certificate from the reference implementation's ecosystem operator.
2. In **Keys → Create Key**, choose **Access Certificate → External Certificate** and provide the private key (EC JWK or PKCS#8 PEM) and the certificate chain, leaf first. Via the API, use `POST /api/key-chain/import` ([Keys and Certificates](keys-and-certificates.md#import-a-key-and-certificate)).
3. Select this key chain as `accessKeyChainId` in the presentation configuration if the tenant has more than one access key chain.
4. Repeat the health, issuance and presentation checks with the wallet, keeping the public HTTPS address stable.

## German registrar path

1. Obtain the German registrar URLs and account credentials from the registrar operator.
2. Configure the registrar for the tenant that owns the issuer and verifier settings ([Registrar](registrar.md)). The tenant needs the `registrar:manage` role.
3. Create the access key chain with **Access Certificate → Registrar Enrollment**, or import a key and certificate the registrar already issued.
4. Set `registration_cert` with a `purpose` in each presentation configuration that needs one; set privacy policy and support URI once as registrar defaults.
5. Repeat the health, issuance and presentation checks with the target wallet. A successful health check only proves HTTPS connectivity, not that the wallet accepts your certificates.

**Next: [Issue Your First Credential](../cookbooks/first-credential.md).**
