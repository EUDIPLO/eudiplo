import type { Dialog, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { createKeyChain } from './support/key-chains';
import { loginWithClientCredentials } from './support/login';
import { holdRequests } from './support/routes';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// Status lists: the capacity presets of the create form and of the default settings, a row's
// Delete, and the two ways a list in use is kept. A list counts as in use once a credential
// holds one of its entries; the list then locks its Delete, and the backend refuses a delete
// that started before the list showed it (409). Issuing a credential into a list takes a
// full wallet flow, so the in-use list and the refusal are answered by `page.route` here.

test.use({ storageState: { cookies: [], origins: [] } });

interface StatusList {
  id: string;
  capacity: number;
  usedEntries: number;
}

let tenant: TestTenant;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // A tenant per test, so a repeated test finds the lists it deletes.
  tenant = await createTenant('status-list', 'Status List', ['issuance:manage', 'keys:manage']);
  // Status lists are signed with a key chain of this usage.
  await createKeyChain(tenant.token, 'statusList', 'Status list signing');
});

async function statusLists(): Promise<StatusList[]> {
  const response = await tenantRequest(tenant, 'GET', '/status-lists');
  expect(response.status).toBe(200);
  return (await response.json()) as StatusList[];
}

async function createStatusList(): Promise<string> {
  const response = await tenantRequest(tenant, 'POST', '/status-lists', { capacity: 1000 });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as StatusList).id;
}

function deleteButton(page: Page, id: string) {
  return page.getByRole('button', { name: `Delete status list ${id}`, exact: true });
}

test('creates a status list with a capacity preset', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/status-lists/create');

  const capacity = page.getByRole('spinbutton', { name: 'Capacity' });
  const preset = (label: string) => page.getByRole('button', { name: label, exact: true });
  await preset('100K').click();
  await expect(capacity).toHaveValue('100000');
  await expect(preset('100K')).toHaveAttribute('aria-pressed', 'true');
  await expect(preset('10K')).toHaveAttribute('aria-pressed', 'false');

  // A typed value that equals a preset selects it too.
  await capacity.fill('10000');
  await expect(preset('10K')).toHaveAttribute('aria-pressed', 'true');
  await expect(preset('100K')).toHaveAttribute('aria-pressed', 'false');

  const create = page.getByRole('button', { name: 'Create Status List' });
  await expect(create).not.toHaveAttribute('aria-busy', 'true');
  await create.click();
  await expect(page.getByText('Status list created successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/status-lists$/);
  expect((await statusLists()).map(({ capacity }) => capacity)).toEqual([10000]);
});

test('fills the default capacity and TTL from presets and saves them', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/status-list-config');
  await expect(page.getByRole('heading', { level: 1, name: /Status List Default/ })).toBeVisible();

  const capacitySection = page.getByRole('region', { name: 'Status List Capacity' });
  await capacitySection.getByRole('button', { name: '50,000' }).click();
  await expect(capacitySection.getByRole('spinbutton', { name: 'List capacity' })).toHaveValue(
    '50000'
  );
  await expect(capacitySection.getByRole('button', { name: '50,000' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  const ttlSection = page.getByRole('region', { name: 'JWT Time-to-Live (TTL)' });
  await ttlSection.getByRole('button', { name: '15 min' }).click();
  await expect(ttlSection.getByRole('spinbutton', { name: 'TTL (seconds)' })).toHaveValue('900');
  await expect(ttlSection.getByRole('button', { name: '15 min' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  const save = page.getByRole('button', { name: 'Save Configuration' });
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await save.click();
  await expect(page.getByText('Status list configuration saved successfully')).toBeVisible();
  const stored = await tenantRequest(tenant, 'GET', '/status-list-config');
  expect(await stored.json()).toMatchObject({ capacity: 50000, ttl: 900 });

  // "Use default" empties the field again.
  await ttlSection.getByRole('button', { name: 'Use default' }).click();
  await expect(ttlSection.getByRole('spinbutton', { name: 'TTL (seconds)' })).toHaveValue('');
  await expect(ttlSection.getByRole('button', { name: 'Use default' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('deletes a status list from its row', async ({ page }) => {
  const kept = await createStatusList();
  const removed = await createStatusList();
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/status-lists');

  const remove = deleteButton(page, removed);
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  const held = await holdRequests(page, 'DELETE', `/status-lists/${removed}`);
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(`"${removed}"`);
    void dialog.accept();
  });
  await remove.click();
  await held.sent;
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toHaveAccessibleDescription('Deleting the status list…');
  await expect(deleteButton(page, kept)).toHaveAttribute('aria-disabled', 'true');
  held.release();

  await expect(page.getByText('Status list deleted successfully')).toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(deleteButton(page, kept)).not.toHaveAttribute('aria-disabled', 'true');
  expect((await statusLists()).map(({ id }) => id)).toEqual([kept]);
});

test('keeps a status list in use: Delete is locked and a refusal shows its reason', async ({
  page,
}) => {
  const used = await createStatusList();
  const raced = await createStatusList();
  // The first list holds the entries of two credentials.
  await page.route(
    (url) => url.pathname.endsWith('/api/status-lists'),
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const lists = (await response.json()) as StatusList[];
      await route.fulfill({
        response,
        json: lists.map((list) => (list.id === used ? { ...list, usedEntries: 2 } : list)),
      });
    }
  );
  // The other one was used after the page loaded it; the backend refuses with its reason, and
  // the list loaded again holds the entry.
  const reason = `Cannot delete status list ${raced}: 1 credentials are using it`;
  await page.route(
    (url) => url.pathname.endsWith(`/api/status-lists/${raced}`),
    async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 409,
          json: { statusCode: 409, message: reason, error: 'Conflict' },
        });
        return;
      }
      const response = await route.fetch();
      const list = (await response.json()) as StatusList;
      await route.fulfill({ response, json: { ...list, usedEntries: 1 } });
    }
  );

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/status-lists');

  const locked = deleteButton(page, used);
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(locked).toHaveAccessibleDescription('Cannot delete: entries in use');
  const asked: string[] = [];
  const recordDialog = (dialog: Dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  };
  page.on('dialog', recordDialog);
  // Playwright treats aria-disabled as disabled and would wait for it otherwise.
  await locked.click({ force: true });
  await expect(page.getByText('Cannot delete a status list that has entries in use')).toBeVisible();
  expect(asked).toEqual([]);
  page.off('dialog', recordDialog);

  page.once('dialog', (dialog) => void dialog.accept());
  const refused = deleteButton(page, raced);
  await expect(refused).not.toHaveAttribute('aria-busy', 'true');
  await refused.click();
  await expect(page.getByText(reason)).toBeVisible();
  // The row loads again and now shows the list as in use, with the focus still on its Delete.
  await expect(refused).toHaveAttribute('aria-disabled', 'true');
  await expect(refused).toHaveAccessibleDescription('Cannot delete: entries in use');
  await expect(refused).toBeFocused();
  expect((await statusLists()).map(({ id }) => id).sort()).toEqual([used, raced].sort());
});
