import type { Page } from '@playwright/test';
import { expect } from './test';
import { resolvedE2EConfig } from './e2e-config';

/** Signs in on the login page's "Client ID and Secret" tab and waits for the dashboard. */
export async function loginWithClientCredentials(
  page: Page,
  clientId: string,
  clientSecret: string
): Promise<void> {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Client ID and Secret' }).click();

  await page.getByLabel('EUDIPLO Instance').fill(resolvedE2EConfig.apiBaseUrl);
  await page.getByLabel('EUDIPLO Instance').blur();

  await page.getByRole('textbox', { name: 'Client ID' }).fill(clientId);
  await page.getByRole('textbox', { name: 'Client Secret' }).fill(clientSecret);

  await page.getByRole('button', { name: 'Login with Client Credentials' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
