import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { federationSection, registerTrustAnchor } from './support/federation';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// Rows of Issuer Settings (languages, authorization servers, trust anchors) stay bound to
// their own values when a row is removed, moved or changes its type: the screen shows them,
// edits reach them and the saved settings have them. Focus moves to the row in the place of
// a removed one, or to the Add button, and to the page heading after a retried load; JSON View
// waits for the loaded settings. The demo tenant's settings are read-only, so the spec creates
// a tenant; each test stores the same settings with three rows in each list first.

test.use({ storageState: { cookies: [], origins: [] } });
// The tests share the tenant's settings, so they run one after another.
test.describe.configure({ mode: 'default' });

const anchorIds = ['ta-one', 'ta-two', 'ta-three'];
const anchorEntityId = (id: string) => `https://${id}.example.org`;
const entityConfigurationUri = (id: string) =>
  `${anchorEntityId(id)}/.well-known/openid-federation`;

let tenant: TestTenant;

const apiRequest = (method: string, path: string, body?: unknown) =>
  tenantRequest(tenant, method, path, body);

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('issuer-rows', 'Issuer Rows', ['issuance:manage']);
  // Issuer Settings only accept registered trust anchors.
  for (const id of anchorIds) await registerTrustAnchor(tenant.token, id, anchorEntityId(id));
});

test.beforeEach(async ({ page }) => {
  const stored = await apiRequest('POST', '/issuer/config', {
    display: [
      { name: 'Issuer EN', locale: 'en-US' },
      { name: 'Issuer DE', locale: 'de-DE' },
      { name: 'Issuer FR', locale: 'fr-FR' },
    ],
    authorizationServers: ['one', 'two', 'three'].map((name) => ({
      type: 'external',
      id: `as-${name}`,
      issuer: `https://as-${name}.example.com`,
      label: `AS ${name}`,
    })),
    federation: {
      trustAnchors: anchorIds.map((id) => ({
        entityId: anchorEntityId(id),
        entityConfigurationUri: entityConfigurationUri(id),
      })),
    },
  });
  expect(stored.ok, await stored.text()).toBe(true);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await expect(page.getByRole('heading', { name: 'Language 3' })).toBeVisible();
});

/** Saves the settings and returns them as stored. */
async function saveAndLoad(page: Page): Promise<any> {
  const save = page.getByRole('button', { name: 'Save settings' });
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await save.click();
  await expect(page).toHaveURL(/\/issuance-config$/);
  const response = await apiRequest('GET', '/issuer/config');
  expect(response.ok).toBe(true);
  return response.json();
}

/** The display entry "Language n" on the Identity tab. */
function language(page: Page, n: number): Locator {
  return page
    .locator('.display-entry')
    .filter({ has: page.getByRole('heading', { name: `Language ${n}`, exact: true }) });
}

test('removing a language leaves the next one in its place with its own values', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Remove language 2' }).click();

  // The next language takes the place and the focus of the removed one, with its own values.
  await expect(page.getByRole('heading', { name: 'Language 3' })).toHaveCount(0);
  const second = language(page, 2);
  await expect(second.getByRole('textbox', { name: 'Name' })).toHaveValue('Issuer FR');
  await expect(second.getByRole('combobox', { name: 'Locale' })).toHaveText(/French/);
  await expect(second.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await second.getByRole('textbox', { name: 'Name' }).fill('Émetteur');

  const saved = await saveAndLoad(page);
  expect(saved.display.map(({ name, locale }: any) => ({ name, locale }))).toEqual([
    { name: 'Issuer EN', locale: 'en-US' },
    { name: 'Émetteur', locale: 'fr-FR' },
  ]);
});

