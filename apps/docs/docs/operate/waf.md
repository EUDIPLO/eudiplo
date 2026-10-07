---
title: Web Application Firewall
description: Which routes wallets, browsers and your backends call, and how to configure a WAF so that issuance and presentation keep working while the management API stays closed.
---

# Web Application Firewall

Configure a WAF, API gateway or reverse proxy so that wallets reach the protocol
endpoints from anywhere while the management API stays closed to the internet.
EUDIPLO has no built-in rate limiting or IP filtering, so this layer does both.
TLS termination and general proxy settings are on [TLS and reverse proxy](tls.md).

## Two surfaces on one host

| Surface            | Paths           | Callers                                                                                                      | Network access    |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- |
| Management API     | `/api/*`        | Your backends, the web client in operators' browsers, the CLI, your configuration pipeline                   | Known networks    |
| Protocol endpoints | All other paths | Wallets, users' browsers, your pages that use the DC API, relying parties that read status and trust lists | Internet          |

Match the `/api/` prefix case-insensitively: the backend routes `/API/session`
like `/api/session`, so a case-sensitive rule can be bypassed. If your WAF
supports an allow list of paths, allow `/api/`, `/.well-known/`, `/issuers/`,
`/presentations/`, `/storage/`, `/health`, `/docs` and `/`, and block the rest.
Check the list against the [path prefixes](../reference/api.md#path-prefixes)
after each upgrade.

## Management API

Allow `/api/*` only from the addresses of your backends and operators, for
example with an IP allow list, a VPN or an identity-aware proxy. Except for the
token endpoint and the Swagger UI (`/api/docs`, `/api/docs-json`), every call
also needs a bearer token, so the network rule is a second layer.

| Setting       | Value                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Methods       | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS` for the CORS preflight of the web client                                                                         |
| Content types | `application/json`; `multipart/form-data` for `POST /api/storage`, `/api/config-bundles/plan/archive` and `/api/config-bundles/import/archive`; `application/x-www-form-urlencoded` for `POST /api/oauth2/token` |
| Body size     | 50 MB for the two archive routes, 10 MB for JSON                                                                                                                       |
| Streaming     | `GET /api/session/{id}/events` is a server-sent event stream: no buffering, long read timeout ([TLS and reverse proxy](tls.md#behind-a-reverse-proxy))              |
| Rate limits   | `POST /api/oauth2/token`, against guessing client secrets                                                                                                              |

Management request bodies contain values that injection signatures mistake for
attacks: PEM keys and certificates (`-----BEGIN …`) in key chain imports,
`${VAR}` placeholders, JSON Schemas with regular expressions, DCQL queries, and
the URLs of webhooks, attribute providers and trust lists. Once `/api/*` is
limited to known networks, exclude the rules that fire there (see
[rules that break EUDIPLO](#rules-that-break-eudiplo)) instead of loosening them
for the whole host.

These routes outside `/api` serve operations rather than wallets:

| Route                                                                             | Caller                                                                                         | Rule                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `POST /issuers/{tenant}/authorize/interactive/complete-web-auth/{authSession}`     | Your backend, with a management token ([interactive authorization](../issuance/interactive-authorization.md#3-run-the-steps)) | Allow from your backends, like `/api/*`           |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/jwks.json`       | Web client, CLI and OAuth libraries, to find the token endpoint                                | Keep open                                         |
| `GET /health`                                                                     | Load balancer, orchestrator, `eudiplo doctor`                                                  | May be limited to internal networks               |
| `GET /docs`, `GET /docs-json`                                                     | People reading the protocol API                                                                | Optional; nothing depends on it                   |

## Protocol endpoints

Wallets call these from phones on mobile networks, so:

- Do not filter by IP address or country beyond what your use case allows.
- Do not use browser challenges such as JavaScript challenges, CAPTCHAs or bot
  management interstitials. Wallets are HTTP clients; they cannot solve them,
  and the request fails.
- Set per-IP rate limits high enough for many users behind one address; mobile
  networks share addresses through carrier-grade NAT.
- Forward the path unchanged. DPoP proofs sign the method and URL, and the
  backend compares them with `PUBLIC_URL` plus the request path, so rewriting,
  case normalization or an added trailing slash breaks token and credential
  requests.

| Route                                                                                                                                    | Methods   | Request body                                                       | Called by                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ | ----------------------------- |
| `/.well-known/openid-credential-issuer/issuers/{tenant}`, `/.well-known/oauth-authorization-server/issuers/…`, `/.well-known/jwks.json/issuers/…` | GET       | –                                                                  | Wallets                       |
| `/issuers/{tenant}/vci/credential-offers/{session}`                                                                                      | GET       | –                                                                  | Wallets                       |
| `/issuers/{tenant}/vci/nonce`                                                                                                            | POST      | Empty                                                              | Wallets                       |
| `/issuers/{tenant}/vci/credential`                                                                                                       | POST      | JSON, or `application/jwt` when the wallet encrypts the request    | Wallets                       |
| `/issuers/{tenant}/vci/deferred_credential`                                                                                              | POST      | JSON                                                               | Wallets                       |
| `/issuers/{tenant}/vci/notification`                                                                                                     | POST      | JSON                                                               | Wallets                       |
| `/issuers/{tenant}/authorize/par`, `…/token`, `…/challenge`, and `par`, `token` under `chained-as/` and `authorization-servers/{id}/`     | POST      | Form; `challenge` has no body                                      | Wallets                       |
| `/issuers/{tenant}/authorize/interactive`                                                                                                | POST      | Form or JSON                                                       | Wallets                       |
| `/issuers/{tenant}/authorize`, `/issuers/{tenant}/chained-as/authorize`, `/issuers/{tenant}/authorization-servers/{id}/authorize`        | GET       | –                                                                  | User's browser, opened by the wallet |
| `/issuers/{tenant}/chained-as/callback`, `/issuers/{tenant}/authorization-servers/{id}/vp-callback`                                      | GET       | –                                                                  | User's browser, redirected back by the upstream provider or wallet |
| `/issuers/{tenant}/credentials-metadata/vct/{id}`                                                                                        | GET       | –                                                                  | Wallets, verifiers            |
| `/issuers/{tenant}/status-management/status-list/{id}`, `/issuers/{tenant}/status-management/status-list-aggregation`                    | GET       | –                                                                  | Wallets, verifiers            |
| `/issuers/{tenant}/trust-list/{id}`                                                                                                      | GET       | –                                                                  | Verifiers, wallets            |
| `/presentations/{session}/oid4vp/request`, `/presentations/{session}/oid4vp/request/no-redirect`                                         | GET, POST | POST: form (`wallet_metadata`, `wallet_nonce`)                     | Wallets                       |
| `/presentations/{session}/oid4vp`                                                                                                        | POST      | Form (`response` or `vp_token`) from wallets; JSON from your page (DC API) | Wallets, your page      |
| `/presentations/{session}/iso-18013-7`                                                                                                   | POST      | JSON (`data`)                                                      | Your page (DC API)            |
| `/storage/{key}`                                                                                                                         | GET       | –                                                                  | Wallets (logos, images)       |

| Setting       | Value                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Methods       | `GET`, `POST`, and `OPTIONS` for the CORS preflight of pages that use the DC API                                                                                              |
| Content types | `application/x-www-form-urlencoded`, `application/json`, `application/jwt`                                                                                                    |
| Body size     | At least 100 KB. The backend accepts form bodies up to 100 KB and JSON bodies up to 10 MB. Presentations with several credentials and credential requests with several proofs or key attestations can exceed 8 KB. |
| Headers       | `DPoP`, `OAuth-Client-Attestation`, `OAuth-Client-Attestation-PoP` and `Authorization: DPoP …` carry JWTs, several KB long with certificate chains (`x5c`). Keep header size limits at their defaults or above. |
| Rate limits   | Token, PAR, nonce and credential endpoints                                                                                                                                    |

## Rules that break EUDIPLO

Wallet messages are base64url-encoded: JWTs, encrypted responses (JWE), SD-JWT
presentations with `~`-separated disclosures, and mdoc responses. Base64url
uses `-` and `_` as regular characters, and signatures, keys and ciphertext are
random, so a token of a few kilobytes often contains `--`. Rules that look for
SQL comments (`--`) or count special characters therefore block requests at
random: the same wallet succeeds once and gets a `403` on the next attempt.
Several wallet requests also carry JSON inside a form field, which SQL
injection rules read as an attack.

OWASP CRS 4.30 with its default anomaly threshold blocked these requests
without exclusions:

| Request                                                                                                  | Paranoia level 1 (default)          | Added at paranoia level 2                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| Encrypted credential request (`Content-Type: application/jwt`)                                           | 920420, every request               | –                                                |
| Encrypted presentation response (JWE), from the wallet or your DC API page                               | –                                   | 942440 (`--`) in more than half of the requests; 942430 |
| JSON in a form field: `vp_token`, `wallet_metadata`, `authorization_details`, `openid4vp_response`        | –                                   | 942200, 942340, 942370, 942430                   |
| ISO 18013-7 response                                                                                     | 942100, rarely (1 of 400)           | 942430                                           |
| URLs of other hosts: `redirect_uri` in PAR and token requests, `iss` in the upstream callback            | –                                   | 931130                                           |
| `PUT`, `PATCH`, `DELETE` on `/api`                                                                       | 911100                              | –                                                |
| Presentation configuration with a DCQL query (the field name `dcql_query.credentials`)                  | 930120                              | –                                                |
| Configuration with `${VAR}` placeholders                                                                 | 932130, 933135                      | –                                                |
| Key chain import with PEM blocks                                                                         | –                                   | 942120, 942440                                   |
| Credential configuration with JSON Schema patterns and URLs                                              | –                                   | 931130, 932240, 942430                           |

CRS skips values that look like a signed JWT (`eyJ….eyJ….`), so credential
requests with JSON proofs passed. At paranoia level 3, PEM line breaks also
trigger 920272. The managed rule sets of Azure WAF and the Cloudflare OWASP
ruleset are derived from CRS, so expect similar matches there. With the AWS Core rule
set, `SizeRestrictions_BODY` blocks bodies over 8 KB: presentation responses,
credential requests with key attestations and configuration imports.

Whatever the product, run new rules in detection mode first (CRS:
`SecRuleEngine DetectionOnly`, AWS: *Count*), go through issuance and
presentation with your wallets several times, and add exclusions by rule and
path from the WAF log.

### OWASP CRS (ModSecurity, Coraza)

Add these rules to `REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf`. Adjust the
IDs if they collide with your own rules. With them, all requests of the table
passed CRS 4.30 at paranoia levels 1 to 3.

```apache
# Management API: allow its methods and skip the injection rules that
# configuration bodies trigger. Restrict /api/ to known networks first.
SecRule REQUEST_FILENAME "@beginsWith /api/" \
    "id:10010,phase:1,pass,nolog,t:none,t:lowercase,\
    setvar:'tx.allowed_methods=GET HEAD POST PUT PATCH DELETE OPTIONS',\
    ctl:ruleRemoveByTag=attack-sqli,\
    ctl:ruleRemoveByTag=attack-rce,\
    ctl:ruleRemoveByTag=attack-injection-php,\
    ctl:ruleRemoveByTag=attack-lfi,\
    ctl:ruleRemoveByTag=attack-rfi,\
    ctl:ruleRemoveById=920272"

# Encrypted credential requests are sent as application/jwt.
SecRule REQUEST_FILENAME "@rx ^/issuers/[^/]+/vci/credential$" \
    "id:10020,phase:1,pass,nolog,t:none,\
    setvar:'tx.allowed_request_content_type=|application/json| |application/jwt|'"

# Wallet-facing endpoints: base64url tokens, JSON in form fields, redirect URIs.
SecRule REQUEST_FILENAME "@rx ^/(?:issuers|presentations)/" \
    "id:10030,phase:1,pass,nolog,t:none,\
    ctl:ruleRemoveByTag=attack-sqli,\
    ctl:ruleRemoveById=931130"
```

On the wallet-facing paths only the SQL injection group and 931130 are removed:
every value there is a token or identifier that the backend verifies, and its
database queries are parameterized. The XSS, command injection, file access and
protocol enforcement rules stay active. On `/api/` the XSS and protocol
enforcement rules stay active; the network restriction and the bearer token
protect the rest.

### AWS WAF

With `AWSManagedRulesCommonRuleSet`:

1. Override `SizeRestrictions_BODY` to *Count*. The rule then only adds the
   label `awswaf:managed:aws:core-rule-set:SizeRestrictions_Body`.
2. Add a rule after the rule group that blocks requests with this label unless
   the URI path starts with `/issuers/`, `/presentations/` or `/api/`.

AWS WAF inspects only the first 8 KB of a body behind an Application Load
Balancer (16 KB, configurable up to 64 KB, on CloudFront and API Gateway); the
signature rules continue with the inspected part of larger bodies.

## Check the configuration

From outside your known networks, the management API must be blocked in any
spelling, and the metadata must be reachable:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://eudiplo.example.com/api/docs
curl -s -o /dev/null -w '%{http_code}\n' https://eudiplo.example.com/API/docs
curl -s -o /dev/null -w '%{http_code}\n' https://eudiplo.example.com/.well-known/openid-credential-issuer/issuers/<tenant>
```

The first two must not return `200`; the third must. Then issue and present a
credential several times with each wallet you support, through every flow you
offer (QR code, same device, DC API), and look for blocked requests in the WAF
log. Because the token false positives are random, one successful run is not
enough. The [load tests](load-testing.md) run many token requests,
issuances and presentations against a deployment, which also exercises the WAF.
Run [`eudiplo doctor`](cli.md#check-an-instance-with-doctor) from a network
that may reach `/api/*` and `/health`.
