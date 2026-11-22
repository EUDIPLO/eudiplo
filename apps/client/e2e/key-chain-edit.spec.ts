import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';
import { createKeyChain } from './support/key-chains';

// Edit Key Chain saves what it reports: a cleared description, the rotation of a standalone key
// chain whose rotation is on, and no out-of-range interval. The demo tenant's key chains are
// file-managed, so the test gets its own tenant.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

async function keyChain(token: string, id: string): Promise<Record<string, any>> {
  const response = await fetch(`${api}/api/key-chain/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, any>;
}

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
});

test('turns off the rotation of a standalone key chain and clears its description', async ({
  page,
}) => {
  const tenant = await createTenant('key-edit-e2e', 'Key Edit E2E', ['keys:manage']);
  const id = await createKeyChain(tenant.token, 'attestation', 'Rotating standalone key');
  // Rotation of a standalone key chain is set through the API, the CLI or an import.
  const enable = await fetch(`${api}/api/key-chain/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotationPolicy: { enabled: true, intervalDays: 30 } }),
  });
  expect(enable.ok, await enable.clone().text()).toBe(true);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/keys/${id}/edit`);
  await expect(page.getByRole('heading', { name: 'Rotation Policy' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('replaces a certificate issued by a CA');
  const save = page.getByRole('button', { name: 'Save Changes' });
  // appConfigManaged holds clicks back until its ownership lookup has answered.
  await expect(save).not.toHaveAttribute('aria-busy', 'true');

  // An interval out of range is not saved.
  await page.getByRole('spinbutton', { name: 'Rotation Interval (days)' }).fill('0');
  await save.click();
  await expect(page.getByText('Enter a whole number of days from 1 to 3650').first()).toBeVisible();
  expect((await keyChain(tenant.token, id)).rotationPolicy.intervalDays).toBe(30);

  await page.getByRole('switch', { name: 'Enable automatic key rotation' }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('');
  await save.click();
  await expect(page.getByText('Key chain updated successfully')).toBeVisible();

  const stored = await keyChain(tenant.token, id);
  expect(stored.rotationPolicy.enabled).toBe(false);
  expect(stored.description ?? '').toBe('');
});
