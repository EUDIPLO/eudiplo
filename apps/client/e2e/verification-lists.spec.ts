import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { holdRequests } from './support/routes';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// The lists of presentation configs and OIDC clients: the search with its count and no-match
// row, and a row's Delete with its confirmation, its busy state and the row leaving the list.
// The names of the actions are matched loosely where only the noun of a presentation config
// may change.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

/** A presentation config that asks for one claim of a PID. */
function presentationConfig(id: string, description: string) {
  return {
    id,
    description,
    dcql_query: {
      credentials: [
        {
          id: 'pid',
          format: 'dc+sd-jwt',
          meta: { vct_values: ['urn:eudi:pid:de:1'] },
          claims: [{ path: ['given_name'] }],
          trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'pid-providers' }] }],
        },
      ],
    },
  };
}

async function create(path: string, body: unknown): Promise<void> {
  const response = await tenantRequest(tenant, 'POST', path, body);
  expect(response.status, await response.clone().text()).toBe(201);
}

/** The table row whose link has this name. */
function row(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

/** The names of the row links, in the order of the list. */
function rowLinks(page: Page): Locator {
  return page.getByRole('table').getByRole('link');
}

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // A tenant per test, so a repeated test finds the items it deletes.
  tenant = await createTenant('verification-lists', 'Verification Lists', ['presentation:manage']);
  await create('/verifier/config', presentationConfig('pid-login', 'PID sign-in'));
});

test('searches the presentation configs and deletes one from its row', async ({ page }) => {
  await create('/verifier/config', presentationConfig('age-check', 'Age over 18'));
  await create('/verifier/config', presentationConfig('address-check', 'Home address'));
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/presentation-config');
  await expect(rowLinks(page)).toHaveCount(3);
  await expect(page.getByText(/^\s*3 \w+\s*$/)).toBeVisible();

  // The search looks in IDs and descriptions.
  const search = page.getByRole('searchbox', { name: /^Search/ });
  await search.fill('home');
  await expect(rowLinks(page)).toHaveText(['address-check']);
  await expect(page.getByText(/^\s*1 of 3 \w+\s*$/)).toBeVisible();

  await search.fill('no-such-config');
  const noMatch = page.getByRole('cell', { name: /matches "no-such-config"/ });
  await expect(noMatch).toBeVisible();
  await expect(rowLinks(page)).toHaveCount(0);
  await expect(page.getByText(/^\s*0 of 3 \w+\s*$/)).toBeVisible();
  await noMatch.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(rowLinks(page)).toHaveCount(3);

  // Dismissing the confirmation keeps the config.
  const remove = row(page, 'address-check').getByRole('button', { name: /^Delete / });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await remove.click();
  await expect(rowLinks(page)).toHaveCount(3);

  // While the delete runs, its row says so and no other row's Delete starts another one.
  const held = await holdRequests(page, 'DELETE', '/verifier/config/address-check');
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('"address-check"');
    void dialog.accept();
  });
  await remove.click();
  await held.sent;
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toHaveAccessibleDescription(/^Deleting/);
  const other = row(page, 'age-check').getByRole('button', { name: /^Delete / });
  await expect(other).toHaveAttribute('aria-disabled', 'true');
  await expect(other).toHaveAccessibleDescription('Wait until the other delete has finished');
  held.release();

  await expect(row(page, 'address-check')).toHaveCount(0);
  await expect(rowLinks(page)).toHaveText(['age-check', 'pid-login']);
  await expect(page.getByText(/^\s*2 \w+\s*$/)).toBeVisible();
  await expect(other).not.toHaveAttribute('aria-disabled', 'true');
  const stored = (await (await tenantRequest(tenant, 'GET', '/verifier/config')).json()) as {
    id: string;
  }[];
  expect(stored.map(({ id }) => id).sort()).toEqual(['age-check', 'pid-login']);
});

test('searches the OIDC clients and deletes one from its row', async ({ page }) => {
  for (const [name, scope] of [
    ['Customer Portal', 'customer'],
    ['Partner Portal', 'partner'],
    ['Shop', 'checkout'],
  ]) {
    await create('/verifier/oidc-clients', {
      name,
      redirectUris: ['https://portal.example/cb'],
      scopes: [{ scope, presentationConfigId: 'pid-login' }],
    });
  }
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/oidc-clients');
  await expect(rowLinks(page)).toHaveText(['Customer Portal', 'Partner Portal', 'Shop']);
  await expect(page.getByText(/^\s*3 clients\s*$/)).toBeVisible();

  // The search looks in names, client IDs and scopes.
  const search = page.getByRole('searchbox', { name: /^Search clients/ });
  await search.fill('checkout');
  await expect(rowLinks(page)).toHaveText(['Shop']);
  await search.fill('portal');
  await expect(rowLinks(page)).toHaveText(['Customer Portal', 'Partner Portal']);
  await expect(page.getByText(/^\s*2 of 3 clients\s*$/)).toBeVisible();

  await search.fill('kiosk');
  const noMatch = page.getByRole('cell', { name: 'No client matches "kiosk".' });
  await expect(noMatch).toBeVisible();
  await expect(page.getByText(/^\s*0 of 3 clients\s*$/)).toBeVisible();
  await noMatch.getByRole('button', { name: 'Clear search' }).click();
  await expect(rowLinks(page)).toHaveCount(3);

  const remove = page.getByRole('button', { name: 'Delete OIDC client Partner Portal' });
  const clientId = (await row(page, 'Partner Portal').getByRole('code').textContent())?.trim();
  expect(clientId, 'client ID in the row').toBeTruthy();
  const held = await holdRequests(page, 'DELETE', `/verifier/oidc-clients/${clientId}`);
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('"Partner Portal"');
    void dialog.accept();
  });
  await remove.click();
  await held.sent;
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toHaveAccessibleDescription('Deleting the OIDC client…');
  await expect(page.getByRole('button', { name: 'Delete OIDC client Shop' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  held.release();

  await expect(page.getByText('OIDC client deleted')).toBeVisible();
  await expect(rowLinks(page)).toHaveText(['Customer Portal', 'Shop']);
  await expect(page.getByText(/^\s*2 clients\s*$/)).toBeVisible();
  // Focus moves to the row now in the deleted one's place.
  await expect(page.getByRole('link', { name: 'Shop', exact: true })).toBeFocused();
});
