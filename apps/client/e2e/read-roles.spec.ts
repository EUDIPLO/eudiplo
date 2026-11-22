import { randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

/** Access token of the tenant client the other specs sign in with. */
async function tenantToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${resolvedE2EConfig.apiBaseUrl}/api/oauth2/token`, {
    form: {
      grant_type: 'client_credentials',
      client_id: resolvedE2EConfig.clientId!,
      client_secret: resolvedE2EConfig.clientSecret!,
    },
  });
  expect(response.ok(), 'tenant client token').toBe(true);
  return ((await response.json()) as { access_token: string }).access_token;
}

/**
 * Sends a client change again while another spec's configuration write of the
 * tenant runs: the backend allows one at a time (409 CONFIG_WRITER_ACTIVE).
 */
async function retryWhileWriterActive(send: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 1; ; attempt++) {
    const response = await send();
    const busy =
      response.status() === 409 &&
      ((await response.json()) as { code?: string }).code === 'CONFIG_WRITER_ACTIVE';
    if (!busy || attempt === 20) return response;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.describe('read and status roles', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // One worker, so beforeAll creates the clients once.
  test.describe.configure({ mode: 'default' });

  // Clients per run, so the spec also passes against a reused dev backend. The
  // tenant client must hold the roles it grants (the demo test-client does).
  const suffix = randomBytes(4).toString('hex');
  const clients = {
    support: { roles: ['sessions:read', 'credentials:status'] },
    auditor: { roles: ['audit:read'] },
    keys: { roles: ['keys:manage'] },
    offer: { roles: ['issuance:offer'] },
  };
  const credentials = Object.fromEntries(
    Object.keys(clients).map((name) => [
      name,
      { clientId: `${name}-${suffix}`, clientSecret: randomBytes(16).toString('hex') },
    ])
  ) as Record<keyof typeof clients, { clientId: string; clientSecret: string }>;
  /** Cancelled, so read-only callers see it. */
  let sessionId: string;
  /** Still open for a wallet, so read-only callers do not see it. */
  let openSessionId: string;
  /** An issuance offer, so issuance:offer has a session to recreate. */
  let issuanceSessionId: string;

  test.beforeAll(async ({ request }) => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
    const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
    for (const [name, { roles }] of Object.entries(clients)) {
      const { clientId, clientSecret } = credentials[name as keyof typeof clients];
      const response = await retryWhileWriterActive(() =>
        request.post(`${resolvedE2EConfig.apiBaseUrl}/api/client`, {
          headers,
          data: { clientId, secret: clientSecret, description: `E2E ${name}`, roles },
        })
      );
      // A dev tenant client without the new roles cannot grant them.
      test.skip(
        !resolvedE2EConfig.useBuild && response.status() === 403,
        `The tenant client must hold ${roles.join(', ')} to grant them, as the demo test-client does.`
      );
      expect(response.ok(), `create ${clientId}: ${await response.text()}`).toBe(true);
    }
    const newRequest = async () => {
      const offer = await request.post(`${resolvedE2EConfig.apiBaseUrl}/api/verifier/offer`, {
        headers,
        data: { response_type: 'uri', requestId: 'pid' },
      });
      expect(offer.ok(), `create a presentation request: ${await offer.text()}`).toBe(true);
      return ((await offer.json()) as { session: string }).session;
    };
    sessionId = await newRequest();
    const cancelled = await request.post(
      `${resolvedE2EConfig.apiBaseUrl}/api/session/${sessionId}/cancel`,
      { headers }
    );
    expect(cancelled.ok(), 'cancel the presentation request').toBe(true);
    openSessionId = await newRequest();
    const offer = await request.post(`${resolvedE2EConfig.apiBaseUrl}/api/issuer/offer`, {
      headers,
      data: {
        response_type: 'uri',
        credentialConfigurationIds: ['pid'],
        flow: 'pre_authorized_code',
      },
    });
    expect(offer.ok(), `create an issuance offer: ${await offer.text()}`).toBe(true);
    issuanceSessionId = ((await offer.json()) as { session: string }).session;
  });

  test.afterAll(async ({ request }) => {
    if (!hasAuthCredentials) return;
    const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
    for (const { clientId } of Object.values(credentials)) {
      const response = await retryWhileWriterActive(() =>
        request.delete(`${resolvedE2EConfig.apiBaseUrl}/api/client/${clientId}`, { headers })
      );
      expect(response.ok(), `delete ${clientId}`).toBe(true);
    }
  });

  test('sessions:read opens sessions but cannot cancel, recreate or select them', async ({
    page,
  }) => {
    const { clientId, clientSecret } = credentials.support;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('All Sessions', { exact: true })).toBeVisible();
    await expect(nav.getByText('New Verification')).toHaveCount(0);
    await expect(nav.getByText('New Issuance')).toHaveCount(0);

    await nav.getByText('All Sessions', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(
      page.getByText('Offers and requests that a wallet can still use are listed only')
    ).toBeVisible();
    await page.getByRole('searchbox', { name: /Search sessions/ }).fill(sessionId);
    await expect(page.locator('tr.session-row', { hasText: sessionId })).toBeVisible();
    await page.getByRole('searchbox', { name: /Search sessions/ }).fill(openSessionId);
    await expect(page.getByText('No session matches these filters.')).toBeVisible();
    await expect(page.locator('table mat-checkbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Issuance Offer' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Presentation Request' })).toHaveCount(0);

    await page.goto(`/session-management/${sessionId}`);
    await expect(page.getByRole('heading', { name: 'Presentation Session' })).toBeVisible();
    await expect(page.getByText(sessionId)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session cancelled' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Cancel (Offer|Request)$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recreate Request' })).toHaveCount(0);

    // Pending requests stay hidden from read-only callers: the page says it cannot load them.
    await page.goto(`/session-management/${openSessionId}`);
    await expect(page.locator('app-load-error').getByRole('alert')).toBeVisible();
    await expect(page.getByText(openSessionId)).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to the list' }).click();
    await expect(page).toHaveURL(/\/session-management$/);
  });

  // New Issuance reads the credential configs and issuer settings, which need issuance:manage.
  test('issuance:offer alone is told why New Issuance cannot be used', async ({ page }) => {
    const credentialConfigRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/issuer/credentials')) {
        credentialConfigRequests.push(request.url());
      }
    });
    const { clientId, clientSecret } = credentials.offer;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('All Sessions', { exact: true })).toBeVisible();
    await expect(nav.getByText('New Issuance')).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Credential Issuance' })).toHaveCount(0);

    await nav.getByText('All Sessions', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Issuance Offer' })).toHaveCount(0);
    const locked = page.locator('.header-actions').getByRole('button', { name: 'Issuance Offer' });
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    // The tooltip is the button's description, as for other locked buttons.
    await expect(locked).toHaveAccessibleDescription(/also needs the issuance:manage role/);
    await expect(
      page.getByText(
        'Not listed, as your roles cannot read them: credential configs need issuance:manage.'
      )
    ).toBeVisible();

    await page.goto(`/session-management/${issuanceSessionId}`);
    await expect(page.getByRole('heading', { name: 'Issuance Session' })).toBeVisible();
    const recreate = page.getByRole('button', { name: 'Recreate Offer' });
    await expect(recreate).toHaveAttribute('aria-disabled', 'true');
    await expect(recreate).toHaveAccessibleDescription(/also needs the issuance:manage role/);
    await recreate.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/session-management/${issuanceSessionId}$`));

    // A deep link says why instead of offering a Retry that cannot succeed.
    await page.goto('/offer/issuance');
    await expect(page.getByRole('status')).toContainText(
      'Creating offers in the Web Client also needs the issuance:manage role'
    );
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    expect(credentialConfigRequests).toEqual([]);
    await page.getByRole('link', { name: 'Back to Sessions' }).click();
    await expect(page).toHaveURL(/\/session-management$/);
  });

  test('audit:read opens the activity log and nothing else of the administration', async ({
    page,
  }) => {
    const { clientId, clientSecret } = credentials.auditor;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('API Clients')).toHaveCount(0);
    await expect(nav.getByText('All Sessions')).toHaveCount(0);

    const logs = page.waitForResponse(
      (response) =>
        response.url().includes('/api/admin/audit-logs/search') &&
        response.request().method() === 'GET'
    );
    await nav.getByText('Activity Logs', { exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/activity-logs$/);
    expect((await logs).ok(), 'GET /api/admin/audit-logs/search').toBe(true);
    await expect(page.getByRole('heading', { name: 'Activity Logs' })).toBeVisible();
  });

  test('keys:manage opens the key chains without configuration roles', async ({
    page,
    request,
  }) => {
    const { clientId, clientSecret } = credentials.keys;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('Credential Configs')).toHaveCount(0);

    const keyChains = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/key-chain') && response.request().method() === 'GET'
    );
    await nav.getByText('Keys', { exact: true }).click();
    await expect(page).toHaveURL(/\/keys$/);
    expect((await keyChains).ok(), 'GET /api/key-chain').toBe(true);
    await expect(page.getByRole('heading', { name: 'Keys', exact: true })).toBeVisible();

    const description = `keys:manage ${suffix}`;
    await page.goto('/keys/create');
    await page.getByRole('radio', { name: 'Access Certificate' }).check();
    await page.getByRole('button', { name: /^(Next|Configure Key)/ }).click();
    await page.getByRole('radio', { name: 'Self-Signed Certificate' }).check();
    await page.getByRole('button', { name: /^(Next|Configure Key)/ }).click();
    await page.getByRole('textbox', { name: 'Description' }).fill(description);
    await page.getByRole('button', { name: 'Create Key Chain' }).click();
    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();

    const keyChainId = new URL(page.url()).pathname.split('/').pop();
    const deleted = await retryWhileWriterActive(async () =>
      request.delete(`${resolvedE2EConfig.apiBaseUrl}/api/key-chain/${keyChainId}`, {
        headers: { Authorization: `Bearer ${await tenantToken(request)}` },
      })
    );
    expect(deleted.ok(), 'delete the key chain').toBe(true);
  });
});
