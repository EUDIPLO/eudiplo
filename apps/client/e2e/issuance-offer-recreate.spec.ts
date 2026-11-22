import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

// New Issuance: a failed load says why and loads on Retry instead of showing a form without
// credential configs; Recreate Offer on a session opens the form with the same offer, which is
// sent again only on Generate Offer.

/** Records the bodies of the requests that create an issuance offer. */
function recordOfferCreation(page: Page): Record<string, unknown>[] {
  const created: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/issuer/offer') {
      created.push(request.postDataJSON() as Record<string, unknown>);
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

test('says why the issuance form could not be loaded and loads it on Retry', async ({ page }) => {
  let refuse = true;
  await page.route('**/api/issuer/credentials', (route) =>
    refuse
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }),
        })
      : route.fallback()
  );
  await page.goto('/offer/issuance');

  const error = page.locator('app-load-error');
  await expect(error.getByRole('alert')).toContainText(
    'Failed to load the credential configs and issuer settings: Service Unavailable'
  );
  await expect(page.getByText('No credential configs available')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Choose Issuance Flow Type' })).toHaveCount(0);

  refuse = false;
  await error.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Choose Issuance Flow Type' })).toBeVisible();
  await expect(error).toHaveCount(0);
  // The focused Retry went with its card, so the page heading takes the focus.
  await expect(page.getByRole('heading', { name: 'Generate Issuance Offer' })).toBeFocused();
});

test('recreates an offer with the same parameters, sent only on Generate Offer', async ({
  page,
}) => {
  const created = recordOfferCreation(page);
  await page.goto('/offer/issuance');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Credential Config IDs' }).fill('pid-mdoc');
  await page.getByRole('option', { name: /^pid-mdoc(\s|$)/ }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Use Pre-configured Default Values' }).click();
  await page.getByRole('button', { name: 'Generate Offer' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  expect(created).toHaveLength(1);

  await page.getByRole('button', { name: 'Recreate Offer' }).click();
  await expect(page).toHaveURL(/\/offer\/issuance$/);
  // The form opens on its last step, filled from the session's offer.
  const generate = page.getByRole('button', { name: 'Generate Offer' });
  await expect(generate).toBeVisible();
  expect(created).toHaveLength(1);

  await generate.click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
  expect(created).toHaveLength(2);
  expect(created[1]['credentialConfigurationIds']).toEqual(['pid-mdoc']);
  expect(created[1]['flow']).toBe(created[0]['flow']);
  expect(created[1]['credentialClaims']).toEqual(created[0]['credentialClaims']);
});
