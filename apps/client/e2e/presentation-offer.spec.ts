import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { tenantToken, writeConfig } from './support/clients';

async function selectPidPresentationConfig(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByText('New Verification').click();
  await page.getByRole('combobox', { name: 'Presentation Configuration' }).click();
  await page.getByRole('option', { name: 'pid', exact: true }).click();
}

test('presentation offer page is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await selectPidPresentationConfig(page);
  await page.getByRole('button', { name: 'Generate Request' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  await expect(page.getByText('Presentation Request QR Code')).toBeVisible();
});

test.describe('presentation offer with dc api', () => {
  const configId = `e2e-dc-api-${Date.now()}`;
  const pageOrigin = new URL(resolvedE2EConfig.baseURL).origin;

  async function api(
    request: APIRequestContext,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    data?: unknown
  ) {
    const token = await tenantToken(request);
    return request.fetch(`${resolvedE2EConfig.apiBaseUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      data,
    });
  }

  test.beforeAll(async ({ request }) => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
    // A configuration whose allowed origins leave out this page.
    const pid = await (await api(request, 'GET', '/verifier/config/pid')).json();
    await writeConfig(
      () =>
        api(request, 'POST', '/verifier/config', {
          id: configId,
          description: 'DC API from another site only',
          dcql_query: pid.dcql_query,
          allowedOrigins: ['https://shop.example'],
        }),
      'create DC API presentation config'
    );
  });

  test.afterAll(async ({ request }) => {
    if (!hasAuthCredentials) return;
    await writeConfig(
      () => api(request, 'DELETE', `/verifier/config/${configId}`),
      'delete DC API presentation config'
    );
  });

  test('creates a request bound to this page for an unrestricted configuration', async ({
    page,
  }) => {
    await selectPidPresentationConfig(page);
    await page.getByRole('switch', { name: 'Use DC-API instead of QR-Code' }).click();
    await page.getByRole('button', { name: 'Generate Request' }).click();
    await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
    await expect(page.getByRole('button', { name: 'DC API' })).toBeVisible();
  });

  test('names this page for a configuration that does not list it', async ({ page }) => {
    await page.goto('/');
    await page.getByText('New Verification').click();
    await page.getByRole('combobox', { name: 'Presentation Configuration' }).click();
    await page.getByRole('option', { name: configId, exact: true }).click();
    await page.getByRole('switch', { name: 'Use DC-API instead of QR-Code' }).click();
    await expect(page.getByRole('status')).toContainText(
      `does not list this page's origin, ${pageOrigin}`
    );
    await expect(page.getByRole('button', { name: 'Generate Request' })).toBeDisabled();
  });
});
