import { generateKeyPairSync } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { createKeyChain } from './support/key-chains';
import { federationSection } from './support/federation';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// OpenID Federation trust anchors: registered with their federation keys under
// Cryptographic Assets, then picked in Issuer Settings and in a presentation
// configuration. The backend refuses configurations that add an unregistered one.
// No trust anchor is resolved here, so the keys need not belong to a live federation.

test.use({ storageState: { cookies: [], origins: [] } });
// Each test builds on the trust anchor and configurations the earlier ones saved.
test.describe.configure({ mode: 'serial' });

const anchorId = 'example-federation';
const entityId = 'https://ta.example.org';
const unregistered = 'https://unregistered-ta.example.org';
const jwk = {
  ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }),
  kid: 'ta-2026',
};

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('fed-anchors', 'Federation Trust Anchors', [
    'issuance:manage',
    'presentation:manage',
  ]);
  // A presentation configuration needs a key chain to sign its requests.
  await createKeyChain(tenant.token, 'access', 'Federation verifier access');
});

const apiRequest = (method: string, path: string, body?: unknown) =>
  tenantRequest(tenant, method, path, body);

async function selectOption(page: Page, field: Locator, option: string | RegExp) {
  await field.click();
  await page.getByRole('option', { name: option }).click();
}

test('registers a trust anchor with its federation keys', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.locator('mat-sidenav').getByText('Federation Trust Anchors', { exact: true }).click();
  await expect(page).toHaveURL(/\/federation-trust-anchor$/);
  await expect(page.getByText('No federation trust anchors yet.')).toBeVisible();

  await page.getByRole('link', { name: 'Register trust anchor' }).click();
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill(anchorId);
  await page.getByRole('textbox', { name: 'Entity ID' }).fill(entityId);
  await page.getByRole('textbox', { name: 'Description (optional)' }).fill('Draft');
  // Monaco loads lazily; type again until the editor shows the keys.
  const editor = page.locator('app-editor .monaco-editor');
  await expect(async () => {
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(JSON.stringify({ keys: [jwk] }));
    await expect(editor.locator('.view-lines')).toContainText('ta-2026', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Register Trust Anchor' }).click();

  await expect(page).toHaveURL(new RegExp(`/federation-trust-anchor/${anchorId}$`));
  await expect(page.getByRole('cell', { name: 'ta-2026' })).toBeVisible();
  await expect(page.getByText(entityId, { exact: true })).toBeVisible();

  // Edit the description; the ID stays locked.
  await page.getByRole('link', { name: 'Edit trust anchor' }).click();
  await expect(page.getByRole('textbox', { name: 'ID', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Description (optional)' }).fill('Example federation');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/federation-trust-anchor/${anchorId}$`));
  await expect(page.getByText('Example federation', { exact: true })).toBeVisible();

  const stored = await (await apiRequest('GET', `/federation-trust-anchor/${anchorId}`)).json();
  expect(stored).toMatchObject({
    entityId,
    description: 'Example federation',
    jwks: { keys: [jwk] },
  });
});

test('picks the registered trust anchor in Issuer Settings', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');

  // The new tenant has no identity yet, so the guided setup opens.
  await expect(page.getByText('Step 1 of 4 · Identity')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Federation Trust Anchors');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Wallet access')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Trust')).toBeVisible();

  const section = await federationSection(page);
  await section.getByRole('switch', { name: /Enable OpenID Federation/ }).click();
  await section.getByRole('button', { name: 'Add Trust Anchor' }).click();
  await selectOption(
    page,
    section.getByRole('combobox', { name: 'Trust Anchor 1' }),
    /\(https:\/\/ta\.example\.org\)/
  );
  await expect(section.getByRole('textbox', { name: 'Entity Configuration URI' })).toHaveValue(
    `${entityId}/.well-known/openid-federation`
  );
  await expect(section.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Review')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page).toHaveURL(/\/issuance-config$/);

  const config = await (await apiRequest('GET', '/issuer/config')).json();
  expect(config.federation.trustAnchors).toEqual([
    { entityId, entityConfigurationUri: `${entityId}/.well-known/openid-federation` },
  ]);
});

test('picks the registered trust anchor as a federation authority of a presentation config', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/presentation-config/create');

  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('federation-check');
  await page.getByRole('textbox', { name: 'Description' }).fill('Accept PIDs of the federation');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Add credential' }).click();
  await page.getByRole('textbox', { name: 'Credential type (VCT)' }).fill('urn:eudi:pid:1');
  await page.getByRole('textbox', { name: 'Claim path' }).fill('given_name');
  await page.getByRole('button', { name: 'Issuer trust' }).click();
  await page.getByRole('button', { name: 'Add federation trust anchor' }).click();
  await selectOption(
    page,
    page.getByRole('combobox', { name: 'Federation trust anchor' }),
    /\(https:\/\/ta\.example\.org\)/
  );
  await expect(page.getByText(`Federation: ${entityId}`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create Configuration' }).click();
  await expect(page).toHaveURL(/\/presentation-config\/federation-check$/);

  const config = await (await apiRequest('GET', '/verifier/config/federation-check')).json();
  expect(config.dcql_query.credentials[0].trusted_authorities).toEqual([
    { type: 'openid_federation', values: [entityId] },
  ]);
});

test('refuses configurations that add an unregistered trust anchor', async () => {
  const issuance = await apiRequest('POST', '/issuer/config', {
    authorizationServers: [{ id: 'issuer-built-in', type: 'built-in' }],
    federation: {
      trustAnchors: [
        { entityId, entityConfigurationUri: `${entityId}/.well-known/openid-federation` },
        {
          entityId: unregistered,
          entityConfigurationUri: `${unregistered}/.well-known/openid-federation`,
        },
      ],
    },
  });
  expect(issuance.status).toBe(400);
  expect((await issuance.json()).message).toContain(
    `OpenID Federation trust anchors without pinned keys: ${unregistered}`
  );

  const presentation = await apiRequest('POST', '/verifier/config', {
    id: 'unregistered-federation',
    dcql_query: {
      credentials: [
        {
          id: 'pid',
          format: 'dc+sd-jwt',
          meta: { vct_values: ['urn:eudi:pid:1'] },
          trusted_authorities: [{ type: 'openid_federation', values: [unregistered] }],
        },
      ],
    },
  });
  expect(presentation.status).toBe(400);
  expect((await presentation.json()).message).toContain(unregistered);
});

test('refuses to delete a trust anchor that configurations name', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/federation-trust-anchor/${anchorId}`);
  // The page sees the configurations, so it refuses without asking.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Delete trust anchor' }).click();

  await expect(page.getByText(/is still named by/)).toBeVisible();
  expect(dialogs).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`/federation-trust-anchor/${anchorId}$`));
  expect((await apiRequest('GET', `/federation-trust-anchor/${anchorId}`)).status).toBe(200);
});

test('refuses to change an entity ID that configurations name', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/federation-trust-anchor/${anchorId}/edit`);
  const entityIdField = page.getByLabel('Entity ID');
  await expect(entityIdField).toHaveValue(entityId);
  await entityIdField.fill('https://other-ta.example.org');
  await expect(
    page.getByRole('status').filter({ hasText: 'so the change is refused' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect(page).toHaveURL(new RegExp(`/federation-trust-anchor/${anchorId}/edit$`));
  const stored = await (await apiRequest('GET', `/federation-trust-anchor/${anchorId}`)).json();
  expect(stored.entityId).toBe(entityId);
});

test('registers a missing trust anchor in a new tab and returns to Issuer Settings', async ({
  page,
}) => {
  const otherId = 'other-federation';
  const otherEntityId = 'https://other-ta.example.org';
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Trust' }).click();
  const section = await federationSection(page);
  await section.getByRole('button', { name: 'Add Trust Anchor' }).click();
  const register = section.getByRole('link', {
    name: 'Register trust anchor for Trust Anchor 2 (opens in a new tab)',
  });
  await expect(register).toHaveAttribute('href', '/federation-trust-anchor/create?from=form');

  const [registration] = await Promise.all([page.context().waitForEvent('page'), register.click()]);
  await registration.getByRole('textbox', { name: 'ID', exact: true }).fill(otherId);
  await registration.getByRole('textbox', { name: 'Entity ID' }).fill(otherEntityId);
  // Monaco loads lazily; type again until the editor shows the keys.
  const editor = registration.locator('app-editor .monaco-editor');
  await expect(async () => {
    await editor.click();
    await registration.keyboard.press('ControlOrMeta+A');
    await registration.keyboard.insertText(JSON.stringify({ keys: [jwk] }));
    await expect(editor.locator('.view-lines')).toContainText('ta-2026', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await registration.getByRole('button', { name: 'Register Trust Anchor' }).click();

  // The registration tab says to return to the form instead of opening the trust anchor.
  const registered = registration.getByRole('heading', {
    name: `Trust anchor "${otherId}" registered`,
  });
  await expect(registered).toBeVisible();
  await expect(registered).toBeFocused();
  await expect(
    registration.getByText('Your form is still open in the tab you came from.')
  ).toBeVisible();
  await expect(registration).toHaveURL(/\/federation-trust-anchor\/create\?from=form$/);
  await expect(registration.getByRole('link', { name: 'Open trust anchor' })).toHaveAttribute(
    'href',
    `/federation-trust-anchor/${otherId}`
  );
  await registration.close();

  // The unsaved settings still have the new row, which offers the trust anchor after a reload.
  await section.getByRole('button', { name: 'Reload trust anchors for Trust Anchor 2' }).click();
  await selectOption(
    page,
    section.getByRole('combobox', { name: 'Trust Anchor 2' }),
    `${otherId} (${otherEntityId})`
  );
  await expect(section.getByRole('combobox', { name: 'Trust Anchor 2' })).toContainText(
    otherEntityId
  );
});
