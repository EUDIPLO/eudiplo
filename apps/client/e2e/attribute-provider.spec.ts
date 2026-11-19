import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { holdRequests } from './support/routes';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// The attribute provider list: its search, and a row's Delete with its confirmation, its busy
// state and the row leaving the list. The backend does not refuse to delete a provider that a
// credential configuration still names, so there is no in-use refusal to show here.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // A tenant per test, so a repeated test finds the provider it deletes.
  tenant = await createTenant('attribute-provider', 'Attribute Provider', ['issuance:manage']);
  for (const [id, name, url] of [
    ['crm', 'Customer records', 'https://crm.example.com/claims'],
    ['hr', 'Staff directory', 'https://hr.example.com/claims'],
  ]) {
    const response = await tenantRequest(tenant, 'POST', '/issuer/attribute-providers', {
      id,
      name,
      url,
      auth: { type: 'none' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
});

test('finds an attribute provider by its URL and deletes it from its row', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/attribute-providers');
  const links = page.getByRole('table').getByRole('link');
  await expect(links).toHaveText(['Customer records', 'Staff directory']);

  const search = page.getByRole('searchbox', { name: /^Search attribute providers/ });
  await search.fill('hr.example');
  await expect(links).toHaveText(['Staff directory']);
  await expect(page.getByText(/^\s*1 of 2 attribute providers\s*$/)).toBeVisible();
  await search.fill('payroll');
  const noMatch = page.getByRole('cell', { name: 'No attribute provider matches "payroll".' });
  await expect(noMatch).toBeVisible();
  await noMatch.getByRole('button', { name: 'Clear search' }).click();
  await expect(links).toHaveCount(2);

  const remove = page.getByRole('button', { name: 'Delete attribute provider hr', exact: true });
  const other = page.getByRole('button', { name: 'Delete attribute provider crm', exact: true });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  const held = await holdRequests(page, 'DELETE', '/issuer/attribute-providers/hr');
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('"Staff directory"');
    void dialog.accept();
  });
  await remove.click();
  await held.sent;
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toHaveAccessibleDescription('Deleting the attribute provider…');
  await expect(other).toHaveAttribute('aria-disabled', 'true');
  await expect(other).toHaveAccessibleDescription('Wait until the other delete has finished');
  held.release();

  await expect(page.getByText('Attribute provider deleted successfully')).toBeVisible();
  await expect(links).toHaveText(['Customer records']);
  await expect(page.getByText(/^\s*1 attribute provider\s*$/)).toBeVisible();
  await expect(other).not.toHaveAttribute('aria-disabled', 'true');
  expect((await tenantRequest(tenant, 'GET', '/issuer/attribute-providers/hr')).status).toBe(404);
});
