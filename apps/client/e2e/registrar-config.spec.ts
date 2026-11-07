import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant as createTestTenant } from './support/tenants';

// The Registrar Config screen against the real backend. The backend checks the
// registrar credentials at the token endpoint of the OIDC realm before it
// saves them, so a stub realm runs in the test process. The registrar itself
// is not called. Each test gets its own tenant with the registrar:manage role.
// The access key wizard's registrar enrollment is tested here too, as it
// needs the same tenant and realm.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;
const registrarUrl = 'https://registrar.example.com/api';
const username = 'registrar-user';
const password = 'registrar-password';

let realms: Server;
let realmsOrigin: string;
/** Realms that refuse the account, as after a password change at the registrar. */
const lockedRealms = new Set<string>();

/** URL of a stub OIDC realm; every realm that is not locked accepts the same account. */
function realmUrl(name: string): string {
  return `${realmsOrigin}/realms/${name}`;
}

/** Answers the discovery and password-grant requests the backend sends to an OIDC realm. */
function stubRealms(request: IncomingMessage, response: ServerResponse): void {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const path = new URL(request.url ?? '/', 'http://realm').pathname;
  const [, realm, endpoint] = /^\/realms\/([\w-]+)\/(.+)$/.exec(path) ?? [];
  if (request.method === 'GET' && endpoint === '.well-known/openid-configuration') {
    send(200, {
      issuer: realmUrl(realm),
      token_endpoint: `${realmUrl(realm)}/protocol/openid-connect/token`,
    });
    return;
  }
  if (request.method === 'POST' && endpoint === 'protocol/openid-connect/token') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const valid =
        !lockedRealms.has(realm) &&
        form.get('grant_type') === 'password' &&
        form.get('username') === username &&
        form.get('password') === password;
      if (valid) {
        send(200, { access_token: 'stub-token', token_type: 'Bearer', expires_in: 300 });
      } else {
        send(401, { error: 'invalid_grant' });
      }
    });
    return;
  }
  send(404, { error: 'not_found' });
}

