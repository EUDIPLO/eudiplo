import { randomBytes } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// "Request from EUDI Hub" for registration certificates, on a presentation
// configuration and on the issuer settings. The backend's EUDI Hub endpoints
// are stubbed in the browser, since they would call the real EUDI Hub; the
// backend has its own E2E suite with a stub EUDI Hub. Each test gets its own
// tenant.

test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!hasRootCredentials, 'Creating test tenants needs the root credentials');

const api = resolvedE2EConfig.apiBaseUrl;
const ORG = '01932c5a-9abc-7000-8000-000000000010';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.portal.signature';

function call(tenant: TestTenant, method: string, path: string, body?: unknown) {
  return fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** The EUDI Hub endpoints the dialog uses before it submits. */
async function stubOrganization(page: Page): Promise<void> {
  await page.route('**/api/eudi-hub/organizations', (route) =>
    json(route, 200, [{ id: ORG, name: 'Example Org' }])
  );
  await page.route('**/api/eudi-hub/organization-details', (route) =>
    json(route, 200, {
      id: ORG,
      name: 'Example Org',
      identifiers: [{ type: 'http://data.europa.eu/eudi/id/EUID', value: 'DE/HRB123456B' }],
      serviceDescriptions: [
        {
          name: 'General',
          descriptions: [
            { lang: 'de', content: 'Altersprüfung' },
            { lang: 'en', content: 'Age verification' },
          ],
        },
      ],
      privacyPolicyUris: ['https://example.com/privacy'],
      supportUris: ['https://example.com/support'],
      infoUris: ['https://example.com'],
    })
  );
}

async function pasteTokenAndLoad(page: Page): Promise<void> {
  await expect(page.getByLabel('Access token')).toBeFocused();
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Load Organizations' }).click();
  // Choosing the only organization fills the fields from its data.
  await expect(page.getByLabel('Identifier', { exact: true })).toHaveValue('DE/HRB123456B');
}

test('requests a verifier registration certificate for a presentation configuration', async ({
  page,
}) => {
  const tenant = await createTenant('eudi-hub-rc-e2e', 'EUDI Hub RC E2E', [
    'registrar:manage',
    'presentation:manage',
  ]);
  const id = `age-${randomBytes(3).toString('hex')}`;
  const created = await call(tenant, 'POST', '/api/verifier/config', {
    id,
    description: 'Age check',
    dcql_query: {
      credentials: [
        {
          id: 'pid',
          format: 'dc+sd-jwt',
          meta: { vct_values: ['urn:eudi:pid:de:1'] },
          claims: [{ path: ['age_over_18'] }],
          trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'pid-providers' }] }],
        },
      ],
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  await stubOrganization(page);
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/eudi-hub/registration-certificate/presentation', (route) => {
    sent.push(route.request().postDataJSON());
    return json(route, 201, {
      id: 'rc-1',
      environment: 'sandbox',
      credentialRequestId: 'cr-1',
    });
  });

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/presentation-config/${id}`);
  await page.getByRole('tab', { name: /Security/ }).click();
  const action = page.getByRole('button', { name: 'Request from EUDI Hub' });
  await expect(action).not.toHaveAttribute('aria-busy', 'true');
  await action.click();
  await expect(
    page.getByRole('heading', { name: 'Request Registration Certificate from the EUDI Hub' })
  ).toBeVisible();
  await pasteTokenAndLoad(page);
  await page.getByLabel('Purpose (German)').fill('Prüfung, ob Sie volljährig sind');
  await page.getByLabel('Purpose (English)').fill('Checks that you are of age');

  const reload = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/verifier/config/${id}`) && response.request().method() === 'GET'
  );
  await page.getByRole('button', { name: 'Request Certificate' }).click();

  await expect(
    page.getByText('Registration certificate from the EUDI Hub (sandbox) stored')
  ).toBeVisible();
  await reload;
  expect(sent).toEqual([
    {
      token: TOKEN,
      organizationId: ORG,
      environment: 'sandbox',
      identifier: { type: 'http://data.europa.eu/eudi/id/EUID', value: 'DE/HRB123456B' },
      serviceDescription: [
        { lang: 'de', content: 'Altersprüfung' },
        { lang: 'en', content: 'Age verification' },
      ],
      supportUri: 'https://example.com/support',
      infoUri: 'https://example.com',
      presentationConfigId: id,
      purpose: [
        { lang: 'de', content: 'Prüfung, ob Sie volljährig sind' },
        { lang: 'en', content: 'Checks that you are of age' },
      ],
      privacyPolicy: 'https://example.com/privacy',
    },
  ]);
});

