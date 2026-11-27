import { randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse, Locator } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

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
    reader: { roles: ['issuance:read'] },
    issuer: { roles: ['issuance:manage'] },
    verifierReader: { roles: ['presentation:read'] },
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
    await expect(page.getByRole('link', { name: 'Verification Request' })).toHaveCount(0);

    await page.goto(`/session-management/${sessionId}`);
    await expect(page.getByRole('heading', { name: 'Verification Session' })).toBeVisible();
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

  // New Issuance needs only issuance:offer, which includes issuance:read for the form's data.
  test('issuance:offer alone opens New Issuance and recreates an offer', async ({ page }) => {
    const { clientId, clientSecret } = credentials.offer;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('New Issuance')).toBeVisible();
    await expect(nav.getByText('Credential Configs')).toBeVisible();

    await nav.getByText('All Sessions', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(
      page.locator('.header-actions').getByRole('link', { name: 'Issuance Offer' })
    ).toBeVisible();
    await expect(page.getByText(/credential configs need/)).toHaveCount(0);

    await page.goto(`/session-management/${issuanceSessionId}`);
    await expect(page.getByRole('heading', { name: 'Issuance Session' })).toBeVisible();
    const recreate = page.getByRole('button', { name: 'Recreate Offer' });
    await expect(recreate).not.toHaveAttribute('aria-disabled', 'true');
    await recreate.click();
    await expect(page).toHaveURL(/\/offer\/issuance$/);
    await expect(page.getByRole('heading', { name: 'Generate Issuance Offer' })).toBeVisible();
    await expect(page.locator('mat-stepper')).toBeVisible();
    await expect(page.locator('app-load-error')).toHaveCount(0);
  });

  test('issuance:read sees the credential configs with their changes locked', async ({ page }) => {
    const { clientId, clientSecret } = credentials.reader;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('New Issuance')).toHaveCount(0);

    await nav.getByText('Credential Configs', { exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Credential Configs', exact: true })
    ).toBeVisible();
    const reason = 'Needs the issuance:manage role';
    const create = page.getByRole('link', { name: 'Create credential config' }).first();
    await expect(create).toHaveAttribute('aria-disabled', 'true');
    await expect(create).toHaveAccessibleDescription(reason);
    const edit = page.getByRole('button', { name: 'Edit credential config pid', exact: true });
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAccessibleDescription(new RegExp(reason));
    const remove = page.getByRole('button', {
      name: 'Delete credential config pid',
      exact: true,
    });
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await edit.click({ force: true });
    await expect(page).toHaveURL(/\/credential-config$/);

    // The configuration itself opens, Edit stays locked.
    await page.getByRole('link', { name: 'pid', exact: true }).click();
    await expect(page).toHaveURL(/\/credential-config\/pid$/);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    );

    // The form refuses a caller without the write role.
    await page.goto('/credential-config/pid/edit');
    await expect(page.getByText(/Access denied to \/credential-config\/pid\/edit/)).toBeVisible();
    await expect(page).not.toHaveURL(/\/edit$/);
  });

  test('issuance:manage without keys:manage reads key chains but cannot change them', async ({
    page,
  }) => {
    const { clientId, clientSecret } = credentials.issuer;
    await loginWithClientCredentials(page, clientId, clientSecret);
    await page.locator('mat-sidenav').getByText('Keys', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Keys', exact: true })).toBeVisible();

    const reason = 'Needs the keys:manage role';
    const create = page.locator('.header-actions').getByRole('link', { name: 'Create key' });
    await expect(create).toHaveAttribute('aria-disabled', 'true');
    await expect(create).toHaveAccessibleDescription(new RegExp(reason));
    const edit = page.getByRole('link', { name: /^Edit key chain / }).first();
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAccessibleDescription(new RegExp(reason));
    const remove = page.getByRole('button', { name: /^Delete key chain / }).first();
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await create.click({ force: true });
    await expect(page).toHaveURL(/\/keys$/);

    await page.goto('/keys/create');
    await expect(page.getByText(/Access denied to \/keys\/create/)).toBeVisible();
    await expect(page).not.toHaveURL(/\/keys\/create$/);

    // The KMS providers do not offer to create a key either.
    await page.goto('/kms');
    await expect(page.getByRole('heading', { name: 'KMS Providers' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Create key with provider/ })).toHaveCount(0);
    await expect(
      page.getByText('Creating key chains needs the keys:manage role.').first()
    ).toBeVisible();
  });

  test('presentation:read sees the verification configuration with its changes locked', async ({
    page,
  }) => {
    const { clientId, clientSecret } = credentials.verifierReader;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');
    await expect(nav.getByText('New Verification')).toHaveCount(0);
    const locked = async (locator: Locator, reason: RegExp) => {
      await expect(locator).toHaveAttribute('aria-disabled', 'true');
      await expect(locator).toHaveAccessibleDescription(reason);
    };
    const presentationReason = /Needs the presentation:manage role/;

    await nav.getByText('Verification Configs', { exact: true }).click();
    await expect(page).toHaveURL(/\/presentation-config$/);
    await locked(page.getByRole('link', { name: 'Create config' }).first(), presentationReason);
    await locked(page.locator('[aria-label="Edit verification config pid"]'), presentationReason);
    await locked(page.locator('[aria-label="Delete verification config pid"]'), presentationReason);
    await page.goto('/presentation-config/pid');
    await locked(
      page.getByRole('button', { name: 'Copy verification config' }),
      presentationReason
    );
    await locked(
      page.getByRole('button', { name: 'Delete verification config' }),
      presentationReason
    );

    await nav.getByText('OIDC Clients', { exact: true }).click();
    await expect(page).toHaveURL(/\/oidc-clients$/);
    await locked(
      page.getByRole('link', { name: 'Create OIDC client' }).first(),
      presentationReason
    );

    // Trust lists are shared: either manage role changes them.
    const sharedReason = /Needs the issuance:manage or presentation:manage role/;
    await nav.getByText('Trust Lists', { exact: true }).click();
    await expect(page).toHaveURL(/\/trust-list$/);
    await locked(page.getByRole('button', { name: 'Create new Trust List' }), sharedReason);
    await locked(page.getByRole('link', { name: /^Edit trust list / }).first(), sharedReason);

    for (const form of ['/presentation-config/create', '/oidc-clients/create']) {
      await page.goto(form);
      await expect(page.getByText(`Access denied to ${form}`)).toBeVisible();
      await expect(page).not.toHaveURL(new RegExp(`${form}$`));
    }
  });

  test('issuance:read reads Session Settings and a status list without unsaved changes', async ({
    page,
  }) => {
    const { clientId, clientSecret } = credentials.reader;
    await loginWithClientCredentials(page, clientId, clientSecret);
    const nav = page.locator('mat-sidenav');

    await nav.getByText('Session Settings', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Session Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('note')).toContainText(
      'Read-only: changing these settings needs the issuance:manage or presentation:manage role.'
    );
    await expect(page.getByRole('spinbutton', { name: 'TTL in seconds' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '1 hour' })).toBeDisabled();
    // Leaving asks nothing: a reader has no changes to lose.
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.message()}`);
    });
    await nav.getByText('Status Lists', { exact: true }).click();
    await expect(page).toHaveURL(/\/status-lists$/);

    await page.locator('a.item-link').first().click();
    await expect(page.getByRole('heading', { name: 'Edit Status List' })).toBeVisible();
    await expect(page.getByRole('note')).toContainText(
      'Read-only: changing this status list needs the issuance:manage role.'
    );
    for (const select of await page.locator('form mat-select').all()) {
      await expect(select).toHaveAttribute('aria-disabled', 'true');
    }
    await expect(page.getByRole('button', { name: 'Save Changes' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await nav.getByText('Credential Configs', { exact: true }).click();
    await expect(page).toHaveURL(/\/credential-config$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('keys:export shows the tenant KMS configuration', async ({ page }) => {
    // The demo test-client does not hold keys:export, so it cannot grant it; root can.
    test.skip(
      !hasRootCredentials,
      'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
    );
    const tenant = await createTenant('kms-export', 'KMS Export', ['keys:export']);
    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    await page.goto('/kms');
    await expect(page.getByRole('heading', { name: 'KMS Providers' })).toBeVisible();
    await expect(page.getByText('Tenant KMS Configuration', { exact: true })).toBeVisible();
  });

  test('keys:manage alone does not show the tenant KMS configuration', async ({ page }) => {
    const { clientId, clientSecret } = credentials.keys;
    await loginWithClientCredentials(page, clientId, clientSecret);
    await page.goto('/kms');
    await expect(page.getByRole('heading', { name: 'KMS Providers' })).toBeVisible();
    await expect(page.locator('ul[aria-label="KMS providers"]')).toBeVisible();
    await expect(page.getByText('Tenant KMS Configuration', { exact: true })).toHaveCount(0);
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
