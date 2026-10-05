import { test, expect, type Page } from '@playwright/test';
import { hasAuthCredentials } from './support/e2e-config';

// Walks the first two steps of the offer wizard for one credential config.
async function startOffer(page: Page, credentialConfigId: string, flow?: RegExp): Promise<void> {
  await page.goto('/');
  await page.getByText('New Issuance').click();
  if (flow) {
    await page.getByRole('radio', { name: flow }).check();
  }
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Credential Configuration IDs' }).click();
  await page.getByRole('option', { name: credentialConfigId, exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();
}

test('create pre authorized offer', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  await startOffer(page, 'pid-mdoc');
  await page.getByRole('button', { name: 'Use Pre-configured Default Values' }).click();
  await page.getByRole('button', { name: 'Generate Offer' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  await expect(page.getByText('Issuance Offer QR Code')).toBeVisible();
});

test('create pre authorized offer with array claims from defaults', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  // Known bug: the default values are patched into the claims form, which
  // leaves the empty nationalities array required and the form invalid, so
  // Generate Offer does nothing. Remove this line once that is fixed.
  test.fail();
  await startOffer(page, 'pid');
  await page.getByRole('button', { name: 'Use Pre-configured Default Values' }).click();
  await page.getByRole('button', { name: 'Generate Offer' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
});

// Needs an external authorization server in the issuer settings; the
// E2E_USE_BUILD backend adds "E2E external AS" (e2e/support/start-backend.mjs).
test('create authorized offer', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  await startOffer(page, 'pid', /Authorization Code \(External AS\)/);
  await page.getByRole('combobox', { name: 'Authorization Server' }).click();
  await page.getByRole('option', { name: 'E2E external AS' }).click();
  await page.getByRole('combobox', { name: 'Attribute Provider' }).click();
  await page.getByRole('option', { name: 'claims-provider' }).click();
  await page.getByRole('button', { name: 'Generate Offer' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  await expect(page.getByText('Issuance Offer QR Code')).toBeVisible();
});
