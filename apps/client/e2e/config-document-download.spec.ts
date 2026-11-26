import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';
import { createKeyChain } from './support/key-chains';
import { createTrustList } from './support/trust-lists';

// "Download configuration" on a detail page saves the resource as a configuration document
// ($schema and spec), the file format of the config folder, so the file imports again
// without changes. Each test gets its own tenant.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

interface ConfigDocument {
  $schema: string;
  metadata?: { generation?: number };
  spec: Record<string, unknown>;
}

/** A JSON bundle with one webhook endpoint document. */
function webhookBundle(tenantId: string, document: ConfigDocument) {
  const id = String(document.spec['id']);
  return {
    manifest: {
      format: 'eudiplo.config-bundle',
      formatVersion: 2,
      sourceVersion: 'e2e',
      exportedAt: new Date(0).toISOString(),
      tenant: tenantId,
      resources: [
        {
          kind: 'WebhookEndpoint',
          id,
          $schema: document.$schema,
          path: `webhook-endpoints/${id}.json`,
          sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
          ownership: 'unmanaged',
          generation: document.metadata?.generation ?? 1,
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

test.beforeEach(() => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
});

/** Plans the downloaded file on the import screen, which takes it as it is. */
async function expectImportsUnchanged(page: Page, file: string) {
  await page.goto('/settings/config-portability');
  await page.locator('#bundleInput').setInputFiles(file);
  await page.getByRole('button', { name: 'Plan and validate' }).click();
  await expect(page.getByText('Ready to apply')).toBeVisible();
  await expect(page.locator('td.mat-column-action').filter({ hasText: 'unchanged' })).toHaveCount(
    1
  );
}

test('downloads a webhook endpoint as a document that imports unchanged', async ({ page }) => {
  const tenant = await createTenant('document-download-e2e', 'Document Download E2E', [
    'tenant:admin',
    'issuance:manage',
  ]);
  const headers = { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${api}/api/issuer/webhook-endpoints`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: 'notification',
      name: 'Notification Webhook',
      url: 'https://hooks.example.com/consume',
      auth: { type: 'none' },
    }),
  });
  expect(created.status, await created.text()).toBe(201);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/webhook-endpoints/notification');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download configuration' }).click();
  const download = await downloading;

  expect(download.suggestedFilename()).toBe('notification.json');
  const document = JSON.parse(await readFile(await download.path(), 'utf8')) as ConfigDocument;
  expect(document.$schema).toMatch(
    /^https:\/\/eudiplo\.dev\/schemas\/v\d+\/WebhookEndpointConfigFile\.schema\.json$/
  );
  expect(document.spec).toMatchObject({
    id: 'notification',
    name: 'Notification Webhook',
    url: 'https://hooks.example.com/consume',
  });
  await expect(page.getByText('Configuration downloaded')).toBeVisible();

  await expectImportsUnchanged(page, await download.path());

  const plan = await fetch(`${api}/api/config-bundles/plan?mode=upsert`, {
    method: 'POST',
    headers,
    body: JSON.stringify(webhookBundle(tenant.id, document)),
  });
  expect(plan.status).toBe(201);
  expect((await plan.json()).items.map((item: { action: string }) => item.action)).toEqual([
    'unchanged',
  ]);
});

test('downloads a key chain with its private key as a document that imports unchanged', async ({
  page,
}) => {
  const tenant = await createTenant('key-download-e2e', 'Key Download E2E', [
    'tenant:admin',
    'issuance:manage',
  ]);
  const keyChainId = await createKeyChain(tenant.token, 'attestation', 'Download E2E');

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/keys/${keyChainId}`);
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download configuration (includes the private key)' })
    .click();
  const download = await downloading;

  expect(download.suggestedFilename()).toBe(`${keyChainId}.json`);
  const document = JSON.parse(await readFile(await download.path(), 'utf8')) as ConfigDocument;
  expect(document.$schema).toMatch(/\/KeyChainConfigFile\.schema\.json$/);
  expect(document.spec).toMatchObject({ id: keyChainId, keySource: { type: 'private-jwk' } });
  await expect(page.getByText('Configuration downloaded')).toBeVisible();

  await expectImportsUnchanged(page, await download.path());
});

test('downloads a trust list from the list as a document that imports unchanged', async ({
  page,
}) => {
  const tenant = await createTenant('trust-download-e2e', 'Trust Download E2E', [
    'tenant:admin',
    'issuance:manage',
  ]);
  const trustListId = 'members';
  await createTrustList(tenant.token, trustListId, 'Membership issuers');

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/trust-list');
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: `Download the configuration of trust list ${trustListId}` })
    .click();
  const download = await downloading;

  expect(download.suggestedFilename()).toBe(`${trustListId}.json`);
  const document = JSON.parse(await readFile(await download.path(), 'utf8')) as ConfigDocument;
  expect(document.$schema).toMatch(/\/TrustListConfigFile\.schema\.json$/);
  expect(document.spec).toMatchObject({ id: trustListId, description: 'Membership issuers' });
  await expect(page.getByText('Configuration downloaded')).toBeVisible();

  await expectImportsUnchanged(page, await download.path());
});

/** A new tenant with one webhook endpoint, its admin client signed in on the page. */
async function webhookTenant(page: Page, prefix: string, endpoint: Record<string, unknown>) {
  const tenant = await createTenant(prefix, 'Document Download E2E', [
    'tenant:admin',
    'issuance:manage',
  ]);
  const created = await fetch(`${api}/api/issuer/webhook-endpoints`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint),
  });
  expect(created.status, await created.text()).toBe(201);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
}

