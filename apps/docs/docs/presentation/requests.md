---
title: Create Presentation Requests
---

import SchemaReference from "@site/src/components/SchemaReference";

Every verification starts with `POST /api/verifier/offer`. It creates a session from a [presentation configuration](configure-verification.md) and returns what you hand to the wallet or the browser. The caller needs the `presentation:request` or `presentation:manage` role; only `presentation:request` can also read the resulting session. An API client with `allowedPresentationConfigs` may only use the listed configurations.

## Request body

The annotated body below is generated from the request schema at build time. Placeholder values and comments are for reference; it is not a ready-to-send payload. The nested webhook authentication shows one variant inline and the other as a comment.

<SchemaReference name="presentation-request" mode="body" />

A minimal request only names the flow and the configuration:

```json
{
    "response_type": "uri",
    "requestId": "membership-check"
}
```

### Override rules

`webhook`, `redirectUri`, `transaction_data` and `skewSeconds` in the request replace the values of the presentation configuration for this session only. Values are replaced, not merged: a request `webhook` replaces the configuration's webhook endpoint, and request `transaction_data` replaces the whole configured list. `clientIdScheme` and `expected_origin` exist only on requests. ISO 18013-7 requests use only `webhook`, `skewSeconds` and `expected_origin` (see [below](#iso-18013-7-annex-c)).

### Response

```json
{
    "uri": "openid4vp://?client_id=x509_hash%3A...&request_uri=https%3A%2F%2Feudiplo.example.com%2Fpresentations%2F<walletNonce>%2Foid4vp%2Frequest&request_uri_method=get",
    "crossDeviceUri": "openid4vp://?client_id=x509_hash%3A...&request_uri=https%3A%2F%2Feudiplo.example.com%2Fpresentations%2F<walletNonce>%2Foid4vp%2Frequest%2Fno-redirect&request_uri_method=get",
    "session": "3f0c1d9e-4c1b-4f63-9a59-2f4f0b6a2c11"
}
```

| Field            | Use                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uri`            | Same-device flow: open it on the phone. After the presentation the wallet sends the user to the `redirectUri`, if one is set.                               |
| `crossDeviceUri` | QR code for a wallet on another device. The wallet fetches the request from `.../request/no-redirect`, so it never redirects, even if `redirectUri` is set. |
| `session`        | Session ID for [receiving the result](receive-results.md). The wallet never sees it; its URLs carry a separate random `walletNonce`.                        |

The request expires after the configuration's `lifeTime` (default 300 seconds). Create a new request for every verification: each one can be answered only once.

| Status | Cause                                                                                    |
| ------ | ---------------------------------------------------------------------------------------- |
| `400`  | The body does not match the schema, or `x509_san_dns` was requested for a certificate without DNS name. |
| `403`  | The API client is not allowed to use this `requestId`.                                   |
| `404`  | No usable access key chain: none exists, `accessKeyChainId` points to none, or its certificate is invalid. |
| `409`  | No presentation configuration with this `requestId` exists.                              |

## QR code and same-device redirect

Use `response_type: "uri"` for both. Show `crossDeviceUri` as QR code when the user is on a computer; open `uri` when your page runs on the phone that has the wallet. For a same-device redirect, set `redirectUri`, for example `https://shop.example.com/verified?session={sessionId}`. EUDIPLO replaces `{sessionId}` and appends a one-time `response_code`, which your backend must check before it trusts the result ([Receive Results](receive-results.md#same-device-redirect)).

### Client identifier: `x509_hash` or `x509_san_dns`

The wallet identifies EUDIPLO by the `client_id` in the request, derived from the access certificate:

- `x509_hash` (default): `x509_hash:<base64url SHA-256 of the leaf certificate>`. Works with any access certificate, including self-signed ones.
- `x509_san_dns`: `x509_san_dns:<first DNS name in the leaf certificate's subjectAltName>`. Use it when a wallet only accepts DNS-based client identifiers. Certificates that EUDIPLO generates contain the host name of `PUBLIC_URL`; an imported certificate without DNS name fails with `400`.

## Digital Credentials API

