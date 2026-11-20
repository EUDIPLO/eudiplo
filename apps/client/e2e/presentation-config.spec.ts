import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';

test('presentation config list is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/presentation-config');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/presentation-config(\/.*)?$/);
});

test('presentation config create page is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/presentation-config/create');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/presentation-config\/create$/);
  await expect(page.getByRole('heading', { name: 'Create Verification Config' })).toBeVisible();
});

test('a file-managed presentation config is locked for a client without tenant:admin', async ({
  page,
}) => {
  // Build mode imports the demo tenant from files and signs in with its
  // test-client, which has the manage roles but not tenant:admin.
  test.skip(!resolvedE2EConfig.useBuild, 'Needs the demo tenant and test-client (E2E_USE_BUILD).');

  await page.goto('/presentation-config/pid');
  await expect(page.getByText('Managed by a configuration bundle')).toBeVisible();
  await expect(page.getByText('ask someone with the tenant:admin role')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View ownership' })).toHaveCount(0);
  const managedActions = page.locator('button[appconfigmanaged]');
  await expect(managedActions).toHaveCount(2);
  for (const action of await managedActions.all()) {
    await expect(action).toHaveAttribute('aria-disabled', 'true');
  }

  await page.goto('/presentation-config/pid/edit');
  await expect(page.getByText('Managed by a configuration bundle')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Changes' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
});

test('a locked action on the list says why and lets no click or key through', async ({ page }) => {
  test.skip(!resolvedE2EConfig.useBuild, 'Needs the demo tenant and test-client (E2E_USE_BUILD).');

  await page.goto('/presentation-config');
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'pid', exact: true }) });
  // The ID links to the configuration; Edit is the next stop in the row.
  const view = row.getByRole('link', { name: 'pid', exact: true });
  // The list names each action after its configuration.
  const edit = row.getByRole('button', { name: 'Edit verification config pid' });
  const tooltip = page.locator('.mat-mdc-tooltip');
  await expect(edit).toHaveAttribute('aria-disabled', 'true');
  await expect(edit).toHaveAccessibleDescription(
    /^Edit verification config\. Managed by .+, read-only$/
  );

  /** Whether the edit page opens within a moment of `action`. */
  async function opensEditPage(action: () => Promise<void>): Promise<boolean> {
    const navigated = page.waitForURL(/\/edit$/, { timeout: 2_000 }).then(
      () => true,
      () => false
    );
    await action();
    return navigated;
  }

  // Keyboard users reach the locked action, see why, and cannot trigger it.
  await view.focus();
  await page.keyboard.press('Tab');
  await expect(edit).toBeFocused();
  await expect(tooltip).toContainText('Managed by');
  expect(
    await opensEditPage(async () => {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
    })
  ).toBe(false);

  // Mouse users get the tooltip on hover; the click stops at the button.
  await edit.blur();
  await expect(tooltip).toBeHidden();
  await edit.hover();
  await expect(tooltip).toContainText('Edit verification config. Managed by');
  // Playwright treats aria-disabled as disabled and would wait for it otherwise.
  expect(await opensEditPage(() => edit.click({ force: true }))).toBe(false);
});

test('Import from Credential Config fills the query from a credential config of the tenant', async ({
  page,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  // Build mode imports the demo tenant, whose credential config "pid" issues
  // the SD-JWT VC type urn:eudi:pid:de:1.
  test.skip(!resolvedE2EConfig.useBuild, 'Needs the demo tenant of build mode.');

  await page.goto('/presentation-config/create');
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('import-from-config');
  await page
    .getByRole('textbox', { name: 'Description' })
    .fill('Imported from a credential config');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Import from Credential Config' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Import from Credential Config' })
  ).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);

  await dialog.getByRole('checkbox', { name: 'Use PID (pid)' }).check();
  await dialog.getByRole('button', { name: 'Insert DCQL' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('combobox', { name: 'Credential type (VCT)' })).toHaveValue(
    'urn:eudi:pid:de:1'
  );
});