test('removing or moving an authorization server keeps each server with its values', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  await page.getByRole('button', { name: /^AS two/ }).click();
  await page
    .getByRole('region', { name: /^AS two/ })
    .getByRole('button', { name: 'Remove authorization server 2' })
    .click();

  // The next server takes the place and the focus of the removed one, with its own values.
  await expect(page.getByRole('button', { name: /^AS two/ })).toHaveCount(0);
  const header = page.getByRole('button', { name: /^AS three/ });
  await expect(header).toBeFocused();
  await page.keyboard.press('Enter');
  const server = page.getByRole('region', { name: /^AS three/ });
  await expect(server.getByRole('textbox', { name: 'ID' })).toHaveValue('as-three');
  await expect(
    server.getByRole('textbox', { name: 'External Authorization Server URL' })
  ).toHaveValue('https://as-three.example.com');
  await server.getByRole('textbox', { name: 'Label (optional)' }).fill('AS three edited');

  // Moved up, the server keeps its values and the pressed button keeps the focus. At the top the
  // button stays focusable and says why it does nothing; pressing it again changes nothing.
  const headers = page.getByRole('button', { name: /^AS (one|three)/ });
  await server.getByRole('button', { name: 'Move authorization server 2 up' }).click();
  const moveUp = server.getByRole('button', { name: 'Move authorization server 1 up' });
  await expect(moveUp).toBeFocused();
  await expect(moveUp).toHaveAttribute('aria-disabled', 'true');
  await expect(moveUp).toHaveAccessibleDescription('Authorization server 1 is already first');
  await page.keyboard.press('Enter');
  await expect(headers).toHaveText([/AS three edited/, /AS one/]);
  await expect(server.getByRole('textbox', { name: 'ID' })).toHaveValue('as-three');
  await expect(server.getByRole('textbox', { name: 'Label (optional)' })).toHaveValue(
    'AS three edited'
  );

  // Moved back down, the same holds at the bottom.
  await server.getByRole('button', { name: 'Move authorization server 1 down' }).click();
  const moveDown = server.getByRole('button', { name: 'Move authorization server 2 down' });
  await expect(moveDown).toBeFocused();
  await expect(moveDown).toHaveAttribute('aria-disabled', 'true');
  await expect(moveDown).toHaveAccessibleDescription('Authorization server 2 is already last');
  await page.keyboard.press('Enter');
  await expect(headers).toHaveText([/AS one/, /AS three edited/]);
  await expect(server.getByRole('textbox', { name: 'ID' })).toHaveValue('as-three');

  const saved = await saveAndLoad(page);
  expect(
    saved.authorizationServers.map(({ id, issuer, label }: any) => ({ id, issuer, label }))
  ).toEqual([
    { id: 'as-one', issuer: 'https://as-one.example.com', label: 'AS one' },
    { id: 'as-three', issuer: 'https://as-three.example.com', label: 'AS three edited' },
  ]);
});

test('removing the last row moves focus to the new last row, then to the Add button', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Remove language 3' }).click();
  await expect(language(page, 2).getByRole('textbox', { name: 'Name' })).toBeFocused();

  await page.getByRole('tab', { name: 'Wallet access' }).click();
  await page.getByRole('button', { name: /^AS three/ }).click();
  for (const [n, name, next] of [
    [3, 'three', 'two'],
    [2, 'two', 'one'],
  ] as const) {
    await page
      .getByRole('region', { name: new RegExp(`^AS ${name}`) })
      .getByRole('button', { name: `Remove authorization server ${n}` })
      .click();
    await expect(page.getByRole('button', { name: new RegExp(`^AS ${next}`) })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await page
    .getByRole('region', { name: /^AS one/ })
    .getByRole('button', { name: 'Remove authorization server 1' })
    .click();
  await expect(page.getByRole('button', { name: 'Add Authorization Server' })).toBeFocused();

  await page.getByRole('tab', { name: 'Trust' }).click();
  const federation = await federationSection(page);
  for (const n of [3, 2]) {
    await federation.getByRole('button', { name: `Remove trust anchor ${n}` }).click();
    await expect(federation.getByRole('combobox', { name: `Trust Anchor ${n - 1}` })).toBeFocused();
  }
  await federation.getByRole('button', { name: 'Remove trust anchor 1' }).click();
  await expect(federation.getByRole('button', { name: 'Add Trust Anchor' })).toBeFocused();
});

test('changing the type of an authorization server keeps its panel open and its edits', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  await page.getByRole('button', { name: /^AS one/ }).click();
  const server = page.getByRole('region', { name: /^AS one/ });
  const type = server.getByRole('combobox', { name: /^Type/ });

  // Each type change renders the panel for a new group, open, with the focus back on Type. Until
  // then the old panel is still there, so the test waits for content of the new type first.
  for (const [option, rendered] of [
    ['Chained', server.getByRole('textbox', { name: 'Upstream Issuer URL' })],
    ['Built-in', server.getByText('Built-in AS uses issuer-local authorization endpoints')],
  ] as const) {
    await type.click();
    await page.getByRole('option', { name: option }).click();
    await expect(rendered).toBeVisible();
    await expect(type).toHaveText(new RegExp(option));
    await expect(type).toBeFocused();
  }
  await expect(server.getByRole('textbox', { name: 'ID', exact: true })).toHaveValue('as-one');
  await server.getByRole('textbox', { name: 'Label', exact: true }).fill('AS one built-in');

  const saved = await saveAndLoad(page);
  expect(saved.authorizationServers[0]).toMatchObject({
    type: 'built-in',
    id: 'as-one',
    label: 'AS one built-in',
  });
});

