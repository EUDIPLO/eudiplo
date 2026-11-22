import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// The Tenant KMS Configuration editor saves before it closes, so a rejected configuration stays
// in the editor, and "Use global configuration" deletes the tenant providers after asking. The
// test gets its own tenant, whose KMS configuration the Web Client may change.

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
});

test('keeps a rejected tenant KMS configuration in the editor and resets to the global one', async ({
  page,
}) => {
  const tenant = await createTenant('tenant-kms-e2e', 'Tenant KMS E2E', [
    'tenant:admin',
    'keys:manage',
  ]);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/kms');
  const card = page.locator('.tenant-config');
  await expect(card.getByText('Global configuration', { exact: true })).toBeVisible();

  const show = page.getByRole('button', { name: 'Show tenant config JSON' });
  // appConfigManaged holds clicks back until its ownership lookup has answered.
  await expect(show).not.toHaveAttribute('aria-busy', 'true');
  await show.click();
  const dialog = page.getByRole('dialog');
  // Monaco loads lazily; type again until the editor holds the edit alone. The stored
  // configuration is selected with Monaco's own cursor keys, since headless Chromium on macOS does
  // not run the native select-all that Monaco uses for Cmd+A, and deleted before typing, since
  // Monaco auto-closes brackets typed over a selection.
  const editor = dialog.locator('app-editor .monaco-editor');
  const edited = JSON.stringify({ providers: [{ id: 'tenant-db', type: 'db' }] });
  await expect(async () => {
    await editor.click();
    for (const key of ['PageUp', 'Home', 'Shift+PageDown', 'Shift+End', 'Backspace']) {
      await page.keyboard.press(key);
    }
    await page.keyboard.insertText(edited);
    await expect(editor.locator('.view-lines')).toHaveText(edited, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // The backend rejects the first save: the dialog stays open with the edit.
  let rejected = false;
  await page.route('**/api/key-chain/providers/config', async (route) => {
    if (route.request().method() !== 'PUT' || rejected) return route.fallback();
    rejected = true;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 400, message: 'The KMS provider is not reachable.' }),
    });
  });
  await dialog.getByRole('button', { name: 'Apply Changes' }).click();
  await expect(
    page.getByText('Failed to save tenant KMS configuration: The KMS provider is not reachable.')
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(editor.locator('.view-lines')).toContainText('tenant-db');

  // Applying again saves it and closes the dialog.
  await dialog.getByRole('button', { name: 'Apply Changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Tenant KMS configuration saved')).toBeVisible();
  await expect(card.getByText('Tenant providers set', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'KMS providers' }).getByText('tenant-db', { exact: true })
  ).toBeVisible();

  // Declining keeps the tenant providers; confirming returns to the global configuration.
  const reset = card.getByRole('button', { name: 'Use global configuration' });
  await expect(reset).not.toHaveAttribute('aria-busy', 'true');
  const declined = new Promise<string>((resolve) =>
    page.once('dialog', (question) => {
      const message = question.message();
      void question.dismiss().then(() => resolve(message));
    })
  );
  await reset.click();
  expect(await declined).toContain(
    'Delete the tenant KMS configuration and use the global configuration?'
  );
  await expect(card.getByText('Tenant providers set', { exact: true })).toBeVisible();

  page.once('dialog', (question) => void question.accept());
  await reset.click();
  await expect(page.getByText('Tenant KMS configuration reset to global defaults')).toBeVisible();
  await expect(card.getByText('Global configuration', { exact: true })).toBeVisible();
  await expect(reset).toHaveCount(0);
});
