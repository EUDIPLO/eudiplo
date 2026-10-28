import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';
import { createKeyChain } from './support/key-chains';

// The default access key chain signs presentation requests of configurations without an access
// key chain and the signed issuer metadata. The demo tenant's key chains are file-managed, so
// the test gets its own tenant, whose key chain defaults the Web Client may change.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

async function defaultAccess(token: string): Promise<Record<string, string>> {
  const response = await fetch(`${api}/api/key-chain/access/default`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, string>;
}

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
});

test('sets the default access key chain, keeps it from being deleted and removes it again', async ({
  page,
}) => {
  const tenant = await createTenant('default-access-e2e', 'Default Access E2E', ['keys:manage']);
  await createKeyChain(tenant.token, 'access', 'First access key');
  const chosen = await createKeyChain(tenant.token, 'access', 'Chosen access key');
  const byRule = (await defaultAccess(tenant.token)).keyChainId;

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/keys');

  const row = page.getByRole('row', { name: /Chosen access key/ });
  const useAsDefault = row.getByRole('button', {
    name: 'Use key chain Chosen access key as default access key chain',
  });
  // The star swallows clicks while the ownership lookup of the key chain defaults runs.
  await expect(useAsDefault).not.toHaveAttribute('aria-busy', 'true');
  await useAsDefault.click();
  await expect(page.getByText('Default access key chain set')).toBeVisible();
  // The chip reads "Default", followed by its explanation for screen readers.
  await expect(row.locator('.default-chip')).toHaveText(/^Default:/);
  expect(await defaultAccess(tenant.token)).toEqual({
    defaultAccessKeyChainId: chosen,
    keyChainId: chosen,
  });

  // The page refuses it without asking, as the backend would.
  let asked = false;
  page.once('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await row.getByRole('button', { name: 'Delete key chain Chosen access key' }).click();
  await expect(
    page.getByText("This is the tenant's default access key chain. Stop using it as default")
  ).toBeVisible();
  expect(asked).toBe(false);

  await page.goto(`/keys/${chosen}`);
  const stopUsing = page.getByRole('button', {
    name: 'Stop using key chain Chosen access key as default access key chain',
  });
  await expect(stopUsing).not.toHaveAttribute('aria-busy', 'true');
  await stopUsing.click();
  await expect(
    page.getByText('Default access key chain removed; EUDIPLO picks one by rule')
  ).toBeVisible();
  expect(await defaultAccess(tenant.token)).toEqual({ keyChainId: byRule });
});
