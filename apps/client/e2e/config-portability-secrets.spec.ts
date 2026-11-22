import { createHash, randomBytes } from 'node:crypto';
import type { Dialog, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// Config Portability shows the secrets an import generated for "secret": "!generate" only once,
// so leaving the page while they are shown asks first; declining keeps them, Done ends the
// question.

test.use({ storageState: { cookies: [], origins: [] } });

const leaveQuestion =
  'Leave this page? The generated secrets cannot be shown again; download or copy them first.';

/** A JSON bundle with one client document whose secret the import generates. */
function clientBundle(tenantId: string, clientId: string) {
  const document = {
    $schema: 'https://eudiplo.dev/schemas/v2/ClientConfigFile.schema.json',
    metadata: { generation: 1 },
    spec: {
      clientId,
      secret: '!generate',
      description: 'Generated secret',
      roles: ['issuance:offer'],
    },
  };
  return {
    manifest: {
      format: 'eudiplo.config-bundle',
      formatVersion: 2,
      sourceVersion: 'e2e',
      exportedAt: new Date(0).toISOString(),
      tenant: tenantId,
      resources: [
        {
          kind: 'Client',
          id: clientId,
          $schema: document.$schema,
          path: `clients/${clientId}.json`,
          sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
          ownership: 'unmanaged',
          generation: 1,
        },
      ],
      assets: [],
      requirements: [],
      warnings: [],
    },
    documents: [document],
    assets: [],
  };
}

/** Leaves the page through the navigation and answers the question; returns it. */
async function leaveTo(page: Page, entry: string, accept: boolean): Promise<string> {
  const asked = page.waitForEvent('dialog');
  const click = page.locator('mat-sidenav').getByRole('link', { name: entry }).click();
  const dialog: Dialog = await asked;
  const message = dialog.message();
  await (accept ? dialog.accept() : dialog.dismiss());
  await click;
  return message;
}

test('asks before generated secrets are left behind, and not once they are dismissed', async ({
  page,
}) => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant for the import.'
  );
  const tenant = await createTenant('portability-secrets', 'Generated Secrets', ['tenant:admin']);
  const clientId = `generated-${randomBytes(4).toString('hex')}`;
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/settings/config-portability');
  await expect(page.getByRole('heading', { name: 'Configuration Portability' })).toBeVisible();

  await page.locator('#bundleInput').setInputFiles({
    name: 'client-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(clientBundle(tenant.id, clientId))),
  });
  await page.getByRole('button', { name: 'Plan and validate' }).click();
  await expect(page.getByText('Ready to apply')).toBeVisible();
  await page.getByRole('button', { name: 'Apply bundle' }).click();

  const secrets = page.locator('.generated-secrets');
  await expect(secrets.getByRole('heading', { name: 'Generated client secrets' })).toBeVisible();
  await expect(secrets).toContainText(clientId);

  // Declining keeps the page and the secrets.
  expect(await leaveTo(page, 'Dashboard', false)).toBe(leaveQuestion);
  await expect(page).toHaveURL(/\/settings\/config-portability$/);
  await expect(secrets).toContainText(clientId);

  // Once removed with Done, which asks too, the page is left without a question.
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      'Remove the generated secrets from this page? They cannot be shown again; download or copy them first.'
    );
    void dialog.accept();
  });
  await secrets.getByRole('button', { name: 'Done' }).click();
  await expect(secrets).toHaveCount(0);
  const dialogs: string[] = [];
  const recordDialog = (dialog: Dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  };
  page.on('dialog', recordDialog);
  await page.locator('mat-sidenav').getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  page.off('dialog', recordDialog);
  expect(dialogs).toEqual([]);
});
