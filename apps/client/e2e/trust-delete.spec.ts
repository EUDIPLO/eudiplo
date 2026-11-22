import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { registerTrustAnchor } from './support/federation';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';
import { createTrustList } from './support/trust-lists';

// Deleting a trust list and a federation trust anchor that no configuration references: the page
// asks first, a declined question sends nothing, and after the delete the list opens without
// it. The refusals for referenced ones are in trust-list.spec.ts and
// federation-trust-anchor.spec.ts.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // Both manage roles, so the pages see every configuration that could reference them.
  tenant = await createTenant('trust-delete', 'Trust Delete', [
    'issuance:manage',
    'presentation:manage',
    'keys:manage',
  ]);
});

/** Records the paths of the DELETE requests the page sends to `/api/<resource>/…`. */
function recordDeletes(page: Page, resource: string): string[] {
  const deleted: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' && path.startsWith(`/api/${resource}/`)) deleted.push(path);
  });
  return deleted;
}

/** Clicks a delete button, declines its question and returns the question. */
async function declineDelete(page: Page, button: string): Promise<string> {
  const asked = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name: button, exact: true }).click();
  const dialog = await asked;
  const message = dialog.message();
  await dialog.dismiss();
  await click;
  return message;
}

test('deletes a trust list that no configuration references', async ({ page }) => {
  await createTrustList(tenant.token, 'disposable-list', 'Disposable list');
  const deleted = recordDeletes(page, 'trust-list');
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/trust-list/disposable-list');
  const remove = page.getByRole('button', { name: 'Delete list', exact: true });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  await expect(remove).not.toHaveAttribute('aria-disabled', 'true');

  expect(await declineDelete(page, 'Delete list')).toMatch(
    /^Delete trust list .*disposable-list.*\? If a configuration still references it/
  );
  expect(deleted).toEqual([]);

  page.once('dialog', (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.getByText('Trust list deleted')).toBeVisible();
  await expect(page).toHaveURL(/\/trust-list$/);
  await expect(page.getByText('disposable-list', { exact: true })).toHaveCount(0);
  expect(deleted).toEqual(['/api/trust-list/disposable-list']);
  expect((await tenantRequest(tenant, 'GET', '/trust-list/disposable-list')).status).toBe(404);
});

test('deletes a federation trust anchor that no configuration names', async ({ page }) => {
  await registerTrustAnchor(tenant.token, 'disposable-ta', 'https://ta.disposable.example');
  const deleted = recordDeletes(page, 'federation-trust-anchor');
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/federation-trust-anchor/disposable-ta');
  const remove = page.getByRole('button', { name: 'Delete trust anchor', exact: true });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  // The page has checked the configurations, which name no trust anchor in a new tenant.
  await expect(page.getByText('Checking which configurations name this trust anchor')).toHaveCount(
    0
  );

  expect(await declineDelete(page, 'Delete trust anchor')).toMatch(
    /^Delete trust anchor .*disposable-ta.*\? If a configuration names its entity ID/
  );
  expect(deleted).toEqual([]);

  page.once('dialog', (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.getByText('Trust anchor deleted')).toBeVisible();
  await expect(page).toHaveURL(/\/federation-trust-anchor$/);
  expect(deleted).toEqual(['/api/federation-trust-anchor/disposable-ta']);
  expect(
    (await tenantRequest(tenant, 'GET', '/federation-trust-anchor/disposable-ta')).status
  ).toBe(404);
});
