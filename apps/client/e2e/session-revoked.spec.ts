import { expect, test } from './support/test';
import { deleteTenantClient, setTenantClientRoles, useTenantClient } from './support/clients';
import { loginWithClientCredentials } from './support/login';

// The backend checks the API client behind a token on every request. The Web Client follows it:
// a deleted client ends the session, and a lost role hides its pages and is named.

test.describe('deleted client', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'revoked-session',
    ['presentation:manage'],
    'E2E client that is deleted while signed in'
  );

  test('ends the session with a notice', async ({ page, request }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);

    await deleteTenantClient(request, clientId);
    await page.locator('mat-sidenav').getByText('Session Settings', { exact: true }).click();

    const notice = page.getByText('Your API client no longer has access');
    await expect(notice).toBeVisible();
    await page.getByRole('button', { name: 'Log in' }).click();
    // A refused session ends like an expired one: logging in again returns to this page.
    await expect(page).toHaveURL(/\/login\?returnUrl=%2Fsession-management%2Fconfig$/);
  });
});

test.describe('client with changed roles', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'changed-roles',
    ['presentation:manage', 'issuance:manage'],
    'E2E client whose roles change while signed in'
  );

  test('names a removed role, hides its menu entries and offers to leave its page', async ({
    page,
    request,
  }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('Credential Types', { exact: true })).toBeVisible();
    // The dashboard's own requests must not be the first ones refused.
    await page.waitForLoadState('networkidle');

    await setTenantClientRoles(request, clientId, ['presentation:manage']);
    const refused = page.waitForResponse(
      (response) => response.url().includes('/api/issuer/credentials') && response.status() === 403
    );
    await nav.getByText('Credential Types', { exact: true }).click();
    await refused;

    await expect(
      page.getByText(
        'Your API client no longer has the role issuance:manage, which this page needs.'
      )
    ).toBeVisible();
    await expect(nav.getByText('Credential Types', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/credential-config$/);
    await page.getByRole('button', { name: 'Leave page' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(nav.getByText('Session Settings', { exact: true })).toBeVisible();
  });
});

test.describe('reloaded session with changed roles', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'reloaded-roles',
    ['presentation:manage', 'issuance:manage'],
    'E2E client whose roles change while a reloaded tab is signed in'
  );

  test('names the removed role without a new login, although the tab cannot renew its token', async ({
    page,
    request,
  }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);
    // A reload drops the client secret: the tab keeps its token but cannot renew it.
    await page.reload();
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('Credential Types', { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await setTenantClientRoles(request, clientId, ['presentation:manage']);
    const refused = page.waitForResponse(
      (response) => response.url().includes('/api/issuer/credentials') && response.status() === 403
    );
    await nav.getByText('Credential Types', { exact: true }).click();
    await refused;

    await expect(
      page.getByText(
        'Your API client no longer has the role issuance:manage, which this page needs.'
      )
    ).toBeVisible();
    await expect(nav.getByText('Credential Types', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/credential-config$/);
    await page.getByRole('button', { name: 'Leave page' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe('reloaded session that saves after its roles changed', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'reloaded-save',
    ['presentation:manage', 'issuance:manage'],
    'E2E client whose roles change before a reloaded tab saves'
  );

  test('keeps the notice visible when the page reports a refused save', async ({
    page,
    request,
  }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);
    // Opening the page by address reloads the app, which drops the client secret.
    await page.goto('/attribute-providers/create');
    await page.getByLabel('ID').fill('reloaded-save');
    await page.getByLabel('Name').fill('Reloaded save');
    await page.getByLabel('URL').fill('https://example.com/attributes');
    const create = page.getByRole('button', { name: 'Create' });
    await expect(create).toBeEnabled();
    await page.waitForLoadState('networkidle');

    await setTenantClientRoles(request, clientId, ['presentation:manage']);
    const refused = page.waitForResponse(
      (response) =>
        response.url().includes('/api/issuer/attribute-providers') && response.status() === 403
    );
    await create.click();
    await refused;

    // The page's own "Failed to create" message must not hide the notice.
    await expect(
      page.getByText(
        'Your API client no longer has the role issuance:manage, which this page needs.'
      )
    ).toBeVisible();
    await expect(page.getByText('Failed to create attribute provider')).toHaveCount(0);
    await expect(page).toHaveURL(/\/attribute-providers\/create$/);
  });
});
