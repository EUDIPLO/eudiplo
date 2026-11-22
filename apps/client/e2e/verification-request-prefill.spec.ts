import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

// New Verification opened from a verification config's page, and Recreate Request on the session
// it created: both preselect the configuration, and neither generates a request before Generate
// Request is chosen, so Back or a reload never creates one again.

/** Records the requests that create a verification request. */
function recordRequestCreation(page: Page): string[] {
  const created: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/verifier/offer') {
      created.push(request.postData() ?? '');
    }
  });
  return created;
}

test.beforeEach(() => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
});

test('preselects the config it was opened from and generates only on Generate Request, also when recreated', async ({
  page,
}) => {
  const created = recordRequestCreation(page);
  await page.goto('/presentation-config/pid');
  // The page's link, not the navigation entry of the same name
  await page.locator('.hero-actions').getByRole('link', { name: 'New Verification' }).click();

  await expect(page).toHaveURL(/\/offer\/presentation\/pid$/);
  const config = page.getByRole('combobox', { name: 'Verification Config' });
  await expect(config).toHaveText('pid');
  const generate = page.getByRole('button', { name: 'Generate Request' });
  // The readiness check has run, and still nothing was generated.
  await expect(generate).not.toHaveAttribute('aria-disabled', 'true');
  expect(created).toEqual([]);

  await generate.click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  expect(created).toHaveLength(1);
  expect(JSON.parse(created[0])).toMatchObject({ requestId: 'pid' });

  // Recreate Request opens the form with the same configuration, again without generating.
  await page.getByRole('button', { name: 'Recreate Request' }).click();
  await expect(page).toHaveURL(/\/offer\/presentation$/);
  await expect(config).toHaveText('pid');
  await expect(generate).not.toHaveAttribute('aria-disabled', 'true');
  expect(created).toHaveLength(1);

  await generate.click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  expect(created).toHaveLength(2);
  expect(JSON.parse(created[1])).toMatchObject({ requestId: 'pid' });
});
