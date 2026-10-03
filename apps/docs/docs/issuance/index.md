---
title: Issuance
---

EUDIPLO issues SD-JWT VC (`dc+sd-jwt`) and mDOC (`mso_mdoc`) credentials over OpenID for Verifiable Credential Issuance (OID4VCI). You configure the issuer once, define a credential configuration per credential type, and create an offer for every issuance. Pick the flow that matches how you know the user.

## Choose a flow

| Situation | Offer `flow` | Authorization server | Claims come from | Guide |
| --- | --- | --- | --- | --- |
| Your backend already knows the user, for example in a logged-in portal | `pre_authorized_code`, optionally with a transaction code | [`built-in`](authorization-servers.md#built-in) | Inline offer claims, an attribute provider or static defaults | [First credential](../cookbooks/first-credential.md), [Credential offers](credential-offers.md) |
| The user logs in at your OpenID provider (Keycloak, Entra ID, …) | `authorization_code` | [`chained`](authorization-servers.md#chained) | Attribute provider, with the upstream user as identity | [Issue after login](../cookbooks/issue-after-login.md) |
| Your OAuth server issues the access tokens and can carry the session ID | `authorization_code` (an offer is required) | [`external`](authorization-servers.md#external) | Offer claims or attribute provider; static defaults are not accepted | [External](authorization-servers.md#external) |
| The user proves who they are with a PID or another credential | `authorization_code` | [`oid4vp`](authorization-servers.md#oid4vp) | Attribute provider, which receives the presented claims | [OID4VP](authorization-servers.md#oid4vp) |
| The user completes steps in the wallet (presentation, web form) before issuance; experimental | `authorization_code` | `built-in` with interactive authorization | Attribute provider, which receives the presented claims | [Interactive authorization](interactive-authorization.md) |
| The wallet starts without an offer | none (wallet-initiated) | `built-in` | Attribute provider or static defaults | [Built-in](authorization-servers.md#built-in) |

An attribute provider is only mandatory for tokens of an external authorization server; in all other flows it is the recommended source for user-specific claims. To issue after a manual review, let the attribute provider [defer the credential](deferred-issuance.md).

## Build an issuer

1. [Configure the issuer](issuance-configuration.md): display, authorization servers, batch size, DPoP and offer lifetime.
2. [Configure a credential](credential-configuration.md) per credential type: format, type, claims, display, key binding, lifetime and revocation. All fields: [credential configuration reference](../reference/credential-configuration.md).
3. Decide where claim values come from: [Claims](claims.md), [Attribute providers](attribute-provider.md), [Deferred issuance](deferred-issuance.md).
4. [Create offers](credential-offers.md) from your backend.
5. After issuance: [receive wallet notifications](notifications.md) and [revoke or suspend credentials](revocation.md) ([cookbook](../cookbooks/revocable-credentials.md)).

Which OID4VCI features and formats are supported in detail is listed in [Protocols](../reference/protocols.md). How issuance works internally is described in [Issuance under the hood](../concepts/issuance.md).
