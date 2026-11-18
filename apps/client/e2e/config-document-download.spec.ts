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
