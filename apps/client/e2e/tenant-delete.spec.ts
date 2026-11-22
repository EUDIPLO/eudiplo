import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// Deleting a tenant asks for its ID, since names are not unique: two tenants here share one.

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create and delete tenants.');
});

test('deletes a tenant only once its ID is typed, not its shared name', async ({ page }) => {
  const name = 'Tenant Delete E2E';
  const doomed = await createTenant('tenant-delete-e2e', name, ['clients:manage']);
  const kept = await createTenant('tenant-delete-e2e', name, ['clients:manage']);

  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.rootClientId!,
    resolvedE2EConfig.rootClientSecret!
  );
  await page.goto('/tenants');
  await page.getByRole('searchbox').fill('tenant-delete-e2e');
  const row = (id: string) => page.getByRole('row').filter({ hasText: id });
  await expect(row(doomed.id)).toBeVisible();
  await expect(row(kept.id)).toBeVisible();

  async function deleteTyping(answer: string): Promise<string> {
    const asked = new Promise<string>((resolve) =>
      page.once('dialog', (dialog) => {
        const message = dialog.message();
        void dialog.accept(answer).then(() => resolve(message));
      })
    );
    await page.getByRole('button', { name: `Actions for tenant ${doomed.id}` }).click();
    await page.getByRole('menuitem', { name: 'Delete tenant' }).click();
    return asked;
  }

  // The shared name does not delete it.
  const question = await deleteTyping(name);
  expect(question).toContain(`Delete tenant "${name}" (${doomed.id}) and all its data?`);
  expect(question).toContain(`Type the tenant ID "${doomed.id}" to confirm.`);
  await expect(
    page.getByText(`The ID you typed is not "${doomed.id}". The tenant was not deleted.`)
  ).toBeVisible();
  await expect(row(doomed.id)).toBeVisible();

  // Its ID does, and only this tenant goes.
  await deleteTyping(doomed.id);
  await expect(page.getByText('Tenant deleted successfully')).toBeVisible();
  await expect(row(doomed.id)).toHaveCount(0);
  await expect(row(kept.id)).toBeVisible();
});
