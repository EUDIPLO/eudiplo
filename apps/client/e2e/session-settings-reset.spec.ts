import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest } from './support/tenants';

// Reset to Defaults in Session Settings: it names the stored TTL and cleanup mode it removes,
// sends nothing when declined, and after the reset the tenant follows the global defaults.

test.use({ storageState: { cookies: [], origins: [] } });

/** Records the requests that change the session settings. */
function recordSettingsWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().endsWith('/api/session-config')) {
      writes.push(request.method());
    }
  });
  return writes;
}

test('resets stored session settings to the global defaults after asking', async ({ page }) => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  const tenant = await createTenant('session-reset', 'Session Reset', ['presentation:manage']);
  const stored = await tenantRequest(tenant, 'PUT', '/session-config', {
    ttlSeconds: 86_400,
    cleanupMode: 'anonymize',
  });
  expect(stored.ok, await stored.clone().text()).toBe(true);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/session-management/config');
  await expect(page.getByRole('heading', { name: 'Session Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'TTL in seconds' })).toHaveValue('86400');
  const writes = recordSettingsWrites(page);
  const reset = page.getByRole('button', { name: 'Reset to Defaults' });
  await expect(reset).not.toHaveAttribute('aria-disabled', 'true');
  await expect(reset).not.toHaveAttribute('aria-busy', 'true');

  // Declined: nothing is sent and the stored values stay.
  const declined = page.waitForEvent('dialog');
  const firstClick = reset.click();
  const question = await declined;
  expect(question.message()).toMatch(
    /^Reset the session settings to the global defaults of this instance\? This removes the TTL of .+ and the cleanup mode "Anonymize"\./
  );
  expect(question.message()).toContain('This cannot be undone.');
  await question.dismiss();
  await firstClick;
  expect(writes).toEqual([]);
  await expect(page.getByRole('spinbutton', { name: 'TTL in seconds' })).toHaveValue('86400');

  page.once('dialog', (dialog) => void dialog.accept());
  await reset.click();
  await expect(page.getByText('Session configuration reset to defaults')).toBeVisible();
  expect(writes).toEqual(['DELETE']);
  await expect(page.getByText('This tenant already follows the global defaults.')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'TTL in seconds' })).toHaveValue('');
  // Nothing is stored any more, so Reset to Defaults has nothing to reset.
  await expect(reset).toHaveAttribute('aria-disabled', 'true');

  // Without stored settings the backend answers without a body.
  const after = await tenantRequest(tenant, 'GET', '/session-config');
  expect(after.ok).toBe(true);
  const body = await after.text();
  const config = (body ? JSON.parse(body) : {}) as {
    ttlSeconds?: number | null;
    cleanupMode?: string | null;
  };
  expect(config.ttlSeconds ?? null).toBeNull();
  expect(config.cleanupMode ?? null).toBeNull();
});
