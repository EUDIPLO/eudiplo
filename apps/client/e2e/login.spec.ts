import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

test.use({ storageState: { cookies: [], origins: [] } });

test('login page is accessible', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('asks before a link signs in at an instance the console does not know', async ({ page }) => {
  const questions: string[] = [];
  page.on('dialog', (dialog) => {
    questions.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto('/login?clientId=client-b&clientSecret=secret-b&apiUrl=https://other.invalid');

  await expect(
    page.getByText(
      'Not signed in at https://other.invalid. Enter the address of an EUDIPLO instance you trust.'
    )
  ).toBeVisible();
  expect(questions).toEqual([
    'The link you opened chose the EUDIPLO instance https://other.invalid. It signs you in with the client the link names, and everything you do in the console goes to this instance. Sign in only if you trust this instance.',
  ]);
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByLabel('EUDIPLO Instance')).toBeFocused();
});

test('login with client credentials redirects to dashboard', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run tenant login flow test.'
  );

  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.clientId!,
    resolvedE2EConfig.clientSecret!
  );
});

test.describe('kept session', () => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run the kept session tests.'
  );

  /**
   * Signs in and moves the page's clock past the token's lifetime, as after a long
   * break, without a reload: a reload would drop the client secret, which the Web
   * Client keeps in memory only. The renewal due meanwhile goes to the routes the
   * test set up before.
   */
  async function signInAndExpire(page: Page): Promise<void> {
    await page.clock.install();
    await loginWithClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!
    );
  }

  async function expireToken(page: Page): Promise<void> {
    await page.clock.fastForward('24:00:00');
  }

  /** Opens a guarded page from the navigation, without a reload. */
  async function openConnectionSettings(page: Page): Promise<void> {
    await page.getByRole('link', { name: 'Connection Settings' }).click();
  }

  test('resumes on the page the user was on once the backend answers again', async ({ page }) => {
    await signInAndExpire(page);
    let backendDown = true;
    await page.route('**/api/oauth2/token', (route) =>
      backendDown ? route.abort('connectionrefused') : route.fallback()
    );
    await expireToken(page);

    await openConnectionSettings(page);

    await expect(page).toHaveURL(/\/login\?returnUrl=%2Fsettings%2Fconnection$/);
    await expect(page.getByRole('status')).toContainText(
      `Resuming the session of ${resolvedE2EConfig.clientId}`
    );

    backendDown = false;
    // Only the button sends a token request this soon; the automatic retry comes later.
    const renewal = page.waitForRequest('**/api/oauth2/token', { timeout: 1_000 });
    await page.getByRole('button', { name: 'Try again now' }).click();
    await renewal;
    await expect(page).toHaveURL(/\/settings\/connection$/);
  });

  test('signs out of the kept session and opens the dashboard after signing in again', async ({
    page,
  }) => {
    await signInAndExpire(page);
    let backendDown = true;
    await page.route('**/api/oauth2/token', (route) =>
      backendDown ? route.abort('connectionrefused') : route.fallback()
    );
    await expireToken(page);
    await openConnectionSettings(page);
    await expect(page.getByRole('status')).toContainText('Resuming the session of');

    await page.getByRole('button', { name: 'Sign out and use other credentials' }).click();
    await expect(page.getByLabel('EUDIPLO Instance')).toHaveValue(resolvedE2EConfig.apiBaseUrl);

    backendDown = false;
    await page.getByRole('tab', { name: 'Client ID and Secret' }).click();
    await expect(page.getByRole('textbox', { name: 'Client ID' })).toHaveValue(
      resolvedE2EConfig.clientId!
    );
    await page
      .getByRole('textbox', { name: 'Client Secret' })
      .fill(resolvedE2EConfig.clientSecret!);
    await page.getByRole('button', { name: 'Login with Client Credentials' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('shows the form and names the client when the kept credentials are rejected', async ({
    page,
  }) => {
    await signInAndExpire(page);
    // Hold the answer until the page waits for the kept session, then reject the credentials.
    let reject!: () => void;
    const rejected = new Promise<void>((resolve) => (reject = resolve));
    await page.route('**/api/oauth2/token', async (route) => {
      await rejected;
      await route.fulfill({
        status: 401,
        json: { statusCode: 401, message: 'Invalid client credentials', error: 'Unauthorized' },
      });
    });

    await expireToken(page);
    await openConnectionSettings(page);
    await expect(page.getByRole('status')).toContainText('Resuming the session of');
    reject();

    await expect(
      page.getByText(`The credentials of ${resolvedE2EConfig.clientId} were rejected`)
    ).toBeVisible();
    await expect(page.getByLabel('EUDIPLO Instance')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Try again now' })).toHaveCount(0);
  });
});

/**
 * Expects the login page after an expired session: the form starts from its client and
 * instance and names the client. Then signs in again with the secret alone.
 */
async function expectExpiredLogin(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/login\?returnUrl=%2Fsettings%2Fconnection$/);
  await expect(page.getByText('Resuming the session of')).toHaveCount(0);
  await expect(
    page.getByText(
      `The session of ${resolvedE2EConfig.clientId} expired. Log in again to continue.`
    )
  ).toBeVisible();
  await expect(page.getByLabel('EUDIPLO Instance')).toHaveValue(resolvedE2EConfig.apiBaseUrl);
  await expect(page.getByRole('tab', { name: 'Client ID and Secret' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('textbox', { name: 'Client Secret' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Client ID' })).toHaveValue(
    resolvedE2EConfig.clientId!
  );
  await expect(page.getByRole('textbox', { name: 'Client Secret' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Client Secret' }).fill(resolvedE2EConfig.clientSecret!);
  await page.getByRole('button', { name: 'Login with Client Credentials' }).click();
}

test.describe('reload', () => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run the reload tests.'
  );

  test('keeps the session until its token expires, without storing the client secret', async ({
    page,
  }) => {
    await loginWithClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!
    );
    const storesSecret = () =>
      page.evaluate(
        (secret) => Object.values(localStorage).some((value) => value.includes(secret)),
        resolvedE2EConfig.clientSecret!
      );
    expect(await storesSecret()).toBe(false);

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('link', { name: 'Connection Settings' }).click();
    await expect(page.getByLabel('Client Secret')).toHaveValue('Not available in this tab');
    await expect(page.getByText('Automatic token refresh: disabled')).toBeVisible();
    expect(await storesSecret()).toBe(false);

    // Without the secret, an expired token is not renewed: the login form asks for the
    // secret only, says why, and returns to the page after signing in again.
    await page.evaluate(() => localStorage.setItem('token_expiration', String(Date.now() - 1000)));
    await page.goto('/settings/connection');
    await expectExpiredLogin(page);
    await expect(page).toHaveURL(/\/settings\/connection$/);
  });

  test('returns to the page after a restored session expires on it', async ({ page }) => {
    await page.clock.install();
    await loginWithClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!
    );
    await page.reload();
    await page.getByRole('link', { name: 'Connection Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/connection$/);

    // The built-in server issues tokens for 24 hours; the restored session cannot renew it.
    await page.clock.fastForward('24:01:00');
    const notice = page.locator('mat-snack-bar-container', { hasText: 'Your session has expired' });
    await notice.getByRole('button', { name: 'Log in' }).click();

    await expectExpiredLogin(page);
    await expect(page).toHaveURL(/\/settings\/connection$/);
  });

  test('a tab opened later takes over the token that the tab you logged in with renews', async ({
    page,
    context,
  }) => {
    // The clock belongs to the browser context, so both tabs share it.
    await page.clock.install();
    await loginWithClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!
    );
    const other = await context.newPage();
    await other.goto('/dashboard');
    await expect(other).toHaveURL(/\/dashboard$/);
    const tokenRequestsOfOther: string[] = [];
    other.on('request', (request) => {
      if (request.url().includes('/api/oauth2/token')) tokenRequestsOfOther.push(request.url());
    });
    // Registered after the Web Client's listener, so it resolves once the token was taken.
    const taken = other.evaluate(
      () =>
        new Promise<void>((resolve) =>
          addEventListener('storage', (event) => event.key === 'token_expiration' && resolve())
        )
    );

    // In the token's last five minutes, the tab you logged in with renews it.
    const renewal = page.waitForResponse('**/api/oauth2/token');
    await page.clock.fastForward('23:56:00');
    await renewal;
    await taken;

    // Past the lifetime of the token it started with, the other tab is still signed in.
    await page.clock.fastForward('01:00:00');
    await other.getByRole('link', { name: 'Connection Settings' }).click();
    await expect(other).toHaveURL(/\/settings\/connection$/);
    await expect(other.getByText('Your session has expired')).toHaveCount(0);
    expect(tokenRequestsOfOther).toEqual([]);
  });
});
