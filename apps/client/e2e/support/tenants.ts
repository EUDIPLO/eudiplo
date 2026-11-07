import { randomBytes } from 'node:crypto';
import { expect } from './test';
import { resolvedE2EConfig } from './e2e-config';

const api = resolvedE2EConfig.apiBaseUrl;

/** Access token of an API client from the client credentials grant. */
async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`${api}/api/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()).access_token;
}

/** A request to the API (`path` without `/api`) with the access token of a tenant's admin client. */
export function tenantRequest(
  tenant: TestTenant,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${api}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface TestTenant {
  id: string;
  clientId: string;
  clientSecret: string;
  /** Access token of the tenant's admin client. */
  token: string;
}

/**
 * A new tenant, created as root, whose admin client has these roles. Needs the root
 * credentials (`hasRootCredentials`).
 */
export async function createTenant(
  prefix: string,
  name: string,
  roles: string[]
): Promise<TestTenant> {
  const root = await accessToken(
    resolvedE2EConfig.rootClientId!,
    resolvedE2EConfig.rootClientSecret!
  );
  const id = `${prefix}-${randomBytes(4).toString('hex')}`;
  const response = await fetch(`${api}/api/tenant`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${root}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, roles }),
  });
  expect(response.status).toBe(201);
  const { clientId, clientSecret } = (await response.json()).client;
  return { id, clientId, clientSecret, token: await accessToken(clientId, clientSecret) };
}
