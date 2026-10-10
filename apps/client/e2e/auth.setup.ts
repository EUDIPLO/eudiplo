import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

const authStatePath = 'playwright/.auth/user.json';

test('authenticate and persist storage state', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to enable authenticated tenant e2e state.'
  );

  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.clientId!,
    resolvedE2EConfig.clientSecret!
  );

  await mkdir(dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
