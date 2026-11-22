import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { createKeyChain } from './support/key-chains';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// Edit Status List: a list bound to a credential config and pinned to a key chain is set back
// to Shared and Default, saved and opened again. The backend removes a binding only when the
// form sends it as null, so the reopened form and the stored list must both show it removed.

test.use({ storageState: { cookies: [], origins: [] } });

interface StatusList {
  id: string;
  credentialConfigurationId?: string | null;
  keyChainId?: string | null;
}

let tenant: TestTenant;
let listId: string;
let keyChainId: string;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('status-binding', 'Status List Binding', [
    'issuance:manage',
    'keys:manage',
  ]);
  keyChainId = await createKeyChain(tenant.token, 'statusList', 'Pinned status list keys');
  const config = await tenantRequest(tenant, 'POST', '/issuer/credentials', {
    id: 'membership',
    description: 'Bound to the status list',
    vct: 'urn:example:membership',
    config: { format: 'dc+sd-jwt', display: [] },
    fields: [],
  });
  expect(config.status, await config.clone().text()).toBe(201);
  const created = await tenantRequest(tenant, 'POST', '/status-lists', {
    capacity: 1000,
    credentialConfigurationId: 'membership',
    keyChainId,
  });
  expect(created.status, await created.clone().text()).toBe(201);
  listId = ((await created.json()) as StatusList).id;
});

async function storedList(): Promise<StatusList> {
  const response = await tenantRequest(tenant, 'GET', `/status-lists/${listId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as StatusList;
}

/** What the select of a form control shows. */
function select(page: Page, label: string) {
  return page.getByRole('combobox', { name: label });
}

test('unbinds a status list to Shared and Default, saves and shows that when reopened', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/status-lists/${listId}`);
  await expect(page.getByRole('heading', { name: 'Edit Status List' })).toBeVisible();
  await expect(select(page, 'Credential Config')).toContainText('membership');
  await expect(select(page, 'Key Chain')).toContainText(keyChainId);

  await select(page, 'Credential Config').click();
  await page.getByRole('option', { name: 'Shared (no binding)' }).click();
  await select(page, 'Key Chain').click();
  await page.getByRole('option', { name: 'Default (auto-managed)' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  const save = page.getByRole('button', { name: 'Save Changes' });
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  const update = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith(`/status-lists/${listId}`)
  );
  await save.click();
  // Shared and Default are sent as null, which removes the bindings.
  expect((await update).postDataJSON()).toEqual({
    credentialConfigurationId: null,
    keyChainId: null,
  });
  await expect(page.getByText('Status list updated successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/status-lists$/);

  const stored = await storedList();
  expect(stored.credentialConfigurationId ?? null).toBeNull();
  expect(stored.keyChainId ?? null).toBeNull();

  // Reopened, the form holds neither binding. Material shows an option with a null value
  // ("Shared", "Default") as an empty select, so the test checks that the old values are gone.
  await page.goto(`/status-lists/${listId}`);
  await expect(page.getByText('No changes')).toBeVisible();
  await expect(select(page, 'Credential Config')).not.toContainText('membership');
  await expect(select(page, 'Key Chain')).not.toContainText(keyChainId);
});
