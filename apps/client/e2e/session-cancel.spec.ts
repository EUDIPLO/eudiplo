import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { tenantToken } from './support/clients';

// Cancel Offer and Cancel Request on the session page, and Cancel Selected on the session list:
// each asks with the reason dialog and sends the reason with every cancellation. The confirm
// button is matched by its start, "Cancel …", since it names what it cancels.

const api = resolvedE2EConfig.apiBaseUrl;

async function createOffer(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${api}/api/issuer/offer`, {
    headers: { Authorization: `Bearer ${await tenantToken(request)}` },
    data: {
      response_type: 'uri',
      credentialConfigurationIds: ['pid-mdoc'],
      flow: 'pre_authorized_code',
    },
  });
  expect(response.ok(), `create an issuance offer: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { session: string }).session;
}

async function createRequest(request: APIRequestContext, reference?: string): Promise<string> {
  const response = await request.post(`${api}/api/verifier/offer`, {
    headers: { Authorization: `Bearer ${await tenantToken(request)}` },
    data: { response_type: 'uri', requestId: 'pid', reference },
  });
  expect(response.ok(), `create a verification request: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { session: string }).session;
}

/** Records the reasons sent with each cancellation, by session ID. */
function recordCancellations(page: Page): Map<string, unknown> {
  const cancelled = new Map<string, unknown>();
  page.on('request', (request) => {
    const match = /\/api\/session\/([^/]+)\/cancel$/.exec(new URL(request.url()).pathname);
    if (request.method() === 'POST' && match) {
      cancelled.set(match[1], request.postDataJSON()?.reason);
    }
  });
  return cancelled;
}

/** Enters a reason in the open cancel dialog and confirms it. */
async function confirmWithReason(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Reason (optional)' }).fill(reason);
  await dialog.getByRole('button', { name: /^Cancel / }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeEach(() => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
});

test('cancels an issuance offer from its page with a reason', async ({ page, request }) => {
  const session = await createOffer(request);
  const cancelled = recordCancellations(page);
  await page.goto(`/session-management/${session}`);

  await page.getByRole('button', { name: 'Cancel Offer' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Cancel offer?');
  await confirmWithReason(page, 'sent to the wrong recipient');

  await expect(page.getByText('Offer cancelled')).toBeVisible();
  expect(cancelled.get(session)).toBe('sent to the wrong recipient');
  await expect(page.getByRole('heading', { name: 'Session cancelled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Offer' })).toHaveCount(0);
});

test('cancels a verification request from its page; Back sends nothing', async ({
  page,
  request,
}) => {
  const session = await createRequest(request);
  const cancelled = recordCancellations(page);
  await page.goto(`/session-management/${session}`);

  const cancel = page.getByRole('button', { name: 'Cancel Request' });
  await cancel.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(cancelled.size).toBe(0);

  await cancel.click();
  await confirmWithReason(page, 'customer left');

  await expect(page.getByText('Request cancelled')).toBeVisible();
  expect(cancelled.get(session)).toBe('customer left');
  await expect(page.getByRole('heading', { name: 'Session cancelled' })).toBeVisible();
});

test('cancels the selected sessions with one reason', async ({ page, request }) => {
  // A reference of this run, so the search lists exactly these two requests.
  const reference = `cancel-selected-${randomBytes(4).toString('hex')}`;
  const sessions = [
    await createRequest(request, reference),
    await createRequest(request, reference),
  ];
  const cancelled = recordCancellations(page);
  await page.goto('/session-management');
  await page.getByRole('searchbox', { name: /Search sessions/ }).fill(reference);
  const rows = page.locator('tr.session-row');
  await expect(rows).toHaveCount(2);

  for (const session of sessions) {
    await page.locator('tr.session-row', { hasText: session }).getByRole('checkbox').click();
  }
  await page.getByRole('button', { name: 'Cancel Selected' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(/^Cancel 2 \w+\?$/);
  await confirmWithReason(page, 'campaign ended');

  await expect.poll(() => [...cancelled.keys()].sort()).toEqual([...sessions].sort());
  expect([...cancelled.values()]).toEqual(['campaign ended', 'campaign ended']);
  for (const session of sessions) {
    const response = await request.get(`${api}/api/session/${session}`, {
      headers: { Authorization: `Bearer ${await tenantToken(request)}` },
    });
    expect(((await response.json()) as { status: string }).status).toBe('cancelled');
  }
});
