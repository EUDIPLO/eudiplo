---
title: Wallet and Registrar Requirements
sidebar_label: Wallet and registrar requirements
---

This chapter explains which certificates a wallet may require before it can issue or verify credentials with EUDIPLO. Certificate requirements are wallet- and environment-specific: a development wallet may accept self-signed certificates, while a reference implementation or national wallet test environment may require certificates issued by its registrar. EUDIPLO's integrated registrar API currently supports the German registrar; certificates for other ecosystems must be imported.

Read this chapter after [Install and Connect](../cookbooks/foundation.md) and before [Issue Your First Credential](../cookbooks/first-credential.md). If you are using a wallet not listed here, follow its ecosystem documentation and treat its requirements as authoritative.

## The certificates are different

Do not confuse the HTTPS certificate for `PUBLIC_URL` with the certificates used by the credential protocols:

| Certificate or key       | Used for                                                         | Typical source                                                  |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| HTTPS/TLS certificate    | Lets the phone reach the EUDIPLO backend securely                | Your tunnel or deployment                                       |
| Attestation key chain    | Signs credentials issued by EUDIPLO                              | Self-signed for testing, or a CA/issuer PKI for production      |
| Access certificate       | Identifies and authorizes EUDIPLO when interacting with a wallet | Self-signed in some wallet test setups, or the wallet registrar |
| Registration certificate | Authorizes the verifier's requested credentials and claims       | A registrar, or a registrar-issued JWT supplied directly        |

An access certificate is a key chain in EUDIPLO. A registration certificate is attached to a presentation request and is configured separately. See [Certificates](keys-and-certificates.md#certificates), [Registrar](registrar.md), and [Registration Certificates](registration-certificates.md) for the detailed configuration reference.

## Choose the wallet path

Use the row that matches the wallet and environment you are testing. The exact acceptance rules can change between wallet releases and sandbox deployments.

| Wallet or environment                     | Access certificate                                                                                                                       | Registration certificate                                                                                        | What to do                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paradym Wallet test setup                 | A self-signed certificate can be sufficient                                                                                              | Usually leave it unset for a minimal test, unless the selected Paradym environment requests one                 | Create the access key chain with **Self-Signed Certificate** in the key wizard. Confirm the current wallet test environment accepts it.                                    |
| EU Reference Implementation               | Import the access key and certificate supplied by the reference implementation's ecosystem                                               | Import and configure the registrar-issued certificate when the wallet requires authorized presentation requests | Do not use **Registrar Enrollment**. Import the key and certificate through the key wizard, then configure `registrationCert` for presentation when required.              |
| German wallet or German ecosystem sandbox | Obtain the certificate through EUDIPLO's integrated German registrar API, or import a certificate already issued by the German registrar | Obtain and configure the German registrar-issued certificate for the requested credential data                  | Either configure the German registrar and use **Registrar Enrollment**, or import the registrar-issued key and certificate. Configure `registrationCert` for presentation. |
| Other wallets                             | Check the wallet's ecosystem documentation                                                                                               | Check whether its verifier requests must contain a registration certificate                                     | Start with the wallet's documented sandbox profile, then record the working certificate choices for your deployment.                                                       |

The [wallet compatibility record](../reference/wallet-compatibility.md) tracks protocol support and known wallet-specific limitations. It does not replace the wallet or registrar operator's current onboarding requirements.

## Configure a registrar when required

1. Obtain the German registrar URL, OIDC details, and account or client credentials from the wallet ecosystem operator.
2. In the EUDIPLO Web Client, open **Registrar** and save the German registrar configuration for the tenant. The tenant needs the `registrar:manage` role.
3. Open **Keys** and choose **Access Certificate**. Either select **Registrar Enrollment** to request a certificate through the integrated German registrar connection, or select the import option when you already have the registrar-issued key and certificate.
4. For presentation, configure a registration certificate in the presentation configuration. EUDIPLO can use a supplied JWT, look up an existing registrar certificate by ID, or create one from a request body.
5. Test the complete flow with the target wallet. A successful local health check only proves that HTTPS connectivity works; it does not prove that the wallet accepts the issuer or verifier certificates.

See [Registrar](registrar.md) for the UI and configuration-file workflow. See [Registration Certificates](registration-certificates.md) for required fields, credential authorization, and JWT, ID, and body resolution strategies.

## Minimal Paradym test path

For a Paradym test environment that accepts self-signed access certificates:

1. Create the credential-signing attestation key chain.
2. Create the wallet-access key chain with **Access Certificate → Self-Signed Certificate**.
3. Leave registration certificate settings unset unless the wallet or registrar environment requires them.
4. Issue and verify the test credential using the [cookbook](../cookbooks/index.md).

If Paradym rejects the certificate, stop and check the wallet version and test environment. Do not infer that a self-signed certificate is valid for another wallet.

## Registrar-backed test path

For the EU Reference Implementation:

1. Obtain the access key and certificate from the reference implementation's ecosystem operator.
2. In **Keys**, create an **Access Certificate** key chain using the import option and provide the key and certificate material.
3. Import or configure the registration certificate if the reference wallet requires one for presentation.
4. Repeat the health, issuance, and presentation checks with the wallet. Keep the public HTTPS address stable throughout the test.

For a German wallet or German registrar-backed environment:

1. Obtain the German registrar onboarding details and credentials.
2. Configure the German registrar for the same tenant that owns the issuer and verifier settings, if you are using the integrated connection.
3. Create the registrar-backed access key chain with **Registrar Enrollment**, or import the German registrar-issued key and certificate.
4. Configure a registration certificate for each presentation request that needs one.
5. Repeat the health, issuance, and presentation checks with the target wallet. Keep the public HTTPS address stable throughout the test.

**Next: [Issue Your First Credential](../cookbooks/first-credential.md).**
