# ISO 18013-7 Annex C — `org.iso.mdoc` DC API Support

## 1. Problem

EUDIPLO already supports the OID4VP flow over the browser Digital Credentials API
(`dc-api`, protocol `openid4vp-v1-unsigned`). However, the W3C DC API specification
is multi-protocol, and Safari on iOS and macOS exclusively implements `org-iso-mdoc`
as specified in ISO 18013-7 Annex C. Without this protocol, EUDIPLO-based verifiers
cannot serve users on Apple devices.

The two protocols differ fundamentally:

|  | OID4VP via DC API | ISO 18013-7 Annex C |
|---|---|---|
| DC API protocol | `openid4vp-v1-unsigned` | `org-iso-mdoc` |
| Request format | JSON (OID4VP request object) | CBOR (`DeviceRequest`) |
| Response encryption | JWE/JOSE (ECDH-ES) | HPKE (RFC 9180) |
| Session transcript | `OID4VPDCAPIHandover` | `DCAPIHandover` |
| Encryption key | JWK in `client_metadata.jwks` | COSE_Key in `encryptionInfo` |

---

## 2. End-to-end flow

```
Portal                    EUDIPLO                         Wallet (browser)
  |                          |                                  |
  |  POST /verifier/offer    |                                  |
  |  { response_type:        |                                  |
  |    "iso-18013-7" }  ---> |                                  |
  |                          | 1. getPresentationConfig()       |
  |                          | 2. getEncryptionPublicKey()      |
  |                          | 3. randomBytes(16) → nonce       |
  |                          | 4. buildDeviceRequestCbor()      |
  |                          | 5. buildEncryptionInfo()         |
  |                          | 6. sessionService.create()       |
  |  <--- { session,         |                                  |
  |   org_iso_mdoc: {        |                                  |
  |     device_request,      |                                  |
  |     encryption_info } }  |                                  |
  |                          |                                  |
  |  navigator.credentials.get({ digital: {                    |
  |    requests: [{                                             |
  |      protocol: "org-iso-mdoc",                             |
  |      data: Uint8Array(DeviceRequest),                      |
  |      encryptionInfo: Uint8Array(EncryptionInfo)            |
  |    }]                                                       |
  |  }})  ------------------------------------------>         |
  |                          |                                  |
  |                          |                 7. Wallet verifies credential
  |                          |                 8. Wallet encrypts DeviceResponse
  |                          |                    with HPKE using the key
  |                          |                    from encryptionInfo
  |                          |                                  |
  |  <-- { protocol: "org-iso-mdoc", data: EncryptedResponse } --
  |                          |                                  |
  |  POST /presentations/    |                                  |
  |    :id/iso-18013-7  ---> |                                  |
  |  { data: base64url }     | 9.  getEncryptionPrivateJwk()   |
  |                          | 10. buildIsoMdocDcApiTranscript()
  |                          | 11. hpkeOpen()                  |
  |                          | 12. mdocverifier.verify()       |
  |                          | 13. sessionService.add(Completed)|
  |                          | 14. webhookService.sendWebhook() |
  |  <--- {} or             |                                  |
  |  { redirect_uri: "..." } |                                  |
```

---

## 3. CBOR structures

### 3.1 `DeviceRequest` (ISO 18013-5 §8.3.2.1)

Built by `@owf/mdoc`. The `docType` and `nameSpaces` are derived from the
presentation configuration. Example using an mDL credential:

```
DeviceRequest = {
  "version": "1.0",
  "docRequests": [{
    "itemsRequest": DataItem({
      "docType": "org.iso.18013.5.1",
      "nameSpaces": {
        "org.iso.18013.5.1": {
          "family_name": false,   ← intentToRetain = false
          "birth_date":  false
        }
      }
    })
  }]
}
```

The current implementation processes the first `mso_mdoc` credential from the DCQL
query in the presentation configuration. Support for multiple `DocRequest` entries
is listed as future work (see §12).

### 3.2 `EncryptionInfo` (ISO/IEC TS 18013-7:2025 Annex C)