test('starts the request from the purpose and privacy policy kept in the configuration', async ({
  page,
}) => {
  const tenant = await createTenant('eudi-hub-rc-renew-e2e', 'EUDI Hub RC renew E2E', [
    'registrar:manage',
    'presentation:manage',
  ]);
  const id = `age-${randomBytes(3).toString('hex')}`;
  const created = await call(tenant, 'POST', '/api/verifier/config', {
    id,
    description: 'Age check',
    dcql_query: {
      credentials: [
        {
          id: 'pid',
          format: 'dc+sd-jwt',
          meta: { vct_values: ['urn:eudi:pid:de:1'] },
          claims: [{ path: ['age_over_18'] }],
          trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'pid-providers' }] }],
        },
      ],
    },
    registration_cert: {
      purpose: [
        { lang: 'de', content: 'Prüfung, ob Sie volljährig sind' },
        { lang: 'en', content: 'Checks that you are of age' },
      ],
      privacy_policy: 'https://verifier.example/privacy',
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  await stubOrganization(page);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/presentation-config/${id}`);
  await page.getByRole('tab', { name: /Security/ }).click();
  await expect(page.getByText('Checks that you are of age')).toBeVisible();
  await page.getByRole('button', { name: 'Request from EUDI Hub' }).click();
  await pasteTokenAndLoad(page);

  await expect(page.getByLabel('Purpose (German)')).toHaveValue('Prüfung, ob Sie volljährig sind');
  await expect(page.getByLabel('Purpose (English)')).toHaveValue('Checks that you are of age');
  // The organization's privacy policy does not replace the kept one.
  await expect(page.getByLabel('Privacy policy', { exact: false })).toHaveValue(
    'https://verifier.example/privacy'
  );
});

test('requests an issuer registration certificate from the issuer settings', async ({ page }) => {
  const tenant = await createTenant('eudi-hub-rc-e2e', 'EUDI Hub RC E2E', [
    'registrar:manage',
    'issuance:manage',
  ]);
  const created = await call(tenant, 'POST', '/api/issuer/config', {
    authorizationServers: [{ id: 'issuer-built-in', type: 'built-in' }],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  await stubOrganization(page);
  await page.route('**/api/eudi-hub/registration-certificate/issuer', (route) =>
    json(route, 400, {
      statusCode: 400,
      message:
        'Create an SD-JWT VC credential configuration with a vct or an mDOC credential configuration with a docType before requesting an issuer registration certificate',
    })
  );

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config');
  await page.getByRole('tab', { name: /Registration Certificate/ }).click();
  const action = page.getByRole('button', { name: 'Request from EUDI Hub' });
  await expect(action).not.toHaveAttribute('aria-busy', 'true');
  await action.click();
  await pasteTokenAndLoad(page);
  // An issuer certificate names credential types, not a purpose.
  await expect(page.getByLabel('Purpose (German)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Request Certificate' }).click();

  await expect(page.getByRole('alert')).toContainText(
    'Create an SD-JWT VC credential configuration'
  );
  await expect(
    page.getByRole('heading', { name: 'Request Registration Certificate from the EUDI Hub' })
  ).toBeVisible();
});

test('does not offer the request without the registrar:manage role', async ({ page }) => {
  const tenant = await createTenant('eudi-hub-rc-e2e', 'EUDI Hub RC E2E', ['issuance:manage']);
  await call(tenant, 'POST', '/api/issuer/config', {
    authorizationServers: [{ id: 'issuer-built-in', type: 'built-in' }],
  });

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config');
  await page.getByRole('tab', { name: /Registration Certificate/ }).click();

  await expect(page.getByText('Certificate Status')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request from EUDI Hub' })).toHaveCount(0);
});
