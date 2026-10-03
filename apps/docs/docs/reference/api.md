---
title: OpenAPI
---

# OpenAPI Documentation

EUDIPLO exposes comprehensive OpenAPI 3.0 documentation for both management and protocol APIs.

## API Endpoints

- **Management API**: `https://<your-instance>/api/docs` — Swagger UI for administrative operations
- **Protocol API**: `https://<your-instance>/docs` — Interactive documentation for OID4VCI/OID4VP endpoints

## API Structure

### Management API (`/api/docs`)

Administrative operations for managing EUDIPLO:

- Tenants & configuration
- Key chains & KMS
- Credential configurations
- Presentation configurations
- Status lists & trust lists
- Audit logs & monitoring

### Protocol API (`/docs`)

Protocol endpoints for wallet integration:

- OID4VCI issuance flows
- OID4VP presentation flows
- Token introspection & revocation
- Wallet attestation & registration

:::tip[Production Isolation]
Consider network isolation for `/api/*` endpoints in production deployments.
:::

## Client Library Generation

Generate type-safe clients from OpenAPI schemas:

```bash
# TypeScript
npx @openapitools/openapi-generator-cli generate \
  -i https://<your-instance>/api/docs-json \
  -g typescript-fetch \
  -o ./generated-api

# Python
openapi-generator generate \
  -i https://<your-instance>/api/docs-json \
  -g python \
  -o ./eudiplo_client
```