With `response_type: "dc-api"` the browser asks the wallet through `navigator.credentials.get()`; no QR code or app switch is needed. The wallet encrypts its answer for EUDIPLO (`response_mode: dc_api.jwt`) and binds it to the page's origin.

1. **Your backend creates the request** and passes the origin of the page that will call the DC API:

    ```json
    {
        "response_type": "dc-api",
        "requestId": "membership-check",
        "expected_origin": "https://shop.example.com"
    }
    ```

    Without `expected_origin`, EUDIPLO uses the request's `Origin` header and then its `Host` header. A server-side call has no browser origin, so always set it there.

2. **Your backend reads the signed request object** from `GET /api/session/{session}` (field `requestObject`) and hands it to the page.

3. **The page calls the wallet:**

    ```javascript
    const credential = await navigator.credentials.get({
        mediation: "required",
        digital: {
            requests: [
                { protocol: "openid4vp-v1-signed", data: { request: requestObject } },
            ],
        },
    });
    ```

4. **The page posts the wallet response unchanged** to the `response_uri` claim of the request object (`<PUBLIC_URL>/presentations/<walletNonce>/oid4vp`):

    ```javascript
    const result = await fetch(responseUri, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credential.data),
    });
    ```

    EUDIPLO verifies the presentation and answers `200` with `{}` or `{ "redirect_uri": "..." }`. Your backend receives the result by webhook, SSE or polling as in the other flows. If the body also contains `"sendResponse": true` and no redirect is configured, the answer contains the verified credentials.

`@eudiplo/sdk-core` wraps these steps. `isDcApiAvailable()` checks for browser support, and `verifyWithDcApi()` creates the request, calls the wallet and posts the response:

```typescript
import { EudiploClient, isDcApiAvailable } from "@eudiplo/sdk-core";

const client = new EudiploClient({ baseUrl, clientId, clientSecret });

if (isDcApiAvailable()) {
    const { credentials } = await client.verifyWithDcApi({ configId: "membership-check" });
}
```

`verifyWithDcApi()` runs entirely in the browser and needs the API client's secret there. Use it for demos only; in production, keep steps 1 and 2 on your backend.

## ISO 18013-7 Annex C

`response_type: "iso-18013-7"` uses the `org-iso-mdoc` protocol of the DC API, for browsers that do not support the OpenID4VP profile, such as Safari on iOS and macOS. It only requests mDOCs:

```json
{
    "response_type": "iso-18013-7",
    "requestId": "pid-mdoc",
    "expected_origin": "https://shop.example.com"
}
```

The response carries CBOR structures instead of a request URI (`uri` and `crossDeviceUri` are empty):

```json
{
    "session": "<session id>",
    "uri": "",
    "crossDeviceUri": "",
    "org_iso_mdoc": {
        "device_request": "<base64url CBOR DeviceRequest>",
        "encryption_info": "<base64url CBOR EncryptionInfo>"
    }
}
```

The page passes both values to `navigator.credentials.get()` with protocol `org-iso-mdoc` and posts the wallet's encrypted response as `{ "data": "<base64url>" }` to `POST /presentations/{session}/iso-18013-7`. EUDIPLO answers `200` with `{}` or `{ "redirect_uri": "..." }`; a failed verification returns `400` with `error` and `message` ([failure codes](../reference/session-outcome.md#failure-codes)).

Differences from the OpenID4VP flows:

- Only the first `mso_mdoc` credential of the DCQL query is requested; its `meta.doctype_value` is required. Other credentials, `credential_sets` and `claim_sets` are ignored.
- Every element is requested with intent to retain `false`, whatever `intent_to_retain` says.
- `redirectUri`, `transaction_data` and `clientIdScheme` from the request are ignored; the configuration's `redirectUri` still applies after a successful presentation.
- `expected_origin` must equal the origin of the page that calls the DC API, because the session transcript is bound to it.
- Elements the wallet does not return are not rejected separately; check the claims in the result.
- Set [`readerAuth`](configure-verification.md#reader-authentication-iso-18013-7) to sign the request so the wallet can authenticate the verifier.
