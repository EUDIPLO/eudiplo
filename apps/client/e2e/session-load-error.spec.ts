import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

// A session that cannot be loaded keeps its page with the reason and a Retry, instead of
// sending the user back to the list.

test('shows why a session did not load and offers Retry and the way back', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/session-management/e2e-missing-session');

  await expect(page).toHaveURL(/\/session-management\/e2e-missing-session$/);
  await expect(page.locator('app-load-error').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Sessions' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(page).toHaveURL(/\/session-management$/);
});
