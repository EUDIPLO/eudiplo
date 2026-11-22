import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

// With two credential configs in a pre-authorized offer, each claim card has its own Import
// Claims JSON, which opens and writes back only that config's claims.

async function selectConfig(page: Page, credentialConfigId: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Credential Config IDs' }).fill(credentialConfigId);
  // Options read as "<id> <description>", so match the ID as the first word.
  await page.getByRole('option', { name: new RegExp(`^${credentialConfigId}(\\s|$)`) }).click();
}

test('imports claims JSON per credential config', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  await page.goto('/');
  await page.getByText('New Issuance').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await selectConfig(page, 'pid-mdoc');
  await selectConfig(page, 'pid');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('button', { name: 'Import claims JSON for pid-mdoc' })).toBeVisible();
  await page.getByRole('button', { name: 'Import claims JSON for pid', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Claims JSON: pid', exact: true })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
