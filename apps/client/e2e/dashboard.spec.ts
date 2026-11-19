import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

test.beforeEach(() => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
});

test('dashboard counts a new session and links to it', async ({ page }) => {
  await page.goto('/dashboard');
  // The window follows the tenant's retention, so the label names 7 days or 24 hours.
  const sessions = page.getByRole('link', { name: /Sessions ·/ }).locator('.stat-value');
  await expect(sessions).toHaveText(/^\s*\d+\s*$/);
  const before = Number(await sessions.textContent());

  await page.getByText('New Verification').click();
  await page.getByRole('combobox', { name: 'Verification Config' }).click();
  await page.getByRole('option', { name: 'pid', exact: true }).click();
  await page.getByRole('button', { name: 'Generate Request' }).click();
  await expect(page).toHaveURL(/\/session-management\/[^/]+$/);

  await page.goto('/dashboard');
  // Other tests may add sessions at the same time, so count at least this one.
  await expect.poll(async () => Number(await sessions.textContent())).toBeGreaterThan(before);

  // Parallel tests can push this session out of the five shown, so open the newest one.
  const newest = page.locator('.activity-row').first();
  await expect(newest).toHaveAttribute('href', /^\/session-management\/[^/]+$/);
  const newestPath = await newest.getAttribute('href');
  await newest.click();
  await expect(page).toHaveURL(newestPath!);
});

test('dashboard figures open the session list with their filters', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('link', { name: /Pending sessions/ }).click();
  await expect(page).toHaveURL(/\/session-management\?status=active&status=fetched$/);
  // The list shows "Clear Filters" only when it applied filters from the URL.
  await expect(page.getByRole('button', { name: /Clear Filters/ })).toBeVisible();

  await page.goto('/dashboard');
  // The link gets its date filter once the activity window has loaded.
  const failed = page.getByRole('link', { name: /Failed ·/ });
  await expect(failed.locator('.stat-value')).toHaveText(/^\s*\d+\s*$/);
  await failed.click();
  // The list keeps the filters in the URL, in its own order.
  await expect(page).toHaveURL(/\/session-management\?.*status=failed/);
  expect(new URL(page.url()).searchParams.get('createdFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByRole('button', { name: /Clear Filters/ })).toBeVisible();
});

test('keeps the activity data table for screen readers only', async ({ page }) => {
  await page.goto('/dashboard');
  const table = page.getByRole('table', { name: /Sessions per (day|hour) by outcome/ });
  // A table grows past the 1px box of .visually-hidden, so the clip is what hides it.
  await expect(table).toHaveCSS('position', 'absolute');
  await expect(table).toHaveCSS('clip', 'rect(0px, 0px, 0px, 0px)');
});

test("help menu opens the instance's API reference", async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Help and resources' }).click();

  const link = page.getByRole('menuitem', { name: /API reference of this instance/ });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/api\/docs$/);
  expect((await page.request.get(href!)).ok()).toBe(true);
});
