---
title: Credential Presentation
---

EUDIPLO verifies credentials from EUDI wallets with OpenID4VP and, for mDOCs in the browser, ISO/IEC 18013-7 Annex C. You define what to request once in a presentation configuration and create one request per verification. Pick the flow that matches where the user and the wallet are.

## Choose a flow

| Flow                         | When to use                                                                                     | Request (`response_type`)                                     | How the result reaches you                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| QR code (cross-device)       | The user opens your page on a computer and scans with the phone wallet.                         | `uri`, show `crossDeviceUri` as QR code                       | Webhook, SSE or polling; the wallet does not redirect       |
| Same-device redirect         | Your page and the wallet run on the same phone.                                                 | `uri`, open `uri`, set `redirectUri`                          | The wallet returns the browser to `redirectUri` with `response_code` |
| Digital Credentials API      | A browser that supports the DC API asks the wallet directly, without QR code or app switch.     | `dc-api`                                                      | The browser posts the wallet response; webhook, SSE or polling |
| ISO 18013-7 Annex C (`org-iso-mdoc`) | mDOC requests in browsers without the OpenID4VP profile of the DC API, such as Safari. | `iso-18013-7`                                                 | The browser posts the encrypted response; webhook, SSE or polling |

Presentations can also be part of issuance, for example to issue a credential only after the wallet presents a PID. See [Interactive Authorization](../issuance/interactive-authorization.md) and [Authorization Servers](../issuance/authorization-servers.md).

## Pages in this section

1. [Configure verification](configure-verification.md): create the reusable presentation configuration in the Web Client or via the API.
2. [DCQL](dcql.md): describe which credentials and claims to request.
3. [Create presentation requests](requests.md): start a verification for each flow above.
4. [Transaction data](transaction-data.md): bind a transaction, such as a payment, to the presentation.
5. [Receive results](receive-results.md): get the verified claims by webhook, SSE, polling or redirect.

Field and status references: [Presentation configuration](../reference/presentation-configuration.md), [Session outcome](../reference/session-outcome.md), [Webhooks](../reference/webhooks.md). For how a presentation works internally, see [Presentation concepts](../concepts/presentation.md).

To try the complete flow with a wallet, follow the [cookbook](../cookbooks/first-presentation.md).
