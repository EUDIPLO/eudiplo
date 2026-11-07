import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';

// JSON View edits the loaded resource of an edit screen. After a failed load its button stays
// focusable, says why it does nothing and opens nothing; once a retry loads the resource, it
// opens as usual. Each screen's load is made to fail, so the resources need not exist; the
// retry runs on the demo tenant's "age-over-18" presentation configuration.

const screens = [
  {
    noun: 'presentation configuration',
    path: '/presentation-config/age-over-18/edit',
    api: '/api/verifier/config/age-over-18',
  },
  {
    noun: 'credential configuration',
    path: '/credential-config/e2e-missing/edit',
    api: '/api/issuer/credentials/e2e-missing',
  },
  {
    noun: 'webhook endpoint',
    path: '/webhook-endpoints/e2e-missing/edit',
    api: '/api/issuer/webhook-endpoints/e2e-missing',
  },
  {
    noun: 'attribute provider',
    path: '/attribute-providers/e2e-missing/edit',
    api: '/api/issuer/attribute-providers/e2e-missing',
  },
];

/** Fails the screen's load until `fail.value` is set to false. */
async function failLoad(page: Page, api: string, fail: { value: boolean }) {
  await page.route(
    (url) => url.pathname === api,
    (route) =>
      fail.value && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: { statusCode: 500, message: 'Unavailable' } })
        : route.fallback()
  );
}

for (const { noun, path, api } of screens) {
  test(`JSON View says why it waits after the ${noun} failed to load`, async ({ page }) => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
    await failLoad(page, api, { value: true });
    await page.goto(path);

    await expect(page.getByRole('alert').filter({ hasText: 'Unavailable' })).toBeVisible();
    const jsonView = page.getByRole('button', { name: 'JSON View' });
    await expect(jsonView).toHaveAttribute('aria-disabled', 'true');
    await expect(jsonView).toHaveAccessibleDescription(
      `Retry loading the ${noun} before opening JSON View`
    );
    await jsonView.focus();
    await expect(jsonView).toBeFocused();
    await page.keyboard.press('Enter');
    // MatDialog attaches its container while the click runs, before the dialog role is rendered.
    await expect(page.locator('mat-dialog-container')).toHaveCount(0);
  });
}

test('JSON View opens once a retry has loaded the presentation configuration', async ({ page }) => {
  test.skip(!resolvedE2EConfig.useBuild, 'Needs the demo tenant and test-client (E2E_USE_BUILD).');
  const [{ path, api }] = screens;
  const fail = { value: true };
  await failLoad(page, api, fail);
  await page.goto(path);

  const alert = page.getByRole('alert').filter({ hasText: 'Unavailable' });
  await expect(alert).toBeVisible();
  const jsonView = page.getByRole('button', { name: 'JSON View' });
  await expect(jsonView).toHaveAttribute('aria-disabled', 'true');
  fail.value = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();

  await expect(alert).toHaveCount(0);
  await expect(jsonView).not.toHaveAttribute('aria-disabled', 'true');
  await expect(jsonView).toHaveAccessibleDescription('View/Edit as JSON');
  await jsonView.click();
  await expect(
    page.getByRole('dialog').filter({ hasText: 'Presentation Configuration JSON' })
  ).toBeVisible();
});