/** Downloads the configuration document of a webhook endpoint from its detail page. */
async function downloadWebhook(page: Page, id: string) {
  await page.goto(`/webhook-endpoints/${id}`);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download configuration' }).click();
  const path = await (await downloading).path();
  return { path, document: JSON.parse(await readFile(path, 'utf8')) as ConfigDocument };
}

test('downloads stored text with ${ in its escaped form, which imports unchanged', async ({
  page,
}) => {
  await webhookTenant(page, 'escaped-download-e2e', {
    id: 'escaped',
    name: 'Hook ${TEXT}',
    url: 'https://hooks.example.com/consume',
    auth: { type: 'none' },
  });

  const { path, document } = await downloadWebhook(page, 'escaped');

  expect(document.spec['name']).toBe('Hook $${TEXT}');
  // The escaped form is no placeholder: the plain message, with nothing to set.
  await expect(page.locator('mat-snack-bar-container')).toHaveText(
    /^\s*Configuration downloaded\s*Close\s*$/
  );

  // The upload reads `$${` back as `${`, the stored text, with no placeholder to warn about.
  await expectImportsUnchanged(page, path);
  await expect(page.locator('div.issue')).toHaveCount(0);
});

test('names the secret placeholders of a download until the snackbar is closed', async ({
  page,
}) => {
  await webhookTenant(page, 'secret-download-e2e', {
    id: 'secured',
    name: 'Secured Webhook',
    url: 'https://hooks.example.com/consume',
    auth: { type: 'apiKey', config: { headerName: 'X-Key', value: 'webhook-secret' } },
  });

  const { document } = await downloadWebhook(page, 'secured');

  const value = (document.spec['auth'] as { config: { value: string } }).config.value;
  const variable = /^\$\{(\w+)\}$/.exec(value)?.[1];
  expect(variable, `the secret is a placeholder, not ${value}`).toBeTruthy();
  expect(JSON.stringify(document)).not.toContain('webhook-secret');
  const snackBar = page.locator('mat-snack-bar-container');
  await expect(snackBar).toContainText(`placeholders (${variable})`);
  await expect(snackBar).toContainText('Config Portability');

  // Real time: page.clock, even installed before the first page, did not end a fixed duration.
  // Past the 3 s plain message, the 5 s minimum and 8 s, it is still there; the unit spec pins
  // `duration: 0`, which also rules out the longer fixed durations up to 15 s.
  await page.waitForTimeout(9000);
  expect(await snackBar.count()).toBe(1);
  await expect(snackBar).toContainText(`placeholders (${variable})`);
  await snackBar.getByRole('button', { name: 'Close' }).click();
  await expect(snackBar).toBeHidden();
});
