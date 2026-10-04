---
title: "Cookbook: Issue a Membership Credential"
sidebar_label: 2. Issue a credential
---

This is chapter 2 of the **Issue and verify** cookbook. You create a tenant with its own keys and issuer identity, define a membership credential, and send it to the wallet on your phone.

## What you will build

A tenant `membership-demo` that issues an SD-JWT VC of type `urn:example:membership:1` with the claims `name: Max` and `member_id: M-001`, using a pre-authorized offer that the wallet scans as a QR code.

## Before you start

- **Starts from:** [chapter 1, Install and connect](foundation.md). You are signed in to the Web Client as root, the tunnel is running, and the phone reaches `https://YOUR-HTTPS-HOST/health`.
- You know which certificates your wallet needs ([Wallet and registrar requirements](../trust/wallet-registrars.md)).

## Step 1: Create a tenant for the recipe

1. Open **Administration → Tenants** and choose the **+** button (**Create New Tenant**).
2. Enter **tenant ID** `membership-demo` and **Name** `Membership Demo`.
3. Under **Initial Admin Client → Client Roles**, keep `clients:manage` and add exactly these roles:

    | Role                   | Allows                                                           |
    | ---------------------- | ---------------------------------------------------------------- |
    | `issuance:manage`      | Keys, issuer settings and credential types                       |
    | `issuance:offer`       | Creating credential offers and viewing issuance sessions         |
    | `presentation:manage`  | Verification configurations                                      |
    | `presentation:request` | Creating presentation requests and viewing presentation sessions |

    Add `registrar:manage` only if your wallet needs registrar certificates. Never give a tenant client `tenants:manage`: it controls **all** tenants of the instance.

4. Choose **Create tenant**. The dialog **Client Secret Generated** shows the client ID `membership-demo-admin` and its secret. Copy both and store them; the secret is not shown again.
5. Choose **Login as this Client**.

**Checkpoint:** the menu at the top right shows **Client ID: membership-demo-admin**, and the navigation shows **Credential Issuance** and **Credential Verification**. Create everything that follows in this tenant. All roles are listed in the [roles reference](../reference/roles.md).

## Step 2: Create the signing and access keys

Open **Cryptographic Assets → Keys**, choose **Create Key** and run the wizard twice:

| Purpose                                  | Wizard choices                                                                     | Description                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| Sign the issued credential               | **Credential Signing (Attestation)** → **Create Key Chain (Recommended)**          | `Membership credential signing` |
| Sign presentation requests to the wallet | **Access Certificate** → the certificate source your wallet needs (see below)      | `Membership verifier access`    |

Keep KMS provider `db` and the other defaults, then choose **Create Key Chain**. For the access certificate, pick the source that matches your wallet:

- **Self-Signed Certificate** for wallet test setups that accept it, such as Paradym.
- **External Certificate** to import a key and certificate chain issued elsewhere, such as the EU Reference Implementation's ecosystem operator. Paste the key into **External Private Key (JWK or PKCS#8 PEM)** and the chain into **Certificate Chain (PEM)**, then choose **Import Key & Certificate**.
- **Registrar Enrollment** for the German ecosystem. It needs a saved registrar configuration under **Registrar → Registrar Config** and the `registrar:manage` role.

**Checkpoint:** both key chains appear under **Keys**, each with an active key and certificate. The wizard generates their IDs; the next steps select them by description. Other provisioning options are in [Keys and certificates](../trust/keys-and-certificates.md).

:::note[Two kinds of certificates]
The HTTPS certificate of your tunnel and the credential and access certificates are unrelated. A reachable HTTPS endpoint does not make a wallet trust a self-signed issuer or verifier.
:::

## Step 3: Set up the issuer

Open **Credential Issuance → Issuer Settings** and choose **Use guided setup**.

1. **Identity:** enter name `Membership Demo` and locale `en-US`. A logo is optional.
2. **Wallet access:** keep the enabled built-in authorization server and batch size `1`. Leave request and response encryption off. Under **Issuance behavior (advanced)**, check that your wallet supports the DPoP setting.
3. **Trust:** leave wallet attestation optional and federation off. Leave the registration certificate off unless your wallet requires one.
4. **Review:** choose **Save settings**.

