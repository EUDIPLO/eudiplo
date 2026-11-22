import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { createKeyChain } from './support/key-chains';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// Deleting a key chain that no configuration names, from its row and from its page: each asks
// first, a declined question sends nothing, and the key chain is gone afterwards. The refusal for
// the default access key chain is in default-access-key-chain.spec.ts.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('key-delete', 'Key Chain Delete', ['keys:manage']);
});

/** Records the key chains the page deletes. */
function recordDeletes(page: Page): string[] {
  const deleted: string[] = [];
  page.on('request', (request) => {
    const match = /\/api\/key-chain\/([^/]+)$/.exec(new URL(request.url()).pathname);
    if (request.method() === 'DELETE' && match) deleted.push(decodeURIComponent(match[1]));
  });
  return deleted;
}

async function keyChainExists(id: string): Promise<boolean> {
  return (await tenantRequest(tenant, 'GET', `/key-chain/${id}`)).ok;
}

test('deletes a key chain from its row after asking', async ({ page }) => {
  const id = await createKeyChain(tenant.token, 'attestation', 'Disposable signing');
  const deleted = recordDeletes(page);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/keys');
  const remove = page.getByRole('button', { name: 'Delete key chain Disposable signing' });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');

  const declined = page.waitForEvent('dialog');
  const firstClick = remove.click();
  const question = await declined;
  expect(question.message()).toContain(`Delete key chain "Disposable signing" (${id})?`);
  await question.dismiss();
  await firstClick;
  expect(deleted).toEqual([]);

  page.once('dialog', (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.getByText('Key chain deleted')).toBeVisible();
  await expect(remove).toHaveCount(0);
  expect(deleted).toEqual([id]);
  expect(await keyChainExists(id)).toBe(false);
});

test('deletes a key chain from its page and returns to the list', async ({ page }) => {
  const id = await createKeyChain(tenant.token, 'statusList', 'Disposable status keys');
  const deleted = recordDeletes(page);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/keys/${id}`);
  const remove = page.getByRole('button', { name: 'Delete key chain', exact: true });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(`Delete key chain "Disposable status keys" (${id})?`);
    void dialog.accept();
  });
  await remove.click();
  await expect(page.getByText('Key chain deleted successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/keys$/);
  expect(deleted).toEqual([id]);
  expect(await keyChainExists(id)).toBe(false);
});
