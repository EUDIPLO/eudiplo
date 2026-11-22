import { expect, test } from './support/test';
import { hasAuthCredentials, hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// Deleting sessions removes the Web Client's only way to change the status of their credentials:
// Delete Selected and Session Settings say so, and a Save that switches to Full Delete asks first.

test.describe('Session Settings of a tenant of its own', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks before saving Full Delete and says what it means for credentials', async ({
    page,
  }) => {
    test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
    const tenant = await createTenant('session-delete', 'Session Delete', ['presentation:manage']);
    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    await page.goto('/session-management/config');
    await expect(page.getByRole('heading', { name: 'Session Settings', level: 1 })).toBeVisible();

    await page.getByRole('combobox', { name: 'Cleanup mode' }).click();
    await page.getByRole('option', { name: /^Full Delete/ }).click();
    await expect(page.locator('.info-box.warning')).toContainText(
      'the Web Client can no longer revoke, suspend or reinstate them'
    );

    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/api/session-config')) {
        writes.push(request.url());
      }
    });
    const save = page.getByRole('button', { name: 'Save Configuration' });
    await expect(save).not.toHaveAttribute('aria-busy', 'true');

    // Declining saves nothing.
    const asked = new Promise<string>((resolve) =>
      page.once('dialog', (dialog) => {
        const message = dialog.message();
        void dialog.dismiss().then(() => resolve(message));
      })
    );
    await save.click();
    const question = await asked;
    expect(question).toContain('sessions older than SESSION_TTL are deleted completely');
    expect(question).toContain('only POST /api/session/revoke with the session ID still can');
    expect(writes).toEqual([]);

    page.once('dialog', (dialog) => void dialog.accept());
    await save.click();
    await expect(page.getByText('Session configuration saved successfully')).toBeVisible();
    expect(writes).toHaveLength(1);
  });
});

test('names the sessions Delete Selected removes and says which are still pending', async ({
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
  await row.getByRole('checkbox').click();

  const asked = new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      const message = dialog.message();
      void dialog.dismiss().then(() => resolve(message));
    })
  );
  await page.getByRole('button', { name: 'Delete Selected' }).click();
  const question = await asked;

  expect(question).toContain('Delete 1 session?');
  expect(question).toContain(`• ${session}`);
  expect(question).toContain('It is still pending');
  // A presentation session issues no credentials.
  expect(question).not.toContain('revoke');
  // Declining deletes nothing: the list, loaded again, still has the session.
  await page.reload();
  await page.getByRole('searchbox', { name: /Search sessions/ }).fill(session);
  await expect(row).toHaveCount(1);
});
