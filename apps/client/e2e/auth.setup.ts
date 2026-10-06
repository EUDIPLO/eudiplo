import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';

const authStatePath = 'playwright/.auth/user.json';

test('authenticate and persist storage state', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to enable authenticated tenant e2e state.'
  );

  await page.goto('/login');
  await page.getByRole('tab', { name: 'Client ID and Secret' }).click();

  await page.getByLabel('EUDIPLO Instance').fill(resolvedE2EConfig.apiBaseUrl);
  await page.getByLabel('EUDIPLO Instance').blur();

  await page.getByRole('textbox', { name: 'Client ID' }).fill(resolvedE2EConfig.clientId);
  await page.getByRole('textbox', { name: 'Client Secret' }).fill(resolvedE2EConfig.clientSecret);

  await page.getByRole('button', { name: 'Login with Client Credentials' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await mkdir(dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
