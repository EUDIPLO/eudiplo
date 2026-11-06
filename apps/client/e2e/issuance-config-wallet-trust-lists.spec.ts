import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';
import { certificatePem } from './support/key-chains';
import { createTrustList } from './support/trust-lists';

// Wallet provider trust lists in Issuer Settings: each entry is either a managed
// trust list of the tenant ({ trustListId }) or an external one ({ url, verifierX509Der }).
// The demo tenant's resources are read-only, so the spec creates its own tenant.

test.use({ storageState: { cookies: [], origins: [] } });
// The second test edits the settings the first one saved.
test.describe.configure({ mode: 'serial' });

const api = resolvedE2EConfig.apiBaseUrl;
const trustListId = 'wallet-providers';
const externalUrl = 'https://trust-list.example.com/wallet-providers';
const serverExternalUrl = 'https://trust-list.example.com/server-wallet-providers';
const certificateDer = certificatePem.replaceAll(/-----[^-]+-----|\s/g, '');

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('wallet-trust', 'Wallet Trust Lists', ['issuance:manage']);
  await createTrustList(tenant.token, trustListId, 'Accepted wallet providers');
});

async function selectOption(page: Page, field: Locator, option: string | RegExp) {
  await field.click();
  await page.getByRole('option', { name: option }).click();
}

/** The expansion panel of the built-in authorization server on the Wallet access tab. */
function builtInServer(page: Page): Locator {
  return page
    .locator('mat-expansion-panel')
    .filter({ has: page.getByText('Built-in Authorization Server', { exact: true }) });
}

/** Opens the built-in server's panel and turns its shared wallet provider trust lists off. */
async function useOwnTrustLists(page: Page): Promise<Locator> {
  const server = builtInServer(page);
  const header = server.locator('mat-expansion-panel-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const inherit = server.getByRole('switch', { name: 'Use shared wallet provider trust lists' });
  if ((await inherit.getAttribute('aria-checked')) === 'true') await inherit.click();
  await expect(inherit).not.toBeChecked();
  return server;
}

/** Adds a managed entry for the spec's trust list and an external entry with `url`. */
async function addBothEntries(page: Page, scope: Locator, url: string) {
  await scope.getByRole('button', { name: 'Add managed trust list' }).click();
  await selectOption(
    page,
    scope.getByRole('combobox', { name: 'Managed trust list 1' }),
    new RegExp(`\\(${trustListId}\\)`)
  );
  await scope.getByRole('button', { name: 'Add external trust list' }).click();
  await scope.getByRole('textbox', { name: 'Trust list URL 2' }).fill(url);
  await scope.getByRole('textbox', { name: 'Trust list signer certificate' }).fill(certificatePem);
}

/** Asserts entry 1 is managed with the spec's list and entry 2 external with `url`. */
async function expectBothEntries(scope: Locator, url: string) {
  await expect(scope.getByRole('combobox', { name: 'Managed trust list 1' })).toHaveText(
    new RegExp(`\\(${trustListId}\\)`)
  );
  await expect(scope.getByRole('textbox', { name: 'Trust list URL 1' })).toHaveCount(0);
  await expect(scope.getByRole('combobox', { name: 'Managed trust list 2' })).toHaveCount(0);
  await expect(scope.getByRole('textbox', { name: 'Trust list URL 2' })).toHaveValue(url);
  await expect(scope.getByRole('textbox', { name: 'Trust list signer certificate' })).toHaveValue(
    certificateDer
  );
}

/** The Wallet Provider Trust and Defaults section on the Trust tab, opened. */
async function sharedTrustLists(page: Page): Promise<Locator> {
  const section = page
    .locator('mat-expansion-panel')
    .filter({ has: page.getByText('Wallet Provider Trust and Defaults', { exact: true }) });
  const header = section.locator('mat-expansion-panel-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  return section;
}

/** The tenant's stored issuer settings. */
async function savedConfig() {
  const response = await fetch(`${api}/api/issuer/config`, {
    headers: { Authorization: `Bearer ${tenant.token}` },
  });
  expect(response.ok).toBe(true);
  return response.json();
}

/** Stores `config` as the tenant's issuer settings. */
async function storeConfig(config: unknown) {
  const response = await tenantRequest(tenant, 'POST', '/issuer/config', config);
  expect(response.ok, await response.text()).toBe(true);
}

/** The external entry the authorization servers of `twoServerConfig` share. */
const serverExternal = { url: serverExternalUrl, verifierX509Der: certificateDer };

/**
 * Issuer settings with two authorization servers that have their own lists, both with a managed
 * entry, so the Wallet access tab holds two lists whose focus targets must not mix.
 */
const twoServerConfig = {
  display: [{ name: 'Wallet Trust Lists', locale: 'en-US' }],
  walletProviderTrustLists: [
    { url: externalUrl, verifierX509Der: certificateDer },
    { trustListId },
  ],
  authorizationServers: [
    {
      type: 'built-in',
      id: 'issuer-built-in',
      walletProviderTrustLists: [{ trustListId }, serverExternal],
    },
    {
      type: 'chained',
      id: 'upstream-login',
      label: 'Chained AS',
      upstream: { issuer: 'https://auth.example.com/realms/test', clientId: 'test-client' },
      walletProviderTrustLists: [serverExternal, { trustListId }],
    },
  ],
};

/** Opens the panel of the chained authorization server of `twoServerConfig`. */
async function chainedServer(page: Page): Promise<Locator> {
  // The panels open one at a time; the closed one keeps its entries on the page.
  await page.getByRole('button', { name: /^Chained AS/ }).click();
  return page.getByRole('region', { name: /^Chained AS/ });
}

/** The built-in authorization server of stored issuer settings. */
function storedBuiltInServer(config: { authorizationServers: { type: string }[] }): any {
  return config.authorizationServers.find((entry) => entry.type === 'built-in');
}

test('keeps managed and external wallet provider trust lists after a reload', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');

  // The new tenant has no identity yet, so the guided setup opens.
  await expect(page.getByText('Step 1 of 4 · Identity')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Wallet Trust Lists');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Wallet access')).toBeVisible();

  const server = await useOwnTrustLists(page);
  await addBothEntries(page, server, serverExternalUrl);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Trust')).toBeVisible();
  await addBothEntries(page, await sharedTrustLists(page), externalUrl);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Review')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page).toHaveURL(/\/issuance-config$/);

  // The API stores each entry in its mode.
  const config = await savedConfig();
  expect(config.walletProviderTrustLists).toEqual([
    { trustListId },
    { url: externalUrl, verifierX509Der: certificateDer },
  ]);
  expect(storedBuiltInServer(config).walletProviderTrustLists).toEqual([
    { trustListId },
    { url: serverExternalUrl, verifierX509Der: certificateDer },
  ]);

  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  await expectBothEntries(await useOwnTrustLists(page), serverExternalUrl);

  await page.getByRole('tab', { name: 'Trust' }).click();
  await expectBothEntries(await sharedTrustLists(page), externalUrl);
});

