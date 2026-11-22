import { expect, test } from './support/test';
import { useTenantClient } from './support/clients';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

test('session management list is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/session-management');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/session-management(\/.*)?$/);
});

test('opens a session from its row, selects rows without opening them, and goes back', async ({
  page,
  request,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const token = await request.post(`${resolvedE2EConfig.apiBaseUrl}/api/oauth2/token`, {
    form: {
      grant_type: 'client_credentials',
      client_id: resolvedE2EConfig.clientId!,
      client_secret: resolvedE2EConfig.clientSecret!,
    },
  });
  expect(token.ok(), 'tenant client token').toBe(true);
  const { access_token } = (await token.json()) as { access_token: string };
  const offer = await request.post(`${resolvedE2EConfig.apiBaseUrl}/api/verifier/offer`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { response_type: 'uri', requestId: 'pid' },
  });
  expect(offer.ok(), `create a presentation request: ${await offer.text()}`).toBe(true);
  const { session } = (await offer.json()) as { session: string };

  await page.goto('/session-management');
  await page.getByRole('searchbox', { name: /Search sessions/ }).fill(session);
  const row = page.locator('tr.session-row', { hasText: session });
  await expect(row).toHaveCount(1);

  // The checkbox sits above the link that covers the row.
  await row.getByRole('checkbox').click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await expect(page).toHaveURL(/\/session-management(\?.*)?$/);

  // The session link covers its row, so a click on another cell opens the session too.
  await expect(row.getByRole('link', { name: `Session ${session}` })).toBeVisible();
  // force: Playwright refuses a click whose target the link covers; the click lands on the link.
  await row.locator('.type-label').click({ force: true });
  await expect(page).toHaveURL(new RegExp(`/session-management/${session}$`));
  await expect(page.getByRole('heading', { name: 'Verification Session', level: 1 })).toBeVisible();

  await page.getByRole('link', { name: 'Back to Sessions' }).click();
  await expect(page).toHaveURL(/\/session-management$/);
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
});

test.describe('verifier admin', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'session-settings',
    ['presentation:manage'],
    'E2E verifier admin without issuance or session roles'
  );

  test('opens Session Settings without issuance roles', async ({ page }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);

    const config = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/session-config') && response.request().method() === 'GET'
    );
    await page.locator('mat-sidenav').getByText('Session Settings', { exact: true }).click();
    await expect(page).toHaveURL(/\/session-management\/config$/);
    expect((await config).ok(), 'GET /api/session-config').toBe(true);
    await expect(page.getByRole('heading', { name: 'Session Settings', level: 1 })).toBeVisible();
  });

  test('is turned away from the session list', async ({ page }) => {
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('Session Settings', { exact: true })).toBeVisible();
    await expect(nav.getByText('All Sessions')).toHaveCount(0);

    await page.goto('/session-management');
    // The guard's snackbar closes after a few seconds, so check it first.
    await expect(
      page.getByText(
        'Access denied to /session-management: it needs the issuance:offer, presentation:request or sessions:read role.'
      )
    ).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
