---
title: Verify the Membership Credential
sidebar_label: Request and verify claims
---

This is chapter 4 of the [cookbook](index.md). You will request the `name` and `member_id` claims from the membership credential issued in [chapter 3](first-credential.md), then inspect the verified result.

Before continuing, confirm:

- The wallet contains the unexpired `Membership` credential with `Max` and `M-001`.
- You are still signed in to tenant `membership-demo`.
- The public HTTPS URL is unchanged and reachable from the phone.
- The access key chain from chapter 3 has an active certificate accepted by your wallet's test environment.

## Step 1: Define what to request

Open **Credential Verification → Verification Configs** and choose **Create**.

1. In **Name**, enter ID `membership-check` and description `Verify a membership name and ID`. Choose **Continue**.
2. In **Credentials**, choose **Add credential** and enter:

    | Field                 | Value                      |
    | --------------------- | -------------------------- |
    | Query ID              | `membership`               |
    | Credential format     | `dc+sd-jwt`                |
    | Credential type (VCT) | `urn:example:membership:1` |
    | First claim path      | `name`                     |

3. Choose **Add claim** and enter `member_id` in the new claim-path field.
4. Leave claim options and issuer trust constraints unconfigured for this first exercise. Keep **Require all selected credentials** under **Accepted credential combinations**. There is only one credential in this request.
5. Choose **Continue**.

**Expected result:** the query requests exactly two claims from the same VCT you issued. The credential configuration ID alone is not enough to match a wallet credential; the VCT and claim paths must match.

<details>
<summary>Equivalent DCQL for API users</summary>

The visual builder produces this query:

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

For other credentials, **Import from Issuer** can populate the actual types and claim paths from issuer metadata. See the [visual query builder](../presentation/configure-verification.md#visual-query-builder-and-json) for trusted issuers, alternatives, and claim options.

## Step 2: Review verification settings

1. In **Settings**, keep the **300-second** request lifetime and strict credential status checks. The cookbook credential has no status entry because status management was disabled at issuance.
2. In the access-key settings, select the **access** key chain created in chapter 3, or confirm the tenant default uses that chain. Do not select the attestation key used to sign credentials.
3. Leave registration certificates unset only if your test wallet permits this. A reminder about a missing access certificate must be resolved before generating a request.
4. Leave redirect, webhook, attachment, transaction-data, and verification overrides unset.
5. Choose **Continue**, confirm the review lists `name` and `member_id`, then choose **Create Configuration**.

**Expected result:** `membership-check` is saved with one credential query and two requested claims. No issuer trust constraint is configured: successful cryptographic verification alone is not a business policy for which issuers you accept. Add [trusted authorities](../presentation/dcql.md) before using this request for real access decisions.

## Step 3: Generate and approve a request

1. On the saved configuration, choose **Create offer**, or open **Credential Verification → New Verification** and select `membership-check`.
2. Choose **Generate Request**.
3. Scan the resulting QR code with the same wallet that received the credential.
4. Confirm that the wallet offers your membership credential and requests its name and member ID. Approve disclosure before the request expires.

**Expected result:** the wallet submits the presentation and EUDIPLO processes the response. Generating the QR code or approving in the wallet is not, by itself, proof that verification succeeded.

## Step 4: Inspect the verified session

Open **Sessions → All Sessions**, find the new presentation session, and open it. Confirm it completed successfully, then inspect the verified claims for query `membership`:

| Claim       | Expected value |
| ----------- | -------------- |
| `name`      | `Max`          |
| `member_id` | `M-001`        |

The session view can include additional protocol and credential information. Check the verification outcome as well as the claim values; do not treat an unverified or failed response as successful.

You have now completed the flow from installation to issuance and verification. For an application integration, use [Handling Results](../presentation/receive-results.md) and [Webhooks](../reference/webhooks.md) rather than manually reading the session view.

## If something goes wrong

| Symptom                                                  | Check                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No matching credential                                   | Compare the VCT and both claim paths with chapter 3; check the wallet holds the credential and it has not expired.                                                                                                                                                                                                             |
| Access-certificate readiness warning                     | Check that the selected key chain has usage `access` and an active certificate.                                                                                                                                                                                                                                                |
| Wallet rejects the verifier                              | Configure the certificate trust or registration required by that wallet ecosystem. Do not disable verification checks to bypass trust failures.                                                                                                                                                                                |
| Request rejected for overasking                          | Check that the registration certificate authorizes the credential the user wants to present. Its `credentials` claim must include every credential in the effective DCQL query, including the requested format, claims, and metadata. Regenerate or update the certificate if it was created before this credential was added. |
| Request expired                                          | Generate a new request and approve it within 300 seconds.                                                                                                                                                                                                                                                                      |
| Wallet approved, but session failed                      | Inspect session details and wallet logs; verify public URL reachability, certificate trust, and the credential's validity period.                                                                                                                                                                                              |
| Expected values changed in the editor but not the result | An existing wallet credential keeps the claims it was issued with. Issue a new credential, then generate another presentation request.                                                                                                                                                                                         |

**Next: [Extend the Flow](index.md#choose-your-next-outcome).**