test('shows a retryable alert when the trust lists do not load', async ({ page }) => {
  // The reason the trust lists fail with, which tells the alerts apart; without one they load.
  let failure: string | undefined = 'Trust lists unavailable';
  await page.route(
    (url) => url.pathname === '/api/trust-list',
    (route) =>
      failure && route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ statusCode: 500, message: failure }),
          })
        : route.fallback()
  );

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  const server = await useOwnTrustLists(page);

  // The stored entry stays visible with a note while the lists are missing.
  await expect(server.getByRole('combobox', { name: 'Managed trust list 1' })).toHaveText(
    `${trustListId} (lists not loaded)`
  );
  const alert = server.getByRole('alert');
  await expect(alert).toContainText('Trust lists unavailable.');
  await expect(alert).toContainText(
    'Selected lists are kept; retry or add an external trust list.'
  );

  // Saving while the lists are missing keeps the stored reference.
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page).toHaveURL(/\/issuance-config$/);
  expect(storedBuiltInServer(await savedConfig()).walletProviderTrustLists).toEqual([
    { trustListId },
    { url: serverExternalUrl, verifierX509Der: certificateDer },
  ]);

  // Every list with a managed entry shows the alert. A retry removes the pressed Retry, so focus
  // moves within its own list: on the Trust tab to the shared lists' managed entry once the
  // lists load.
  await storeConfig(twoServerConfig);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Trust' }).click();
  const shared = await sharedTrustLists(page);
  const sharedRetry = shared.getByRole('alert').getByRole('button', { name: 'Retry' });
  await expect(sharedRetry).toBeVisible();
  failure = undefined;
  await sharedRetry.click();
  await expect(shared.getByRole('alert')).toHaveCount(0);
  await expect(shared.getByRole('combobox', { name: 'Managed trust list 2' })).toBeFocused();

  // Two servers share the Wallet access tab, so there the targets come from the chained server's
  // own list: its new Retry when the load fails again, its managed entry when the lists load.
  failure = 'Trust lists unavailable';
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  const chained = await chainedServer(page);
  const retry = chained.getByRole('alert').getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();

  failure = 'Still unavailable';
  await retry.click();
  await expect(chained.getByRole('alert')).toContainText('Still unavailable.');
  await expect(retry).toBeFocused();

  failure = undefined;
  await retry.click();
  await expect(chained.getByRole('alert')).toHaveCount(0);
  const managed = chained.getByRole('combobox', { name: 'Managed trust list 2' });
  await expect(managed).toHaveText(new RegExp(`\\(${trustListId}\\)`));
  await expect(managed).toBeFocused();
});

test('removing a trust list entry moves focus within its own list', async ({ page }) => {
  // Two authorization servers with their own lists share the Wallet access tab, so the focus
  // targets of one list must not come from the other.
  await storeConfig(twoServerConfig);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  const chained = await chainedServer(page);

  // The entry now in the place of the removed one takes the focus, then the list's Add button.
  await chained.getByRole('button', { name: 'Remove trust list 1' }).click();
  await expect(chained.getByRole('combobox', { name: 'Managed trust list 1' })).toBeFocused();
  await chained.getByRole('button', { name: 'Remove trust list 1' }).click();
  await expect(chained.getByRole('button', { name: 'Add managed trust list' })).toBeFocused();

  // After the last entry, the new last entry of the same list takes the focus.
  const builtIn = await useOwnTrustLists(page);
  await builtIn.getByRole('button', { name: 'Remove trust list 2' }).click();
  await expect(builtIn.getByRole('combobox', { name: 'Managed trust list 1' })).toBeFocused();

  await page.getByRole('tab', { name: 'Trust' }).click();
  const shared = await sharedTrustLists(page);
  await shared.getByRole('button', { name: 'Remove trust list 1' }).click();
  await expect(shared.getByRole('combobox', { name: 'Managed trust list 1' })).toBeFocused();
  await shared.getByRole('button', { name: 'Remove trust list 1' }).click();
  await expect(shared.getByRole('button', { name: 'Add managed trust list' })).toBeFocused();
});
