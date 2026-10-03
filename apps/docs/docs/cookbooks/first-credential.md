---
title: Issue Your First Credential
sidebar_label: Issue a membership credential
---

This is chapter 3 of the [cookbook](index.md). You will create a membership credential containing `name: Max` and `member_id: M-001`, then store it in your wallet.

Before continuing, complete [Install and Connect](foundation.md) and [Wallet and Registrar Requirements](../trust/wallet-registrars.md): sign in as root, check the public health endpoint from your phone, and prepare the certificates required by your wallet. Keep the HTTPS tunnel running.

## Step 1: Create a tenant for the recipe

1. Open **Tenants** and choose **Create Tenant**.
2. Use ID `membership-demo` and name `Membership Demo`.
3. Enable the roles needed to manage issuance and presentation and to create offers and requests. For this isolated learning tenant, you can select all available roles.
4. Save, copy the generated client credentials, and choose **Login as this Client**.

**Expected result:** you are working inside `membership-demo`. Create all subsequent resources in this tenant, not the root account. Save the generated secret; it is not displayed again. For the access model, see [Tenants](../operate/tenants-and-access.md).

## Step 2: Prepare the signing and access keys

Open **Keys** and create these two key chains using the key wizard:

| Purpose                                  | Wizard choices                                                                              | Description                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| Sign the issued credential               | **Credential Signing (Attestation)** → **Create Key Chain (Recommended)**                   | `Membership credential signing` |
| Sign presentation requests to the wallet | **Access Certificate** → **Self-Signed Certificate**, or the wallet-specific registrar path | `Membership verifier access`    |

Use the `db` KMS provider from the minimal installation and keep the wizard's other generated-key defaults. For Paradym or another wallet test environment that accepts self-signed access certificates, use the self-signed choice shown above. For the EU Reference Implementation, import the access key and certificate supplied by its ecosystem operator. For a German wallet, either configure the German registrar and use **Registrar Enrollment**, or import a certificate already issued by the German registrar, as described in [Wallet and Registrar Requirements](../trust/wallet-registrars.md). Record the IDs of the resulting key chains; the wizard generates these IDs, so they may differ between installations.

**Expected result:** both chains have an active key and certificate. The first is selected when defining the credential; the second is used in the verification chapter. See [Key Chains](../trust/keys-and-certificates.md) for certificate import and other provisioning choices.