test('removing a trust anchor leaves the next one in its place with its own values', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Trust' }).click();
  const federation = await federationSection(page);
  await federation.getByRole('button', { name: 'Remove trust anchor 2' }).click();

  // The next trust anchor takes the place and the focus of the removed one, with its own values.
  await expect(federation.getByRole('combobox', { name: 'Trust Anchor 3' })).toHaveCount(0);
  const anchor = federation.getByRole('combobox', { name: 'Trust Anchor 2' });
  await expect(anchor).toHaveText(new RegExp(`\\(${anchorEntityId('ta-three')}\\)`));
  const uri = federation
    .locator('.trust-anchor-entry')
    .filter({ has: page.getByRole('combobox', { name: 'Trust Anchor 2' }) })
    .getByRole('textbox', { name: 'Entity Configuration URI' });
  await expect(uri).toHaveValue(entityConfigurationUri('ta-three'));
  await expect(anchor).toBeFocused();
  await uri.fill(`${anchorEntityId('ta-three')}/federation`);

  const saved = await saveAndLoad(page);
  expect(saved.federation.trustAnchors).toEqual([
    {
      entityId: anchorEntityId('ta-one'),
      entityConfigurationUri: entityConfigurationUri('ta-one'),
    },
    {
      entityId: anchorEntityId('ta-three'),
      entityConfigurationUri: `${anchorEntityId('ta-three')}/federation`,
    },
  ]);
});

test('a retry after a failed load shows the settings and moves focus to the heading', async ({
  page,
}) => {
  // The first two loads fail, each with its own reason, so the test can tell the cards apart.
  const failures = ['Settings unavailable', 'Still unavailable'];
  await page.route(
    (url) => url.pathname === '/api/issuer/config',
    (route) => {
      const message = route.request().method() === 'GET' ? failures.shift() : undefined;
      return message
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ statusCode: 500, message }),
          })
        : route.fallback();
    }
  );
  await page.reload();

  await expect(page.getByRole('alert').filter({ hasText: 'Settings unavailable.' })).toBeVisible();
  await expect(page.getByText('Retry before making changes.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Language 1' })).toHaveCount(0);

  // JSON View edits the loaded settings: it stays focusable, says why it does nothing and opens
  // nothing until they are loaded.
  const jsonView = page.getByRole('button', { name: 'JSON View' });
  await expect(jsonView).toHaveAttribute('aria-disabled', 'true');
  await expect(jsonView).toHaveAccessibleDescription(
    'Retry loading the issuer settings before opening JSON View'
  );
  await jsonView.focus();
  await expect(jsonView).toBeFocused();
  await page.keyboard.press('Enter');
  // MatDialog attaches its container while the click runs, before the dialog role is rendered.
  await expect(page.locator('mat-dialog-container')).toHaveCount(0);

  const retry = page.getByRole('button', { name: 'Retry', exact: true });

  // A retry that fails again puts the focus on the new card's Retry; one that loads moves it to
  // the heading.
  await retry.click();
  const failedAgain = page.getByRole('alert').filter({ hasText: 'Still unavailable.' });
  await expect(failedAgain).toBeVisible();
  await expect(retry).toBeFocused();
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Language 3' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issuer Settings' })).toBeFocused();
  await expect(failedAgain).toHaveCount(0);
  await expect(jsonView).not.toHaveAttribute('aria-disabled', 'true');
  await expect(jsonView).toHaveAccessibleDescription('View/Edit as JSON');
});
