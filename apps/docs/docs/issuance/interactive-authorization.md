---
title: Interactive authorization (experimental)
sidebar_label: Interactive authorization
---

:::caution[Experimental]
The Interactive Authorization Endpoint (IAE) follows a draft extension of OID4VCI. Its behavior may change in minor releases.
:::

Require the user to complete steps in the wallet, such as presenting a PID or finishing a web form, before EUDIPLO issues the authorization code. The steps run at the built-in authorization server's IAE, `POST /issuers/{tenant}/authorize/interactive`, which the server metadata advertises as `interactive_authorization_endpoint`.

**Prerequisites:** the [built-in authorization server](authorization-servers.md#built-in), a [presentation configuration](../presentation/configure-verification.md) for presentation steps, and a wallet that supports the IAE.

## 1. Configure the actions

Add `iaeActions` to the [credential configuration](credential-configuration.md). The wallet completes them in order:

```json
{
    "id": "citizen",
    "iaeActions": [
        {
            "type": "openid4vp_presentation",
            "label": "Identity verification",
            "presentationConfigId": "pid"
        },
        {
            "type": "redirect_to_web",
            "label": "Registration",
            "url": "https://issuer.example.com/register"
        }
    ]
}
```

| Action | Fields | What the user does |
| --- | --- | --- |
| `openid4vp_presentation` | `presentationConfigId` (required), `label` | Presents credentials matching the presentation configuration. |
| `redirect_to_web` | `url` (required), `label`, `description`, `callbackUrl` | Completes an interaction on your web page. `url`, `description` and `callbackUrl` are stored but not sent to the wallet; you send the user to the page yourself. |

EUDIPLO uses the actions of the credential configuration named in the first entry of the wallet's `authorization_details`. If that configuration has no actions, EUDIPLO picks one step from the wallet's `interaction_types_supported`: a presentation with the tenant's most recent presentation configuration, otherwise a web step.

## 2. Create an authorization code offer

Create an offer with `"flow": "authorization_code"` for the built-in server, see [Credential offers](credential-offers.md). The wallet passes the offer's `issuer_state` to the IAE. Since 9.0 it must belong to an offer that can still be redeemed: an authorization code offer of the tenant that has not expired or finished. Otherwise the IAE answers `invalid_request`.

## 3. Run the steps

The wallet starts with `client_id`, `interaction_types_supported`, `issuer_state`, `authorization_details` and PKCE. Since 9.0, `code_challenge_method` must be `S256`; `plain` is rejected. EUDIPLO answers with the first step and an `auth_session`, valid for 10 minutes:

```json
{ "status": "require_interaction", "type": "openid4vp_presentation", "auth_session": "…", "openid4vp_request": { "request": "client_id=…&request_uri=…" } }
```

**Presentation step.** The wallet resolves the request, then sends `auth_session` and `openid4vp_response`. Since 9.0, `openid4vp_response` must be the OpenID4VP authorization response as a JSON string, with the encrypted `response` (`direct_post.jwt`). EUDIPLO verifies it like any presentation (decryption, nonce, audience, DCQL and issuer trust) and answers `access_denied` if it fails. The verified claims are stored on the issuance session and sent to attribute providers in `credentials` ([Attribute provider API](../reference/attribute-provider-api.md)).

**Web step.** EUDIPLO answers with `"type": "redirect_to_web"`. When the user has finished on your page, your backend marks the step as done:

```bash
curl -X POST "$EUDIPLO_URL/issuers/membership-demo/authorize/interactive/complete-web-auth/$AUTH_SESSION" \
  -H "Authorization: Bearer $TOKEN"
```

Since 9.0 this call requires a management token with the `issuance:offer` role of the same tenant (`401` without a token, `403` for another tenant). It has no body and answers `{"success": true}`; an unknown or already completed `auth_session` answers `{"error": "not_found"}`. The wallet then sends `auth_session` and its `code_verifier`.

**Completion.** After the last step EUDIPLO answers `{"status": "ok", "code": "…"}`. Since 9.0 the code expires after 60 seconds. The wallet redeems it at `POST /issuers/{tenant}/authorize/token` with `grant_type=authorization_code`, `code` and `code_verifier`.

## Errors

The IAE answers errors with HTTP 400 and `{ "error", "error_description" }`:

| `error` | Typical cause |
| --- | --- |
| `invalid_request` | Missing `client_id`, `interaction_types_supported` or `code_challenge`; method not `S256`; invalid `issuer_state`; unknown, expired or used `auth_session`; reply that does not match the current step; malformed `openid4vp_response`. |
| `access_denied` | The presentation could not be verified, or the web step was not completed. |
| `invalid_grant` | `code_verifier` does not match the `code_challenge`. |
| `server_error` | No presentation configuration available, or the presentation request could not be created. |
