---
title: Presentation Requests
---

Presentation requests are created with the `/verifier/offer` endpoint. Each request references a stored presentation configuration and can optionally override selected runtime values.

Use this page for request payload shape and override behavior. For defining what to request (DCQL, webhook defaults, registration certificate), see [Presentation Configuration](configure-verification.md).

## Endpoint

- `POST /verifier/offer`

## Request Body

import SchemaReference from "@site/src/components/SchemaReference";

The annotated JSON view below is generated from the request DTO's Zod schema at docs build time. It shows all fields, including optional ones; placeholder values and comments are for reference, not a ready-to-send payload. Nested webhook authentication shows one variant inline and the other as a comment.

<SchemaReference name="presentation-request" mode="body" />

For `dc-api`, `expected_origin` falls back to the request's `Origin` header when omitted. For `iso-18013-7`, it must match the calling page's origin as described below.

When `clientIdScheme` is `x509_san_dns`, EUDIPLO uses the first DNS Subject Alternative Name from the active access certificate as the OID4VP client ID. The request fails if the certificate does not contain a DNS Subject Alternative Name.

## Basic Example

```json
{
    "response_type": "uri",
    "requestId": "pid-verification"
}
```

## Example with Runtime Overrides

```json
{
    "response_type": "uri",
    "requestId": "pid-verification",
    "webhook": {
        "url": "https://verifier.example.com/presentation-callback",
        "auth": {
            "type": "none"
        }
    },
    "redirectUri": "https://verifier.example.com/callback?session={sessionId}",
    "transaction_data": [
        {
            "type": "access_control",
            "credential_ids": ["pid"],
            "resource": "Building A"
        }
    ],
    "skewSeconds": 60
}
```

## Override Rules

When a request provides runtime fields, they override the corresponding values from the presentation configuration for that session:

- `webhook` overrides configuration `webhook`
- `redirectUri` overrides configuration `redirectUri`
- `transaction_data` overrides configuration `transaction_data`
- `skewSeconds` overrides configuration `skewSeconds`

These values are not merged.

## ISO 18013-7 Requests

With `response_type: "iso-18013-7"` the offer targets the `org-iso-mdoc` protocol of the Digital Credentials API (ISO/IEC TS 18013-7:2025 Annex C). The referenced presentation configuration must contain an `mso_mdoc` credential with `meta.doctype_value` set, and `expected_origin` must match the origin of the page calling `navigator.credentials.get()`.

```json
{
    "response_type": "iso-18013-7",
    "requestId": "pid-verification",
    "expected_origin": "https://verifier.example.com"
}
```

The offer response contains the CBOR structures for the browser instead of a `request_uri`:

```json
{
    "session": "<uuid>",
    "org_iso_mdoc": {
        "device_request": "<base64url CBOR DeviceRequest>",
        "encryption_info": "<base64url CBOR EncryptionInfo>"
    }
}
```

The browser forwards both values to the wallet via `navigator.credentials.get()` and posts the encrypted wallet response as `{ "data": "<base64url>" }` to `POST /presentations/{session}/iso-18013-7`. Webhook delivery, `redirectUri`, and single-use semantics behave exactly as in the other flows.

:::tip[Reader authentication]
Set [`readerAuth: true`](configure-verification.md#reader-authentication-iso-18013-7) on the presentation configuration to embed a signed `readerAuth` in the `device_request`, letting the wallet cryptographically authenticate the verifier. The request payload here is unchanged.
:::

## Session and Result Retrieval

If no webhook is configured, retrieve the result via the `/session` endpoint using the returned session identifier.

For same-device redirect flows, use the `response_code` from the redirect URL to look up the completed session.

## Related Documentation

- [Credential Presentation Overview](index.md)
- [Presentation Configuration](configure-verification.md)
- [Transaction Data](transaction-data.md)
- [Handling Results](receive-results.md)
- [Webhooks](../reference/webhooks.md#presentation-webhook)
