---
title: Attribute providers
---

Fetch claim values from your backend at the moment the wallet requests a credential. An attribute provider is a tenant resource with your endpoint's URL and authentication; credential configurations and offers reference it by ID. The request and response format is specified in the [Attribute provider API](../reference/attribute-provider-api.md).

**Prerequisites:** a client with the `issuance:manage` role and an HTTPS endpoint in your backend. For local development against HTTP or private addresses, set `OUTBOUND_URL_ALLOW_HTTP` or `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK`.

## 1. Implement the endpoint

EUDIPLO posts the session, the requested credential configuration and the identity of the authenticated user. Return the claims under the configuration ID:

```ts
app.post("/claims", (req, res) => {
    const { session, credential_configuration_id, identity, credentials } = req.body;
    const member = members.findBySubject(identity.iss, identity.sub);
    if (!member) return res.status(404).end(); // fails the credential request
    res.json({
        [credential_configuration_id]: { name: member.name, member_id: member.id },
    });
});
```

- `identity` describes the user behind the wallet's access token; what it contains per flow is listed in [Claims](claims.md#identity-passed-to-attribute-providers).
- After a presentation (OID4VP authorization server or interactive authorization), `credentials` holds the verified presented claims, so you can derive the new credential from a PID.
- Return every claim of the credential; the response replaces the static defaults and is validated against the configuration's `fields`.
- To issue later, for example after a manual review, answer `{ "deferred": true }` and follow [Deferred issuance](deferred-issuance.md).
- Any error status fails the credential request. EUDIPLO does not retry.

## 2. Register the provider

```bash
curl -X POST "$EUDIPLO_URL/api/issuer/attribute-providers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "member-db",
    "name": "Member database",
    "url": "https://backend.example.com/claims",
    "auth": {
      "type": "apiKey",
      "config": { "headerName": "x-api-key", "value": "change-me" }
    }
  }'
```

`auth` is required: use `{ "type": "none" }` or an API key that EUDIPLO sends in the named header. Check it in your endpoint. The API returns a literal key as `<redacted>` (a [secret reference](../operate/secret-references.md) as written) and keeps it when you send `<redacted>` back, as for [webhook endpoints](../reference/webhooks.md#webhook-endpoints). In the web client, open **Attribute Providers**.

## 3. Use it

Reference the provider in the [credential configuration](credential-configuration.md) so that every issuance of this type uses it:

```json
{
    "id": "membership",
    "attributeProviderId": "member-db"
}
```

To use a different source for a single offer, set `credentialClaims` in the [offer request](credential-offers.md#choose-the-claim-source):

```json
{
    "credentialClaims": {
        "membership": { "type": "attributeProvider", "attributeProviderId": "member-db-staging" }
    }
}
```

An offer can also define a one-off `webhook` source with the same contract. Offer sources take precedence over the configuration's provider; see [Claims](claims.md#sources-and-priority).

**Check:** issue a credential through an [offer](credential-offers.md) and inspect the request your endpoint received. A failing or unreachable endpoint makes the wallet's credential request fail with `invalid_credential_request`.

Attribute providers only supply claims. To learn whether the wallet stored the credential, use [notifications](notifications.md).

## Delete an attribute provider

`DELETE /api/issuer/attribute-providers/{id}` answers `409` while a credential config of the tenant names the provider in `attributeProviderId`, because issuing that credential would fail without it. The response names the credential configs in `message` and lists them in `references`:

```json
{
    "statusCode": 409,
    "timestamp": "2026-11-19T12:00:00.000Z",
    "path": "/api/issuer/attribute-providers/member-db",
    "code": "ATTRIBUTE_PROVIDER_IN_USE",
    "message": "Attribute provider \"member-db\" is still used by 1 credential config (\"membership\"). Remove these references before deleting the attribute provider.",
    "references": [
        { "kind": "CredentialConfig", "id": "membership", "description": "Membership card" }
    ]
}
```

Remove `attributeProviderId` from these credential configs, or point it to another provider, then delete the provider. Offers that name the provider in `credentialClaims` do not count: an open offer that still names it fails when the wallet requests the credential. A `replace` [configuration import](../operate/configuration-as-code.md) deletes left-out providers without this check.