test.beforeAll(async () => {
  realms = createServer(stubRealms);
  await new Promise<void>((resolve) => realms.listen(0, '127.0.0.1', resolve));
  realmsOrigin = `http://127.0.0.1:${(realms.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => realms.close(() => resolve()));
});

interface Tenant {
  clientId: string;
  clientSecret: string;
  /** Sends a request to the backend API as the tenant's admin client. */
  call(method: string, path: string, body?: unknown): Promise<Response>;
}

/** A new tenant whose admin client may manage the registrar configuration and these roles. */
async function createTenant(extraRoles: string[] = []): Promise<Tenant> {
  const { clientId, clientSecret, token } = await createTestTenant(
    'registrar-e2e',
    'Registrar E2E',
    ['registrar:manage', ...extraRoles]
  );
  return {
    clientId,
    clientSecret,
    call: (method, path, body) =>
      fetch(`${api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

async function openRegistrarConfig(page: Page): Promise<void> {
  await page.locator('mat-sidenav').getByText('Registrar Config', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Registrar Configuration' })).toBeVisible();
}

function signIn(page: Page, tenant: Tenant): Promise<void> {
  return loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
}

const storedDefaults = {
  privacy_policy: 'https://verifier.example/privacy',
  support_uri: 'mailto:support@verifier.example',
  provides_attestations: ['urn:example:pid'],
};

async function storeConfig(tenant: Tenant, extra: Record<string, unknown> = {}): Promise<void> {
  const response = await tenant.call('POST', '/api/registrar/config', {
    registrarUrl,
    oidcUrl: realmUrl('registrar'),
    clientId: 'registrar-client',
    username,
    password,
    registrationCertificateDefaults: storedDefaults,
    ...extra,
  });
  expect(response.status).toBe(201);
}

async function storedConfig(tenant: Tenant): Promise<Record<string, unknown>> {
  const response = await tenant.call('GET', '/api/registrar/config');
  expect(response.status).toBe(200);
  return response.json();
}

test.beforeEach(() => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant for the registrar.'
  );
});

test('creates a configuration and explains a URL without a scheme', async ({ page }) => {
  const tenant = await createTenant();
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  await page.getByRole('textbox', { name: 'OIDC URL' }).fill(realmUrl('registrar'));
  await page.getByRole('textbox', { name: 'Client ID' }).fill('registrar-client');
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const registrarUrlField = page.getByRole('textbox', { name: 'Registrar URL' });
  await registrarUrlField.fill('registrar.example.com/api');
  await registrarUrlField.blur();
  await expect(
    page.getByText('Enter a full URL, for example https://registrar.example.com/api')
  ).toBeVisible();
  // Save stays usable; a click says what keeps the configuration from saving.
  const save = page.getByRole('button', { name: 'Save Configuration' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(registrarUrlField).toBeFocused();
  await expect(
    page.getByText('Check the highlighted fields in Registrar Credentials.')
  ).toBeVisible();
  expect((await tenant.call('GET', '/api/registrar/config')).status).toBe(404);

  await registrarUrlField.fill(registrarUrl);
  await save.click();

  await expect(page.getByText('Configuration saved successfully')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update Configuration' })).toBeVisible();
  expect(await storedConfig(tenant)).toMatchObject({
    registrarUrl,
    oidcUrl: realmUrl('registrar'),
    hasPassword: true,
  });
});

test('reports credentials the OIDC realm rejects', async ({ page }) => {
  const tenant = await createTenant();
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  await page.getByRole('textbox', { name: 'Registrar URL' }).fill(registrarUrl);
  await page.getByRole('textbox', { name: 'OIDC URL' }).fill(realmUrl('registrar'));
  await page.getByRole('textbox', { name: 'Client ID' }).fill('registrar-client');
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Save Configuration' }).click();

  await expect(
    page.getByText(/Invalid registrar credentials: the OIDC provider answered with HTTP 401/)
  ).toBeVisible();
  expect((await tenant.call('GET', '/api/registrar/config')).status).toBe(404);
});

test('asks for the password again after a URL change and replaces the configuration', async ({
  page,
}) => {
  const tenant = await createTenant();
  await storeConfig(tenant, { clientSecret: 'registrar-secret' });
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  await page.getByRole('textbox', { name: 'OIDC URL' }).fill(realmUrl('other'));
  await expect(page.getByText('The URL changed. Enter the password again.')).toBeVisible();
  const update = page.getByRole('button', { name: 'Update Configuration' });
  await update.click();
  const passwordField = page.getByLabel('Password', { exact: true });
  await expect(passwordField).toBeFocused();
  await expect(
    page.getByText('Check the highlighted fields in Registrar Credentials.')
  ).toBeVisible();

  await passwordField.fill(password);
  await update.click();

  await expect(page.getByText('Configuration saved successfully')).toBeVisible();
  expect(await storedConfig(tenant)).toMatchObject({
    oidcUrl: realmUrl('other'),
    hasPassword: true,
    hasClientSecret: false,
    registrationCertificateDefaults: storedDefaults,
  });
});

test('keeps registration certificate defaults the form does not show', async ({ page }) => {
  const tenant = await createTenant();
  await storeConfig(tenant);
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  await expect(page.getByRole('textbox', { name: 'Support URI', exact: true })).toHaveValue(
    storedDefaults.support_uri
  );
  await page
    .getByRole('textbox', { name: 'Support URI', exact: true })
    .fill('https://verifier.example/help');
  await page.getByRole('button', { name: 'Update Configuration' }).click();
  await expect(page.getByText('Configuration saved successfully')).toBeVisible();

  const stored = await (await tenant.call('GET', '/api/registrar/config')).json();
  expect(stored.registrationCertificateDefaults).toEqual({
    ...storedDefaults,
    support_uri: 'https://verifier.example/help',
  });
});

test('shows an error with Retry instead of an empty form when loading fails', async ({ page }) => {
  const tenant = await createTenant();
  await storeConfig(tenant);
  // The dashboard loads the configuration too, so every load fails until Retry.
  let failLoading = true;
  await page.route('**/api/registrar/config', (route) =>
    failLoading
      ? route.fulfill({ status: 500, json: { message: 'Internal server error' } })
      : route.fallback()
  );
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  await expect(
    page.getByRole('alert').filter({ hasText: 'The registrar configuration could not be loaded' })
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Registrar URL' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save Configuration/ })).toHaveCount(0);

  failLoading = false;
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByRole('textbox', { name: 'Registrar URL' })).toHaveValue(registrarUrl);
  await expect(page.getByRole('button', { name: 'Update Configuration' })).toBeVisible();
});

test('deletes the configuration', async ({ page }) => {
  const tenant = await createTenant();
  await storeConfig(tenant);
  await signIn(page, tenant);
  await openRegistrarConfig(page);

  let question = '';
  page.once('dialog', (dialog) => {
    question = dialog.message();
    return dialog.accept();
  });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByText('Configuration deleted')).toBeVisible();
  expect(question).toContain(
    'Its URLs, account, stored password, relying party contact and registration certificate defaults are removed.'
  );
  await expect(page.getByRole('button', { name: 'Save Configuration' })).toBeVisible();
  expect((await tenant.call('GET', '/api/registrar/config')).status).toBe(404);
});

test('keeps no access key when the registrar refuses its enrollment', async ({ page }) => {
  const tenant = await createTenant(['keys:manage']);
  // Saved while the realm accepts the account, refused when the key is enrolled.
  const realm = `locked-${randomBytes(4).toString('hex')}`;
  await storeConfig(tenant, { oidcUrl: realmUrl(realm) });
  lockedRealms.add(realm);
  const description = `Refused enrollment ${randomBytes(4).toString('hex')}`;
  await signIn(page, tenant);

  // A radio's name includes its description, and the hint of Access
  // Certificate names registrar enrollment, so the names are anchored.
  await page.goto('/keys/create');
  await page.getByRole('radio', { name: /^Access Certificate/ }).check();
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('radio', { name: /^Registrar Enrollment/ }).check();
  await expect(
    page.getByText('Registrar configured. Its credentials are checked when you enroll.')
  ).toBeVisible();
  await page.getByRole('button', { name: /^Enroll Certificate/ }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill(description);
  const createAndEnroll = page.getByRole('button', { name: 'Create & Enroll' });
  await createAndEnroll.click();

  const refusal = page.getByRole('alert').filter({
    hasText:
      /Failed to authenticate with registrar: the OIDC provider answered with HTTP 401.* No key was kept\. Check the registrar configuration and try again\./,
  });
  await expect(refusal).toBeVisible();
  await expect(refusal).toBeFocused();
  await expect(page).toHaveURL(/\/keys\/create$/);
  await expect(createAndEnroll).toBeEnabled();
  const keyChains = await (await tenant.call('GET', '/api/key-chain')).json();
  expect(keyChains.map((keyChain: { description?: string }) => keyChain.description)).not.toContain(
    description
  );

  await refusal.getByRole('link', { name: 'Go to Registrar' }).click();
  await expect(page.getByRole('heading', { name: 'Registrar Configuration' })).toBeVisible();
});

/** A new self-signed standalone access key chain of the tenant. */
async function createAccessKey(tenant: Tenant): Promise<string> {
  const response = await tenant.call('POST', '/api/key-chain', {
    usageType: 'access',
    type: 'standalone',
    description: `Access key ${randomBytes(4).toString('hex')}`,
  });
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

test('enrolls an existing access key from its page and reports a refusal', async ({ page }) => {
  const tenant = await createTenant(['keys:manage']);
  // Saved while the realm accepts the account, refused when the key is enrolled.
  const realm = `locked-${randomBytes(4).toString('hex')}`;
  await storeConfig(tenant, { oidcUrl: realmUrl(realm) });
  lockedRealms.add(realm);
  const keyId = await createAccessKey(tenant);
  await signIn(page, tenant);

  await page.goto(`/keys/${keyId}`);
  await expect(page.getByText('This is a self-signed standalone key.')).toBeVisible();
  const enroll = page.getByRole('button', { name: 'Enroll with Registrar' });
  // Clicks are held back while the key's config ownership is looked up.
  await expect(enroll).not.toHaveAttribute('aria-busy', 'true');
  await enroll.click();

  await expect(
    page.getByText(
      /Failed to authenticate with registrar: the OIDC provider answered with HTTP 401/
    )
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to Registrar' }).click();
  await expect(page.getByRole('heading', { name: 'Registrar Configuration' })).toBeVisible();
  // A refused enrollment keeps the key as it was.
  expect((await tenant.call('GET', `/api/key-chain/${keyId}`)).status).toBe(200);
});

test('links to the registrar configuration instead of the enrollment without one', async ({
  page,
}) => {
  const tenant = await createTenant(['keys:manage']);
  const keyId = await createAccessKey(tenant);
  await signIn(page, tenant);

  // The action stays hidden while the configuration is read, so wait for the answer.
  const configRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/registrar/config') && response.request().method() === 'GET'
  );
  await page.goto(`/keys/${keyId}`);
  expect((await configRead).status()).toBe(404);
  await expect(page.getByRole('button', { name: 'Copy PEM' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enroll with Registrar' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Configure the registrar to enroll this key' }).click();
  await expect(page.getByRole('heading', { name: 'Registrar Configuration' })).toBeVisible();
});