```
EncryptionInfo = [
  "dcapi",
  EncryptionParameters
]

EncryptionParameters = {
  "nonce" : bstr,                 ← 16 random bytes
  "recipientPublicKey" : COSE_Key ← verifier P-256 public key
}

COSE_Key = {                      ← integer-keyed map per RFC 8152
   1: 2,    ← kty = EC2
  -1: 1,    ← crv = P-256
  -2: <32B>, ← x
  -3: <32B>  ← y
}
```

The request carries `base64url(CBOR(EncryptionInfo))` without padding.

### 3.3 `DCAPIHandover` (SessionTranscript — ISO/IEC TS 18013-7:2025 Annex C)

```
SessionTranscript = [
  null,             ← DeviceEngagementBytes (not used in DC API)
  null,             ← EReaderKeyBytes (not used in DC API)
  [
    "dcapi",
    <32B hash>      ← SHA-256(CBOR([encryptionInfoB64u, origin]))
  ]
]
```

Where `encryptionInfoB64u` is the base64url string of the `EncryptionInfo` exactly
as sent in the DC API request and `origin` is the browser origin
(e.g. `"https://example.com"`). Built via `SessionTranscript.forIsoMdocDcApi()`
from `@owf/mdoc`.

This transcript is used in two places:
- As the `info` parameter for HPKE when **encrypting** (wallet) and **decrypting** (verifier)
- As `sessionTranscript` in `Verifier.verifyDeviceResponse()` for DeviceAuth verification

---

## 4. HPKE (RFC 9180) — rationale for a custom implementation

### Suite

`HPKE-Base-P256-SHA256-AES128GCM`:
- KEM: DHKEM(P-256, HKDF-SHA256)
- KDF: HKDF-SHA256
- AEAD: AES-128-GCM

### Why not use an HPKE library

`@noble/hashes` v2 and most HPKE packages are **ESM-only**. EUDIPLO is a NestJS
project running under CommonJS. Importing ESM from CommonJS requires asynchronous
`dynamic import()`, which is incompatible with `hpkeOpen`'s synchronous call sites.

The implementation uses only the Node.js built-in `node:crypto` module, which
provides ECDH P-256, HMAC-SHA256, and AES-128-GCM — all that HPKE requires at
this cipher suite. No new dependencies are added to the project.

### Encrypted response format

```
EncryptedResponse = [
  "dcapi",
  EncryptedResponseData
]
EncryptedResponseData = {
  "enc" : bstr,       ← wallet's ephemeral P-256 public key, uncompressed (0x04 || x || y, 65 bytes)
  "cipherText" : bstr ← AES-128-GCM output (GCM tag in the last 16 bytes)
}
```

The wallet returns `base64url(CBOR(EncryptedResponse))` without padding.

### HPKE call signature

```
hpkeOpen(encKey, ciphertext, recipientPrivJwk, info=SessionTranscript, aad=b"")
```

### Correctness validation

`hpke.spec.ts` validates `hpkeOpen()` against the **official RFC 9180
Appendix A.3 test vector** for this exact suite (Base mode, DHKEM(P-256,
HKDF-SHA256), HKDF-SHA256, AES-128-GCM), including negative cases (tampered
ciphertext, wrong `info`). This caught a real interop bug: the DHKEM
`ExtractAndExpand` step (RFC 9180 §4.1) must use the label `"eae_prk"` in
`LabeledExtract` — using any other label derives a different shared secret
than a compliant sender, and every wallet-encrypted response fails to decrypt.

---

## 5. Bug fix included: incorrect OID4VP DC API transcript

While implementing ISO 18013-7, a bug was found in the **existing OID4VP via DC API
flow**.

### The problem

`presentations.service.ts` always passed `protocol: "openid4vp"` to
`mdocverifierService.verify()`, which always called `SessionTranscript.forOid4Vp()`.

`forOid4Vp()` builds the transcript with `OpenID4VPHandover`:
```
["OpenID4VPHandover", SHA256(CBOR(clientId + responseUri + nonce))]
```

But for DC API flows, the wallet builds the transcript with `OID4VPDCAPIHandover`:
```
["OID4VPDCAPIHandover", SHA256(CBOR([origin, nonce, jwkThumbprint?]))]
```

If the wallet signs DeviceAuthentication over `OID4VPDCAPIHandover` but the verifier
checks against `OpenID4VPHandover`, verification **fails silently or throws a
signature error**.

### The fix

