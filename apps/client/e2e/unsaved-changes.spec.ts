import type { Dialog } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// Leaving a form with unsaved changes asks first: within the client through the route's
// canDeactivate guard, and on a reload through the browser's own question. The webhook
// endpoint form stands for the other create and edit pages that use the same guard.

test.use({ storageState: { cookies: [], origins: [] } });

const leaveQuestion = 'Leave this page? Your unsaved changes will be lost.';

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('unsaved-changes', 'Unsaved Changes', ['issuance:manage']);
});

test('asks before unsaved changes are left behind and not after they were saved', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/webhook-endpoints/create');
  const name = page.getByRole('textbox', { name: 'Name' });

  // An untouched form is left without a question.
  const dialogs: Dialog[] = [];
  const recordDialog = (dialog: Dialog) => {
    dialogs.push(dialog);
    void dialog.dismiss();
  };
  page.on('dialog', recordDialog);
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/\/webhook-endpoints$/);
  expect(dialogs).toEqual([]);
  page.off('dialog', recordDialog);

  await page.goto('/webhook-endpoints/create');
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('draft-events');
  await name.fill('Draft events');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  // Declining keeps the page and what was typed.
  const declined = page.waitForEvent('dialog');
  const cancel = page.getByRole('link', { name: 'Cancel', exact: true }).click();
  const declinedDialog = await declined;
  expect(declinedDialog.message()).toBe(leaveQuestion);
  await declinedDialog.dismiss();
  await cancel;
  await expect(page).toHaveURL(/\/webhook-endpoints\/create$/);
  await expect(name).toHaveValue('Draft events');

  // Saving leaves the page without a question.
  await page.getByRole('textbox', { name: 'URL' }).fill('https://example.com/drafts');
  page.on('dialog', recordDialog);
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).not.toHaveAttribute('aria-busy', 'true');
  await create.click();
  await expect(page).toHaveURL(/\/webhook-endpoints\/draft-events$/);
  expect(dialogs).toEqual([]);
  page.off('dialog', recordDialog);

  // Agreeing leaves the page.
  await page.goto('/webhook-endpoints/draft-events/edit');
  await expect(name).toHaveValue('Draft events');
  await name.fill('Renamed events');
  const agreed = page.waitForEvent('dialog');
  const toList = page
    .locator('mat-sidenav')
    .getByText('Webhook Endpoints', { exact: true })
    .click();
  const agreedDialog = await agreed;
  expect(agreedDialog.message()).toBe(leaveQuestion);
  await agreedDialog.accept();
  await toList;
  await expect(page).toHaveURL(/\/webhook-endpoints$/);

  // Reloading, closing the tab or leaving for another site has the browser ask.
  await page.goto('/webhook-endpoints/draft-events/edit');
  await expect(name).toHaveValue('Draft events');
  await name.fill('Renamed events');
  const question = page.waitForEvent('dialog');
  const reload = page.reload();
  const dialog = await question;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.accept();
  await reload;
});
