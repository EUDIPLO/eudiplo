import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

// Tenant create with the default roles of its admin client, then signing in as that client;
// tenant create without an admin client; and tenant edit. Creating with chosen roles is part of
// cookbook.spec.ts, deleting is in tenant-delete.spec.ts.

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create tenants.');
  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.rootClientId!,
    resolvedE2EConfig.rootClientSecret!
  );
});

/** Fills ID and name of a new tenant; returns the ID. */
async function startTenant(page: Page, prefix: string, name: string): Promise<string> {
  const id = `${prefix}-${randomBytes(4).toString('hex')}`;
  await page.goto('/tenants/create');
  await page.getByRole('textbox', { name: 'tenant ID' }).fill(id);
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  return id;
}

test('creates a tenant with the default admin client roles and signs in as that client', async ({
  page,
}) => {
  const id = await startTenant(page, 'default-roles', 'Default Roles');
  // tenant:admin lets the admin client set the tenant up; clients:manage is always added.
  await expect(page.getByRole('combobox', { name: 'Client Roles' })).toContainText('tenant:admin');
  await page.getByRole('button', { name: 'Create tenant' }).click();

  const dialog = page.getByRole('dialog', { name: 'Client Secret Generated' });
  await expect(dialog.getByText(`${id}-admin`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Login as this Client' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText(`Client ID: ${id}-admin`)).toBeVisible();
  await page.keyboard.press('Escape');
  // tenant:admin opens the tenant's administration.
  const nav = page.locator('mat-sidenav');
  await expect(nav.getByText('API Clients', { exact: true })).toBeVisible();
  await expect(nav.getByText('Config Portability', { exact: true })).toBeVisible();
  await expect(nav.getByText('Tenants', { exact: true })).toHaveCount(0);
});

test('creates a tenant without an admin client and edits its name and description', async ({
  page,
}) => {
  const id = await startTenant(page, 'no-admin', 'No Admin Client');
  await page.getByRole('switch', { name: 'Create an admin client' }).click();
  await expect(page.getByText('No admin client is created')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Client Roles' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create tenant' }).click();

  await expect(page.getByText('Tenant created successfully')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/tenants/${id}$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('This tenant has no clients yet.')).toBeVisible();

  await page.getByRole('link', { name: 'Edit Tenant' }).click();
  await expect(page).toHaveURL(new RegExp(`/tenants/${id}/edit$`));
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toHaveValue('No Admin Client');
  await name.fill('Renamed Tenant');
  await page.getByRole('textbox', { name: 'Description' }).fill('Edited in the E2E test');
  await page.getByRole('button', { name: 'Update tenant' }).click();

  await expect(page.getByText('Tenant updated successfully')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/tenants/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Renamed Tenant' })).toBeVisible();
  await expect(page.getByText('Edited in the E2E test')).toBeVisible();
});