The mdoc format adapter (`presentations/adapters/mdoc-credential-verifier-format.ts`) now passes:
```typescript
session.useDcApi
  ? { protocol: "dc_api", nonce, origin: expected_origins[0], jwkThumbprint }
  : { protocol: "openid4vp", nonce, clientId, responseUri, responseMode, jwkThumbprint }
```

And `mdocverifierService.verify()` uses `SessionTranscript.forOid4VpDcApi()` when
`protocol === "dc_api"`.

---

## 6. New Session entity fields

```typescript
dcApiProtocol?: string  // "oid4vp" | "iso-18013-7"
browserOrigin?: string  // stored at offer time to reconstruct the DCAPIHandover on response
```

The existing `vp_nonce` field stores the 16-byte nonce as a hex string.

These fields allow the `DCAPIHandover` transcript to be reconstructed at response
time without storing the full CBOR bytes in the session.

---

## 7. New ResponseType: `ISO_18013_7`

```typescript
enum ResponseType {
  URI         = "uri",
  DC_API      = "dc-api",
  ISO_18013_7 = "iso-18013-7",   // new
}
```

`POST /api/verifier/offer` returns a different shape when
`response_type === "iso-18013-7"`:

```json
{
  "session": "uuid",
  "uri": "",
  "crossDeviceUri": "",
  "org_iso_mdoc": {
    "device_request": "<base64url-encoded CBOR DeviceRequest>",
    "encryption_info": "<base64url-encoded CBOR EncryptionInfo>"
  }
}
```

### Response endpoint routing

The browser posts the encrypted response directly to
`POST /presentations/:sessionId/iso-18013-7` (no `/api` prefix). Like the
sibling `oid4vp` wallet-facing routes, the path is listed in
`GLOBAL_PREFIX_EXCLUSIONS` (`main.helpers.ts`) so the global `/api` prefix
does not apply — otherwise the endpoint only exists under
`/api/presentations/...` and the DC API response POST fails with 404.

### Module wiring note

`Iso18013Module` provides `WebhookService`, which injects
`OutboundUrlPolicyService` (outbound webhook hardening). Both must be
registered as providers together — mirroring `Oid4vpModule` — or the
application fails to bootstrap with an `UnknownDependenciesException`.

---

## 8. Design decisions

### 8.1 Verification in `Iso18013Service`, not `VerifyPresentationResponse`

`VerifyPresentationResponse` (the OID4VP use case) is designed for a `vp_token`
JSON object checked against a DCQL query. For ISO 18013-7 the input is raw CBOR
bytes after HPKE decryption.

`Iso18013Service` resolves the mdoc format from the
`CredentialVerifierFormatRegistry` and verifies the DeviceResponse bytes
(base64url) with an `iso-18013-7` binding that carries the pre-built
DCAPIHandover transcript. It shares the mdoc adapter with OID4VP but keeps its
own transcript and result handling.

### 8.2 Transcript built with the library's native handover

`@owf/mdoc` v0.7 ships `SessionTranscript.forIsoMdocDcApi()`, which implements
the `DCAPIHandover` structure of the published ISO/IEC TS 18013-7:2025 Annex C.
`Iso18013Service` builds the transcript once per response and uses it for both
HPKE decryption (`sessionTranscript.encode()` as the `info` parameter) and
DeviceAuth verification (the `SessionTranscript` instance passed through
`MdocSessionDataIso18013` to `Verifier.verifyDeviceResponse()`).

Because the handover hashes the base64url `EncryptionInfo` exactly as sent in the
offer, and `buildEncryptionInfo()` is deterministic, the transcript can be
reconstructed at response time from the stored nonce and tenant key without
persisting the CBOR bytes.

### 8.3 Encryption key: reuse of the existing ECDH-ES key

Each tenant already has a P-256 key used for JWE decryption in OID4VP. The same
P-256 key serves as the HPKE recipient key for ISO 18013-7. No separate key
generation or rotation is needed.

`getEncryptionPrivateJwk()` was added to `EncryptionService` to expose the full
JWK (including `d`) internally for HPKE. This method is never called from outside
the backend.

### 8.4 Per-session nonce

