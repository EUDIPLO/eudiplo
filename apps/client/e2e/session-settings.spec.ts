import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest } from './support/tenants';

// Saves the Session Settings of a tenant in a browser, and checks that Enter in a field of a
// file-managed tenant's settings sends nothing: the form is locked by the click guard on Save,
// which an implicit submission also passes through.

/** Collects the writes of the Session Settings page. */
function recordSettingsWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().endsWith('/api/session-config')) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  return writes;
}

test.describe('a tenant of its own', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('saves a TTL from a preset and a cleanup mode', async ({ page }) => {
    test.skip(
      !hasRootCredentials,
      'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
    );
    const tenant = await createTenant('session-settings', 'Session Settings', [
      'presentation:manage',
    ]);
    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    await page.goto('/session-management/config');
    await expect(page.getByRole('heading', { name: 'Session Settings', level: 1 })).toBeVisible();
    await expect(page.getByText('This tenant already follows the global defaults.')).toBeVisible();

    const ttl = page.getByRole('spinbutton', { name: 'TTL in seconds' });
    const preset = page.getByRole('group', { name: 'TTL presets' });
    await preset.getByRole('button', { name: '24 hours' }).click();
    await expect(ttl).toHaveValue('86400');
    await expect(preset.getByRole('button', { name: '24 hours' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(preset.getByRole('button', { name: 'Use default' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await page.getByRole('combobox', { name: 'Cleanup mode' }).click();
    await page.getByRole('option', { name: /^Anonymize/ }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    const writes = recordSettingsWrites(page);
    const save = page.getByRole('button', { name: 'Save Configuration' });
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
    await save.click();
    await expect(page.getByText('Session configuration saved successfully')).toBeVisible();
    expect(writes).toHaveLength(1);

    const inEffect = page.getByRole('region', { name: 'In effect' });
    await expect(inEffect.getByText('1 day')).toBeVisible();
    await expect(inEffect.getByText(/^Anonymize/)).toBeVisible();
    await expect(page.getByText('No changes')).toBeVisible();

    const stored = await tenantRequest(tenant, 'GET', '/session-config');
    expect(await stored.json()).toMatchObject({ ttlSeconds: 86400, cleanupMode: 'anonymize' });

    // Enter in a field saves too, as the locked test below relies on.
    await ttl.fill('3600');
    await ttl.press('Enter');
    await expect(inEffect.getByText('1 hour')).toBeVisible();
    expect(writes).toHaveLength(2);

    // A reload shows what was saved.
    await page.reload();
    await expect(ttl).toHaveValue('3600');
    await expect(page.getByRole('combobox', { name: 'Cleanup mode' })).toHaveText(/Anonymize/);
  });
});

test('Enter in a field of a file-managed tenant sends nothing', async ({ page }) => {
  // Build mode imports the demo tenant from files and signs in with its
  // test-client, which has the manage roles but not tenant:admin.
  test.skip(!resolvedE2EConfig.useBuild, 'Needs the demo tenant and test-client (E2E_USE_BUILD).');

  await page.goto('/session-management/config');
  await expect(page.getByText('Managed by a configuration bundle')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save Configuration' });
  await expect(save).toHaveAttribute('aria-disabled', 'true');

  const ttl = page.getByRole('spinbutton', { name: 'TTL in seconds' });
  await ttl.fill('7200');
  const sent = page.waitForRequest(
    (request) => request.method() !== 'GET' && request.url().endsWith('/api/session-config'),
    { timeout: 2_000 }
  );
  await ttl.press('Enter');
  // No write within two seconds.
  await expect(sent).rejects.toThrow();
  await expect(page.getByText('Session configuration saved successfully')).toHaveCount(0);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
});
