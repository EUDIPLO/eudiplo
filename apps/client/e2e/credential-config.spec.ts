import { test, expect } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

test('create credential config', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  // The template's id (pid) usually exists already.
  const id = `e2e-pid-${Date.now()}`;
  await page.goto('/');

  await page.getByText('Credential Types').click();
  await page.getByRole('button').filter({ hasText: 'add' }).click();
  await page.getByRole('button', { name: 'Templates' }).click();
  await page
    .getByRole('menuitem', {
      name: 'PID (Personal Identity Document) German Personal Identity Document configuration',
    })
    .click();
  await page.getByRole('textbox', { name: 'Configuration ID' }).fill(id);
  // Guided setup: Basics, Claims, Appearance, Settings, Review
  for (let step = 0; step < 4; step++) {
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('button', { name: 'Create Configuration' }).click();
  await expect(page).toHaveURL(/\/credential-config$/);
  await expect(page.getByText(id, { exact: true })).toBeVisible();
});