The 16-byte nonce is generated in `createOffer()` via `randomBytes(16)`, stored in
`session.vp_nonce` as a hex string, and consumed in two places:
1. `EncryptionInfo` — sent to the wallet inside the DC API request
2. `buildIsoMdocDcApiTranscript()` — the `EncryptionInfo` is re-encoded from the
   stored nonce at response time to rebuild the `DCAPIHandover` transcript

This nonce is **distinct** from the `walletNonce` used in the OID4VP flow. ISO 18013-7
has no `request_uri` or nonce/sessionId split, so the portal uses the session UUID
directly as the response endpoint identifier.

### 8.5 Compatibility workaround: tolerant `issuerAltName` parsing

**Status: workaround for an external defect — revisit when the AV pilot re-issues
its certificates.**

The EU Age Verification reference-implementation IACA/DS certificates
("Age Verification Issuer CA 01") carry a malformed `issuerAltName`: the
extension value wraps a full nested `Extension` structure around the
`GeneralNames` (RFC 5280 §4.2.1.7 violation), and encodes a URL under the
`dNSName` choice. `@peculiar/x509`'s typed extension throws while parsing it,
and since `X509Certificate.extensions` parses every extension, this breaks
`X509ChainBuilder` and `getExtension()` — making every credential issued under
that IACA unverifiable.

`registerTolerantX509Extensions()` (`shared/utils/x509-tolerant-extensions.ts`,
called at bootstrap in `main.ts`) re-registers the `2.5.29.18` parser with a
subclass that unwraps the nested-Extension variant on a best-effort basis and
falls back to the raw extension bytes instead of throwing.

Two independent halves of this workaround:

1. **Graceful degradation (keep permanently):** a verifier should not fail an
   entire presentation because one non-critical extension of one certificate
   is unparseable. The fallback-to-raw behaviour is sound defensive design.
2. **Nested-Extension unwrapping (removable):** exists only to interoperate
   with the current AV pilot certificates. Once
   `eu-digital-identity-wallet/av-srv-web-issuing-avw-py` fixes its certificate
   generation and re-issues the IACA/DS, this branch becomes dead code and can
   be dropped.

Full analysis and reproduction:
`docs/findings/bug-reports/2026-07-09-av-reference-iaca-malformed-issuer-alt-name.md`.

---

## 9. Frontend integration guide

Portals integrating this endpoint need to handle two differences from the existing
OID4VP DC API flow.

### 9.1 Offer routing

When `POST /api/verifier/offer` is called with `response_type: "iso-18013-7"`, the
offer body contains an `org_iso_mdoc` object instead of a `request_uri`:

```javascript
const offer = await fetch('/api/verifier/offer', {
  method: 'POST',
  body: JSON.stringify({ ..., response_type: 'iso-18013-7' }),
}).then(r => r.json());

// offer.org_iso_mdoc = { device_request: '<base64url>', encryption_info: '<base64url>' }
```

### 9.2 DC API request

The DC API expects raw bytes, not base64url strings. Both fields must be decoded
before passing them to `navigator.credentials.get()`:

```javascript
function fromBase64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

const result = await navigator.credentials.get({
  digital: {
    requests: [{
      protocol: 'org-iso-mdoc',
      data: fromBase64url(offer.org_iso_mdoc.device_request),
      encryptionInfo: fromBase64url(offer.org_iso_mdoc.encryption_info),
    }]
  }
});
```

### 9.3 Response forwarding

The DC API returns a `Uint8Array` for `org-iso-mdoc` (versus a string for
`openid4vp-v1-unsigned`). Normalize to base64url before sending to EUDIPLO and
route to the correct endpoint based on the returned protocol:

```javascript
function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const protocol = result.protocol;   // "org-iso-mdoc" | "openid4vp-v1-unsigned"
const data = result.data instanceof Uint8Array ? toBase64url(result.data) : result.data;

if (protocol === 'org-iso-mdoc') {
  const response = await fetch(`/presentations/${offer.session}/iso-18013-7`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  }).then(r => r.json());

  // If a redirect_uri was configured, the response contains it with a response_code:
  // { redirect_uri: "https://example.com/callback?response_code=<uuid>" }
  if (response.redirect_uri) {
    window.location.href = response.redirect_uri;
  }
} else {
  // existing OID4VP DC API path
}
```

---

## 10. Testing

### Requirements

Any wallet that supports the `org-iso-mdoc` DC API protocol can be used for
end-to-end testing. Browser requirements:
- Chrome M130+ on Android (DC API enabled by default)
- Safari 18+ on iOS/macOS