:::note[Test certificate trust]
HTTPS transport certificates and credential/access certificates are different. A reachable HTTPS endpoint does not make a wallet trust a self-signed issuer or verifier. Use a wallet test environment that accepts these certificates. If your wallet requires ecosystem-issued certificates or registration, provision them through [Certificates](../trust/keys-and-certificates.md#certificates) and [Registration Certificates](../trust/registration-certificates.md) before proceeding.
:::

## Step 3: Set up the issuer

Open **Credential Issuance → Issuer Settings → Use guided setup**.

1. **Identity:** enter name `Membership Demo` and locale `en-US`. A logo is optional.
2. **Wallet access:** keep the enabled built-in authorization server. This recipe uses a pre-authorized offer, so it does not need an external login or presentation-based authorization. Keep batch size `1`; review the DPoP default under **Issuance behavior (advanced)** and use a wallet that supports it. Leave request and response encryption off for this recipe.
3. **Trust:** leave wallet attestation optional and federation off for this test setup. Leave the registration certificate off only if your test wallet permits it; otherwise complete the wallet's trust prerequisites before continuing.
4. **Review:** check the identity and built-in server, then choose **Save settings**.

**Expected result:** the issuer overview shows `Membership Demo` and an enabled built-in authorization server. The full [issuer settings reference](../issuance/issuance-configuration.md) explains each option.

## Step 4: Define the membership credential

Open **Credential Issuance → Credential Types** and choose **Create**. Use the same values below so the next chapter can request this credential without guessing its type or claim paths.

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

Use **Add Field** twice:

| Path        | Type     | Default Value | Mandatory | Selectively Disclosable |
| ----------- | -------- | ------------- | --------- | ----------------------- |
| `name`      | `string` | `Max`         | On        | On                      |
| `member_id` | `string` | `M-001`       | On        | On                      |

Enter `Max` and `M-001` as plain text, without JSON quotes. Defaults are example data; an offer can provide different values. Choose **Continue**.

### Appearance

Enter **Display Name** `Membership`, **Description** `Example membership card`, and **Locale** `en-US`. Leave colors and images at their defaults. Choose **Continue**.

### Settings

1. Expand **Signing, lifetime and trust** and select the attestation key chain you created in step 2.
2. Use a lifetime of **1 day** so the credential remains usable while you work through the recipe. Keep SD-JWT trust format `x5c`.
3. In **Credential Features**, keep holder/key binding enabled, turn **Status Management** off for this short-lived test credential, and select **JWT** as the supported proof type. This avoids requiring key attestation for the first run.
4. Leave attribute providers, webhooks, authorization actions, and reuse policy unconfigured.

Choose **Continue**, check the review, and choose **Create Configuration**.

**Expected result:** `membership` appears under Credential Types, with VCT `urn:example:membership:1` and the two claim fields. See [Credential Configuration](../issuance/credential-configuration.md) for other formats and advanced settings.

:::note[Why status is off here]
This removes status-list provisioning and wallet-specific status-certificate requirements from the first exercise. It is not a production recommendation. Add [Status Management](../issuance/revocation.md) once issuance and verification work.
:::

## Step 5: Send an offer to the wallet

1. Open **Credential Issuance → New Issuance** (or **Sessions → All Sessions → Issuance Offer**).
2. In **Select Flow**, choose the pre-authorized code flow and continue.
3. In **Select Credentials**, choose `membership` and continue.
4. Review the claims for `membership`: `name` must be `Max` and `member_id` must be `M-001`. If the offer form does not populate the configured defaults, enter these values in its claim fields.
5. Leave the optional transaction code and webhook unset for this synthetic-data exercise, then choose **Generate Offer**.
6. Scan the resulting QR code using the wallet's credential-offer scanner. Approve adding the credential.

**Expected result:** the wallet stores a `Membership` credential showing `Max` and `M-001`. Under **Sessions → All Sessions**, open the corresponding issuance session and confirm issuance completed. Generating a QR code alone does not mean the wallet received the credential.

## If something goes wrong

| Symptom                                          | Check                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `membership` credential in the offer selector | Confirm you saved it in the same tenant and did not configure interactive authorization actions for this pre-authorized recipe.                                                                                                                       |
| Wallet cannot open the offer                     | Repeat the phone health check; check `PUBLIC_URL` and that the tunnel is still running. Generate a fresh offer after fixing the URL.                                                                                                                  |
| Wallet rejects the issuer or certificate         | Check wallet trust requirements. A self-signed test certificate is not accepted by every wallet.                                                                                                                                                      |
| Wallet shows an unclear error                    | Open the wallet's logs immediately after the failure and look for the rejected URL, certificate, metadata, or protocol step. The [wallet compatibility guide](../reference/wallet-compatibility.md) lists the log-export steps for supported wallets. |
| Wallet requests attestation unexpectedly         | Check both issuer wallet-attestation settings and the credential's supported proof types. This recipe uses JWT proof and optional wallet attestation.                                                                                                 |
| Wrong claim value                                | Check the offer's claim values, which can override configuration defaults. Changing a configuration does not update a credential already in the wallet; issue another one.                                                                            |

For the EU Reference Implementation, open **Setting → Retrieve Logs**. For Paradym Wallet, open **Settings → Export Logs**. Include the relevant wallet error and the corresponding EUDIPLO session details when investigating a failure, but remove credentials, tokens, private keys, and other personal data before sharing logs.

Keep the issued credential in the wallet and continue in the same tenant.

**Next: [Verify the Membership Credential](first-presentation.md).**
