import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

test.skip(
  !hasAuthCredentials,
  'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
);

// Moves the focus with Tab, as a keyboard user does, until the side navigation
// link with this name has it.
async function tabToNavLink(page: Page, name: string) {
  const link = page.locator('mat-sidenav').getByRole('link', { name, exact: true });
  await expect(link).toBeAttached();
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Tab');
    if (await link.evaluate((el) => el === document.activeElement)) {
      return link;
    }
  }
  throw new Error(`Tab never reached the "${name}" navigation link`);
}

test('a collapsed navigation section stays collapsed until the user needs it', async ({ page }) => {
  await page.goto('/dashboard');
  const header = page.getByRole('button', { name: 'Credential Issuance' });
  const entry = page.locator('mat-sidenav').getByText('Credential Configs', { exact: true });
  await expect(entry).toBeVisible();

  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(entry).toBeHidden();

  await page.reload();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(entry).toBeHidden();

  // A page of the section shows it, and it stays open when the user moves on, so the
  // entries below do not move; the saved choice applies again after a reload.
  await page.goto('/credential-config');
  await expect(entry).toBeVisible();
  await page.getByText('Dashboard', { exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(entry).toBeVisible();
  await page.reload();
  await expect(entry).toBeHidden();

  await header.focus();
  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(entry).toBeVisible();
});

test('the skip link moves keyboard focus past the navigation to the page content', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  // Hidden, the link is a 1x1 box, which toBeVisible() would also accept.
  const width = async () => (await skipLink.boundingBox())?.width ?? 0;
  expect(await width()).toBeLessThanOrEqual(1);

  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect.poll(width).toBeGreaterThan(1);

  await page.keyboard.press('Enter');
  await expect(main).toBeFocused();
  await expect(page).toHaveURL(/\/dashboard$/);

  // The next Tab stays in the page content instead of returning to the toolbar.
  await page.keyboard.press('Tab');
  await expect(main.locator(':focus')).toHaveCount(1);
});

test('opens an entry with Enter', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('mat-sidenav')).toBeVisible();

  const link = await tabToNavLink(page, 'Keys');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/keys$/);
  await expect(link).toHaveClass(/active-link/);
  await expect(link).toHaveAttribute('aria-current', 'page');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the menu button opens and closes the navigation', async ({ page }) => {
    await page.goto('/dashboard');
    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    const navigation = page.getByRole('navigation');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(navigation).toBeVisible();

    // The open drawer takes focus, and Escape closes it from there.
    await expect(navigation.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeFocused();

    // The button follows the drawer at once, so a tap while it still slides away reopens it.
    await toggle.click();
    await expect(navigation.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await toggle.click();
    await expect(navigation.locator(':focus')).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await navigation.getByText('Credential Configs', { exact: true }).click();
    await expect(page).toHaveURL(/\/credential-config$/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();
  });

  test('an entry opened with Enter closes the navigation', async ({ page }) => {
    await page.goto('/dashboard');
    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    const navigation = page.getByRole('navigation');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    // The drawer focuses its first link once it has opened; tabbing before that races it.
    await expect(navigation.getByRole('link', { name: 'Dashboard', exact: true })).toBeFocused();
    await tabToNavLink(page, 'Keys');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/keys$/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();
  });
});

test('the menu button brings the navigation back after the window widens', async ({ page }) => {
  // A portrait tablet keeps the navigation beside the content, and the user collapses it there.
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto('/dashboard');
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  const navigation = page.getByRole('navigation');
  await expect(navigation).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toBeHidden();

  // The layout stays the same when the window widens, so the button is the way back.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation).toBeVisible();
});