### Manual E2E steps

1. Configure a presentation with a `response_type` of `iso-18013-7`.
2. Call `POST /api/verifier/offer` with that configuration.
3. Pass the returned `org_iso_mdoc` fields to `navigator.credentials.get()` as
   described in §9.
4. Forward the encrypted response to `POST /presentations/:session/iso-18013-7`.
5. Verify that the session transitions to `Completed` and the webhook fires.

### HPKE unit test (manual)

```typescript
import { hpkeOpen } from './hpke';
import { buildIsoMdocDcApiTranscript, buildEncryptionInfo } from './cbor-request';

// 1. Generate recipient key pair
const { privateKey, publicKey } = await generateKeyPair('ECDH-ES', { crv: 'P-256' });

// 2. Build nonce, EncryptionInfo, and transcript
const nonce = Buffer.alloc(16, 0x42); // fixed for deterministic test
const origin = 'https://example.com';
const jwk = await exportJWK(publicKey);
const encInfoB64u = buildEncryptionInfo(jwk.x!, jwk.y!, nonce).toString('base64url');
const { hpkeInfo } = await buildIsoMdocDcApiTranscript(encInfoB64u, origin);

// 3. Encrypt with a reference HPKE library (e.g. @hpke/core)
// 4. Decrypt with hpkeOpen() and assert plaintext matches
```

---

## 11. New dependencies

**None.** The entire implementation uses only:
- `node:crypto` — ECDH P-256, HMAC-SHA256, AES-128-GCM
- `@owf/mdoc` — already a project dependency (DeviceRequest, SessionTranscript.forIsoMdocDcApi)
- `@owf/cose` — already a project dependency (cborEncode, cborDecode)

---

## 12. Known limitations and future work

| # | Status | Limitation | Impact | Notes |
|---|---|---|---|---|
| 1 | **Resolved** | ~~`encryptionInfo` format not yet validated against a real wallet~~ | — | All CBOR structures (`EncryptionInfo`, `EncryptedResponse`, `DCAPIHandover` SessionTranscript) now follow the published ISO/IEC TS 18013-7:2025 Annex C, matching the EU Age Verification profile and `@owf/mdoc` v0.7's `SessionTranscript.forIsoMdocDcApi()` |
| 2 | **Resolved** | ~~Trust list not applied during verification (`requireX5c=false`)~~ | — | `VerifierOptions` now built from `dcql_query.credentials[].trusted_authorities`, mirroring `presentations.service.ts` |
| 3 | Open | Only the first `mso_mdoc` credential from the DCQL query is processed | Configs with multiple credentials generate only one `DocRequest` | Extend to iterate all `mso_mdoc` credentials and build multiple `DocRequest` entries |
| 4 | **Resolved** | ~~`redirect_uri` not supported after ISO 18013-7 verification~~ | — | `processResponse()` now generates a `responseCode` and returns `redirect_uri` when the session or webhook provides one, matching the OID4VP behavior |
| 5 | **Resolved** | ~~Session audit logging not implemented~~ | — | `AuditLogService` injected; `logFlowStart`, `logCredentialVerification`, `logFlowComplete`, and `logFlowError` calls added to `processResponse()` |
| 6 | **Temporary** | Tolerant `issuerAltName` parsing (§8.5) works around malformed EU AV reference certificates | Without it, AV-pilot credentials fail verification with "Data does not match to GeneralName ASN1 schema" | Remove the nested-Extension unwrapping once the AV pilot re-issues compliant certificates; keep the raw-bytes fallback as defensive design |
| 7 | Open | `readerAuth` (verifier authentication inside the `DeviceRequest`) is not implemented | The wallet cannot cryptographically authenticate the verifier — a gap for complete EUDI deployments, where OID4VP achieves this via the signed request object | Follow-up: sign `ReaderAuthentication = ["ReaderAuthentication", SessionTranscript, ItemsRequestBytes]` (COSE_Sign1, detached) with the tenant's Access key chain. `@owf/mdoc` 0.7 already ships `ReaderAuth`/`ReaderAuthentication`, and the DCAPIHandover transcript is computable at offer time from `expected_origin`. Planned as opt-in per presentation config |