**Checkpoint:** the issuer overview shows `Membership Demo` and an enabled built-in authorization server. Every option is explained in [Issuer settings](../issuance/issuance-configuration.md).

## Step 4: Define the membership credential

Open **Credential Issuance → Credential Types** and choose **+** (**Create New Credential Configuration**). Use exactly these values; chapter 3 requests the credential by its VCT and claim paths.

### Basics

| Field             | Value                                    |
| ----------------- | ---------------------------------------- |
| Configuration ID  | `membership`                             |
| Description       | `Membership credential for the cookbook` |
| Credential Format | `dc+sd-jwt`                              |
| Host VCT Metadata | **No (Custom URI)**                      |
| VCT URI           | `urn:example:membership:1`               |

Choose **Continue**.

### Claims

Choose **Add Field** twice and enter the values as plain text, without JSON quotes:

| Path        | Type     | Default Value | Mandatory | Selectively Disclosable |
| ----------- | -------- | ------------- | --------- | ----------------------- |
| `name`      | `string` | `Max`         | On        | On                      |
| `member_id` | `string` | `M-001`       | On        | On                      |

Choose **Continue**.

### Appearance

Enter **Display Name** `Membership`, **Description** `Example membership card` and **Locale** `en-US`. Choose **Continue**.

### Settings

1. Under **Signing, lifetime and trust**, select the key chain described as `Membership credential signing` in **Signing Key Chain**, set **Credential Lifetime** to **1 day** and keep **SD-JWT Trust Format** `x5c`.
2. Under **Credential Features**, keep **Key Binding** on and turn **Status Management** off. Set **Supported Proof Types** to **JWT** only, so the first run does not need key attestation.
3. Leave attribute providers, webhooks, authorization actions and reuse policy empty.

Choose **Continue**, check the review, and choose **Create Configuration**.

**Checkpoint:** `membership` appears under **Credential Types** with VCT `urn:example:membership:1` and the two claims. Other formats and settings are in [Credential configuration](../issuance/credential-configuration.md).

:::note[Why status management is off]
It keeps status lists out of the first run. [Revocable credentials](revocable-credentials.md) turns it on.
:::

## Step 5: Send an offer to the wallet

1. Open **Credential Issuance → New Issuance**.
2. In **Select Flow**, choose **Pre-Authorized Code** and **Next**.
3. In **Select Credentials**, select `membership` under **Credential Configuration IDs** and continue.
4. In **Configure Claims**, keep **Form Input** and choose **Use Pre-configured Default Values**. The form now shows `name: Max` and `member_id: M-001`.
5. Leave **Transaction Code (Optional)** empty, then choose **Generate Offer**.
6. Scan the QR code with the wallet's credential-offer scanner and accept the credential.

**Checkpoint:** the wallet shows a `Membership` credential with `Max` and `M-001`. Under **Sessions → All Sessions**, the issuance session has status `fetched` (the wallet received the credential) or `completed` (the wallet also confirmed it through the notification endpoint). A QR code alone does not mean that the wallet received the credential.

## Troubleshooting

| Symptom                                          | Cause                                                                  | Fix                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `membership` is missing in the offer form        | Created in another tenant, or saved with authorization actions         | Check the client ID in the top-right menu; remove interactive authorization actions for this recipe.  |
| **Credential Issuance** is missing in the menu   | The tenant client lacks `issuance:manage` or `issuance:offer`          | Open **Administration → API Clients**, add the roles to `membership-demo-admin`, then sign in again.  |
| Wallet asks for an attestation                   | Proof type **Attestation** or required wallet attestation is set       | Use proof type **JWT** only and keep wallet attestation optional.                                      |
| Wallet shows other claim values                  | The offer overrode the defaults, or the credential is an older one     | Generate a new offer with the default values; a wallet keeps the claims it was issued with.           |

Wallet connection, certificate and metadata errors are covered in [Troubleshooting](../troubleshooting.md).

## Next steps

- Keep the credential in the wallet and stay in tenant `membership-demo`.
- Continue with chapter 3: [Verify the membership credential](first-presentation.md).
