import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// Registers an OpenID Connect client, shows its secret once, rotates the secret, edits and
// deletes the client.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('oidc-client', 'OIDC Client', ['presentation:manage']);
  const config = await tenantRequest(tenant, 'POST', '/verifier/config', {
    id: 'pid-login',
    description: 'PID sign-in',
    dcql_query: {
      credentials: [
        {
          id: 'pid',
          format: 'dc+sd-jwt',
          meta: { vct_values: ['urn:eudi:pid:de:1'] },
          claims: [{ path: ['given_name'] }],
          trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'pid-providers' }] }],
        },
      ],
    },
  });
  expect(config.status, await config.clone().text()).toBe(201);
});

test('registers, rotates the secret of, edits and deletes a client', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.locator('mat-sidenav').getByText('OIDC Clients', { exact: true }).click();
  await expect(page.getByText('No OIDC clients yet.')).toBeVisible();
  // The header and the empty state both offer it.
  await page.getByRole('link', { name: 'Create OIDC client', exact: true }).first().click();

  // An HTTP redirect URI outside localhost is refused before anything is sent.
  await page.getByRole('textbox', { name: 'Name' }).fill('Customer Portal');
  await page.getByRole('textbox', { name: 'Redirect URI 1' }).fill('http://portal.example/cb');
  await page.getByRole('textbox', { name: 'Scope' }).fill('pid');
  // The empty select's floating label covers its centre, where a click would land.
  await page.getByRole('combobox', { name: 'Verification config' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: /pid-login/ }).click();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await create.click();
  await expect(
    page.getByText('Use HTTPS; HTTP only for localhost, 127.0.0.1 and [::1]')
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Redirect URI 1' })).toBeFocused();

  await page.getByRole('textbox', { name: 'Redirect URI 1' }).fill('https://portal.example/cb');
  await page.getByRole('combobox', { name: 'Top-level claims' }).click();
  await page.getByRole('option', { name: 'Claims of pid' }).click();
  await create.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Client secret', { exact: true })).toBeVisible();
  await expect(dialog.getByText(`/verifiers/${tenant.id}/oidc`)).toBeVisible();
  await dialog.getByRole('button', { name: 'I have copied the secret' }).click();
  await expect(dialog).toBeHidden();

  await expect(
    page.getByRole('heading', { name: 'OIDC Client: Customer Portal', exact: true })
  ).toBeVisible();
  await expect(page.getByText('https://portal.example/cb')).toBeVisible();
  await expect(page.getByText('Claims of pid also at the top level')).toBeVisible();

  // The only secret cannot be deleted; a second one can be added, then the first deleted.
  await expect(page.getByRole('button', { name: 'Delete secret 1' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  await page.getByRole('button', { name: 'Add secret' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'I have copied the secret' }).click();
  await expect(page.getByRole('heading', { name: 'Secret 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add secret' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );

  page.once('dialog', (confirm) => void confirm.accept());
  await page.getByRole('button', { name: 'Delete secret 1' }).click();
  await expect(page.getByText('Secret deleted')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Secret 2' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Secret 1' })).toBeFocused();

  // Edit returns to the client's page with the change.
  await page.getByRole('button', { name: 'Edit OIDC client' }).click();
  await expect(page.getByRole('heading', { name: 'Edit OIDC Client' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Partner Portal');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page).toHaveURL(/\/oidc-clients\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'OIDC Client: Partner Portal' })).toBeVisible();

  // Delete asks first, then returns to the list.
  page.once('dialog', (confirm) => void confirm.accept());
  await page.getByRole('button', { name: 'Delete OIDC client' }).click();
  await expect(page).toHaveURL(/\/oidc-clients$/);
  await expect(page.getByText('No OIDC clients yet.')).toBeVisible();
});
