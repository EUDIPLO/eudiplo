---
title: "Cookbook: Verify the Membership Credential"
sidebar_label: 3. Verify the credential
---

This is chapter 3 of the **Issue and verify** cookbook. You request the `name` and `member_id` claims of the membership credential from chapter 2, approve the request in the wallet, and inspect the verified result.

## What you will build

A presentation configuration `membership-check` with one DCQL credential query `membership`. It asks for the two claims of `urn:example:membership:1`, and the request is signed with the access certificate from chapter 2.

## Before you start

- **Starts from:** [chapter 2, Issue a membership credential](first-credential.md). The wallet holds the `Membership` credential with `Max` and `M-001`.
- You are signed in as `membership-demo-admin`, and the public HTTPS URL is unchanged.
- The access key chain `Membership verifier access` has a certificate that your wallet's test environment accepts.

## Step 1: Define what to request

Open **Credential Verification → Verification Configs** and choose **+** (**Create Configuration**).

1. On **1. Name**, enter **ID** `membership-check` and **Description** `Verify a membership name and ID`. Choose **Continue**.
2. On **2. Credentials**, choose **Add credential** and enter:

    | Field                 | Value                      |
    | --------------------- | -------------------------- |
    | Query ID              | `membership`               |
    | Credential format     | **SD-JWT VC**              |
    | Credential type (VCT) | `urn:example:membership:1` |
    | Claim path            | `name`                     |

3. Choose **Add claim** and enter `member_id` as the second **Claim path**.
4. Leave **Issuer trust** empty and keep **Require all selected credentials** under **Accepted credential combinations**. Choose **Continue**.

**Checkpoint:** the query asks for exactly two claims of the VCT you issued. The wallet matches on VCT and claim paths, not on the credential configuration ID.

<details>
<summary>Equivalent DCQL for API users</summary>

```json
{
    "credentials": [
        {
            "id": "membership",
            "format": "dc+sd-jwt",
            "meta": {
                "vct_values": ["urn:example:membership:1"]
            },
            "claims": [{ "path": ["name"] }, { "path": ["member_id"] }]
        }
    ]
}
```

</details>

For other credentials, **Import from Issuer** fills in the types and claim paths from issuer metadata. See [DCQL](../presentation/dcql.md) for claim options and alternatives.

## Step 2: Review the verification settings

On **3. Settings**:

1. Keep **Lifetime of the request** at `300` seconds and **Status List Check Mode** at **Strict**. The cookbook credential has no status entry, so there is nothing to check yet.
2. Open **Request and verification options** and select `Membership verifier access` in **Access Key Chain (optional)**. Do not select the credential signing key.
3. Leave the registration certificate empty unless your wallet requires one.
4. Leave redirect URI, webhook and the other options empty.
5. Choose **Continue**, check that the review lists `name` and `member_id`, then choose **Create Configuration**.

**Checkpoint:** `membership-check` appears under **Verification Configs**. It has no issuer trust constraint yet: any correctly signed credential of this type passes. [Accept only trusted issuers](trusted-issuers.md) adds one.

## Step 3: Generate and approve a request

1. Open `membership-check` and choose the **Create offer** button, or open **Credential Verification → New Verification** and select `membership-check` as **Presentation Configuration**.
2. Choose **Generate Request**.
3. Scan the QR code with the wallet that holds the credential.
4. Check that the wallet offers the membership credential and asks for name and member ID, then approve before the request expires.

**Checkpoint:** the wallet reports that the data was shared. That alone does not prove that verification succeeded; check the session in the next step.

## Step 4: Inspect the verified session

Open **Sessions → All Sessions** and open the new presentation session. Its status chip shows `completed`. The **Credentials** tab shows the verified claims for query `membership`:

| Claim       | Expected value |
| ----------- | -------------- |
| `name`      | `Max`          |
| `member_id` | `M-001`        |

**Checkpoint:** the session is `completed` and shows both values. A `failed` session is never a success, even if the wallet reported that it shared the data.

You have now issued and verified a credential end to end. In an application, you receive this result by webhook instead of reading the session view; see [Integrate into your backend](integrate-backend.md).

## Troubleshooting

| Symptom                                     | Cause                                                                    | Fix                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Wallet finds no matching credential         | VCT or claim path differ from chapter 2, or the credential expired       | Compare `urn:example:membership:1`, `name` and `member_id` with the credential type; issue a fresh credential.    |
| Reminder about a missing access certificate | No access key chain selected, or its certificate is not active           | Select `Membership verifier access` in **Access Key Chain (optional)**.                                           |
| Request expired                             | Approved after the 300-second lifetime                                   | Generate a new request and approve it right away.                                                                 |
| Changed claims do not show up               | A wallet credential keeps the claims it was issued with                  | Issue a new credential, then generate a new request.                                                              |

Verifier trust, overasking and failed-session errors are covered in [Troubleshooting](../troubleshooting.md#presentation).

## Next steps

- [Integrate into your backend](integrate-backend.md): create offers and requests from your code and receive the results by webhook.
- [Revocable credentials](revocable-credentials.md): revoke the credential and watch verification fail.
- [Accept only trusted issuers](trusted-issuers.md): restrict `membership-check` to issuers on your trust list.
- [All recipes](index.md)
