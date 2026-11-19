import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// The user pages need the backend's Keycloak user management, which the E2E backend does not
// have (it answers 501). `page.route` answers /api/user from a list kept in the spec, and adds
// users:manage to the roles that /api/auth/me returns for the test client. The pages run as
// in production; only the user requests and the caller's roles are answered here.

interface ManagedUser {
  id: string;
  username: string;
  email?: string;
  enabled: boolean;
  roles: string[];
  temporaryPassword?: string;
}

/** Answers the user API from `users` and gives the caller users:manage. */
async function mockUserManagement(page: Page, users: ManagedUser[]): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/api/auth/me'),
    async (route) => {
      const response = await route.fetch();
      const caller = (await response.json()) as { roles: string[] };
      await route.fulfill({
        response,
        json: { ...caller, roles: [...caller.roles, 'users:manage'] },
      });
    }
  );
  await page.route(
    (url) => /\/api\/user(\/[^/]+)?$/.test(url.pathname),
    async (route) => {
      const request = route.request();
      const id = /\/api\/user\/([^/]+)$/.exec(new URL(request.url()).pathname)?.[1];
      const user = users.find((candidate) => candidate.id === id);
      switch (`${request.method()} ${id ? 'one' : 'all'}`) {
        case 'GET all':
          return route.fulfill({ json: users });
        case 'POST all': {
          const body = request.postDataJSON() as Omit<ManagedUser, 'id'>;
          const created = { ...body, id: `user-${users.length + 1}` };
          users.push(created);
          return route.fulfill({
            status: 201,
            json: { ...created, temporaryPassword: 'Temporary-Pass-123' },
          });
        }
        case 'GET one':
          return user
            ? route.fulfill({ json: user })
            : route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } });
        case 'PATCH one':
          if (!user) {
            return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } });
          }
          Object.assign(user, request.postDataJSON());
          return route.fulfill({ json: user });
        case 'DELETE one':
          if (!user) {
            return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } });
          }
          users.splice(users.indexOf(user), 1);
          return route.fulfill({ status: 204 });
        default:
          return route.fallback();
      }
    }
  );
}

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // A client with known roles: it holds the roles of alice and bob, but not tenant:admin.
  const tenant = await createTenant('users', 'Users', ['issuance:offer', 'presentation:request']);
  await mockUserManagement(page, [
    {
      id: 'user-1',
      username: 'alice',
      email: 'alice@example.com',
      enabled: true,
      roles: ['issuance:offer'],
    },
    { id: 'user-2', username: 'bob', enabled: false, roles: ['presentation:request'] },
    // The signed-in client can neither hold nor grant tenant:admin.
    { id: 'user-3', username: 'carol', enabled: true, roles: ['tenant:admin'] },
  ]);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
});

test('lists and searches users, and locks the actions for a user it cannot manage', async ({
  page,
}) => {
  await page.goto('/users');
  // users:manage brings the Users page into the navigation.
  await expect(
    page.locator('mat-sidenav').getByRole('link', { name: 'Users', exact: true })
  ).toBeVisible();
  const links = page.getByRole('table').getByRole('link');
  await expect(links).toHaveText(['alice', 'bob', 'carol']);
  await expect(page.getByText(/^\s*3 users\s*$/)).toBeVisible();

  // The search looks in usernames, e-mail addresses and roles.
  const search = page.getByRole('searchbox', { name: /^Search users/ });
  await search.fill('example.com');
  await expect(links).toHaveText(['alice']);
  await search.fill('presentation:request');
  await expect(links).toHaveText(['bob']);
  await expect(page.getByText(/^\s*1 of 3 users\s*$/)).toBeVisible();
  await search.fill('dave');
  const noMatch = page.getByRole('cell', { name: 'No user matches "dave".' });
  await expect(noMatch).toBeVisible();
  await noMatch.getByRole('button', { name: 'Clear search' }).click();
  await expect(links).toHaveCount(3);

  const carol = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'carol' }) });
  await expect(
    carol.getByRole('button', { name: /^Delete User: This user has roles/ })
  ).toHaveAttribute('aria-disabled', 'true');
  await expect(
    carol.getByRole('button', { name: /^Edit User: This user has roles/ })
  ).toBeDisabled();
  const alice = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'alice' }) });
  await expect(alice.getByRole('button', { name: 'Delete User', exact: true })).toBeEnabled();
});

test('creates a user and shows the temporary password once', async ({ page }) => {
  await page.goto('/users');
  await page
    .getByRole('link', { name: /Create user/i })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create user' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Username' }).fill('dave');
  await page.getByRole('combobox', { name: 'Roles' }).click();
  await page.getByRole('option', { name: 'issuance:offer' }).click();
  // Only roles the caller holds are offered.
  await expect(page.getByRole('option', { name: 'tenant:admin' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const created = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/user')
  );
  await page.getByRole('button', { name: 'Create User' }).click();
  expect((await created).postDataJSON()).toMatchObject({
    username: 'dave',
    roles: ['issuance:offer'],
    enabled: true,
  });

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Temporary Password Generated' })).toBeVisible();
  await expect(dialog.getByText('Temporary-Pass-123')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Temporary-Pass-123')).toHaveCount(0);
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole('link', { name: 'dave', exact: true })).toBeVisible();
});

test('opens a user and deletes it from its page', async ({ page }) => {
  await page.goto('/users');
  await page.getByRole('link', { name: 'alice', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/user-1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'alice' })).toBeVisible();
  await expect(page.getByText('alice@example.com')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
  await expect(page.getByText('issuance:offer')).toBeVisible();

  // Dismissing the confirmation keeps the user.
  const remove = page.getByRole('button', { name: 'Delete', exact: true });
  page.once('dialog', (dialog) => void dialog.dismiss());
  await remove.click();
  await expect(page).toHaveURL(/\/users\/user-1$/);

  const deleted = page.waitForRequest(
    (request) => request.method() === 'DELETE' && request.url().endsWith('/api/user/user-1')
  );
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('"alice"');
    void dialog.accept();
  });
  await remove.click();
  await deleted;
  await expect(page.getByText('User deleted successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole('table').getByRole('link')).toHaveText(['bob', 'carol']);
});

test('deletes a user from its row', async ({ page }) => {
  await page.goto('/users');
  const bob = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'bob' }) });
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('"bob"');
    void dialog.accept();
  });
  await bob.getByRole('button', { name: 'Delete User', exact: true }).click();
  await expect(page.getByText('User deleted successfully')).toBeVisible();
  await expect(page.getByRole('table').getByRole('link')).toHaveText(['alice', 'carol']);
});

test('edits a user and returns to its page', async ({ page }) => {
  await page.goto('/users/user-2');
  await expect(page.getByRole('heading', { level: 1, name: 'bob' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit user' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue('bob');

  await page.getByRole('checkbox', { name: 'User enabled' }).check();
  await page.getByRole('combobox', { name: 'Roles' }).click();
  await page.getByRole('option', { name: 'issuance:offer' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  const updated = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith('/api/user/user-2')
  );
  await page.getByRole('button', { name: 'Update User' }).click();
  expect((await updated).postDataJSON()).toMatchObject({
    enabled: true,
    roles: expect.arrayContaining(['presentation:request', 'issuance:offer']),
  });
  await expect(page.getByText('User updated successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/users\/user-2$/);
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
});
