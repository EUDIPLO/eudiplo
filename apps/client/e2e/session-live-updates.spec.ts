import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';

// A pending session's page polls it. It says when the polls fail and when they stopped at their
// time limit, and Refresh follows the session again.

test.beforeEach(() => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
});

/** A new pending presentation session of the demo tenant. */
async function pendingSession(request: APIRequestContext): Promise<string> {
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
  return ((await offer.json()) as { session: string }).session;
}

test('says when updates fail and when they paused, and Refresh follows the session again', async ({
  page,
  request,
}) => {
  const session = await pendingSession(request);
  await page.clock.install();
  await page.goto(`/session-management/${session}`);
  // One status region holds the indicator, so a change of its text is announced.
  const indicator = page.locator('.hero-meta [role="status"]');
  await expect(indicator).toContainText('Live updates');

  // The backend does not answer the next polls.
  let down = true;
  await page.route(`**/api/session/${session}`, (route) =>
    down && route.request().method() === 'GET'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 503, message: 'Unavailable' }),
        })
      : route.fallback()
  );
  await page.clock.fastForward(3_000);
  await expect(indicator).toContainText('Updates failing: Unavailable. Retrying.');

  down = false;
  await page.clock.fastForward(3_000);
  await expect(indicator).toContainText('Live updates');

  // Polling stops after five minutes; the page says so instead of looking live.
  await page.clock.fastForward('05:05');
  await expect(indicator).toContainText('Updates paused: the status may be out of date.');

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(indicator).toContainText('Live updates');
});
