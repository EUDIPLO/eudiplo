import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant as createTestTenant, type TestTenant } from './support/tenants';

// The import plan on the Config Portability screen against the real backend. A key chain
// document replaces the stored one, so a bundle without the description removes it: the plan
// lists the removal and the client asks before applying it. The other tests use a webhook
// endpoint document; imports do not call the webhook. Each test gets its own tenant whose
// admin client has tenant:admin.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

const endpointSpec = {
  id: 'events',
  name: 'Events',
  url: 'https://hooks.example.invalid/events',
  auth: { type: 'none' },
};

const fullSpec = {
  ...endpointSpec,
  description: 'Delivers presentation events',
  auth: { type: 'apiKey', config: { headerName: 'X-Key', value: 'webhook-secret' } },
};

/** A JSON bundle with one webhook endpoint document. */
function endpointBundle(tenantId: string, spec: Record<string, unknown>) {
  const document = {
    $schema: 'https://eudiplo.dev/schemas/v1/WebhookEndpointConfigFile.schema.json',
    metadata: { generation: 1 },
    spec,
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
          kind: 'WebhookEndpoint',
          id: 'events',
          $schema: document.$schema,
          path: 'webhook-endpoints/events.json',
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

/** The demo access key chain, a key with its certificate, under a new ID. */
function keyChainDocument(description?: string) {
  const demo = JSON.parse(
    readFileSync(join(__dirname, '../../../assets/config/demo/key-chains/access.json'), 'utf8')
  );
  const { description: _, ...spec } = demo.spec;
  return {
    $schema: demo.$schema as string,
    metadata: { generation: 1 },
    spec: { ...spec, id: randomUUID(), ...(description ? { description } : {}) },
  };
}

/** A JSON bundle with one key chain document. */
function keyChainBundle(tenantId: string, document: ReturnType<typeof keyChainDocument>) {
  return {
    manifest: {
      format: 'eudiplo.config-bundle',
      formatVersion: 2,
      sourceVersion: 'e2e',
      exportedAt: new Date(0).toISOString(),
      tenant: tenantId,
      resources: [
        {
          kind: 'KeyChain',
          id: document.spec.id,
          $schema: document.$schema,
          path: `key-chains/${document.spec.id}.json`,
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

/** A JSON bundle with the tenant's KMS configuration, which replaces the whole file. */
function kmsBundle(tenantId: string, spec: Record<string, unknown>) {
  const document = {
    $schema: 'https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json',
    metadata: { generation: 1 },
    spec,
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
          kind: 'KmsConfig',
          id: 'kms',
          $schema: document.$schema,
          path: 'kms.json',
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

interface Tenant extends TestTenant {
  /** Plans a bundle in upsert mode as the tenant's admin client. */
  plan(bundle: unknown): Promise<{ planFingerprint: string; items: { action: string }[] }>;
  /** Plans and imports a bundle in upsert mode as the tenant's admin client. */
  importBundle(bundle: unknown): Promise<void>;
}

/** A new tenant whose admin client may plan and apply configuration bundles. */
async function createTenant(): Promise<Tenant> {
  const tenant = await createTestTenant('portability-e2e', 'Config Portability E2E', [
    'tenant:admin',
  ]);
  const post = async (path: string, bundle: unknown) => {
    const result = await fetch(`${api}/api/config-bundles/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
    });
    expect(result.ok, `${path}: ${result.status}`).toBe(true);
    return result.json();
  };
  const plan = (bundle: unknown) => post('plan?mode=upsert', bundle);
  return {
    ...tenant,
    plan,
    importBundle: async (bundle) => {
      const { planFingerprint } = await plan(bundle);
      await post(`import?mode=upsert&planFingerprint=${planFingerprint}`, bundle);
    },
  };
}

async function openConfigPortability(page: Page, tenant: Tenant): Promise<void> {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/settings/config-portability');
  await expect(page.getByRole('heading', { name: 'Configuration Portability' })).toBeVisible();
}

async function planBundle(page: Page, bundle: unknown): Promise<void> {
  await page.locator('#bundleInput').setInputFiles({
    name: 'endpoint-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(page.getByText('endpoint-bundle.json')).toBeVisible();
  await page.getByRole('button', { name: 'Plan and validate' }).click();
  await expect(page.getByText('Ready to apply')).toBeVisible();
}

test.beforeEach(() => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant for the import.'
  );
});

test('lists the key chain values an upsert removes and asks before applying it', async ({
  page,
}) => {
  const tenant = await createTenant();
  const full = keyChainDocument('Access key');
  await tenant.importBundle(keyChainBundle(tenant.id, full));
  const { description: _, ...withoutDescription } = full.spec;
  const minimal = keyChainBundle(tenant.id, { ...full, spec: withoutDescription });
  await openConfigPortability(page, tenant);

  await planBundle(page, minimal);

  await expect(
    page.getByRole('heading', { name: `Changes to KeyChain/${full.spec.id}` })
  ).toBeVisible();
  const changes = page.locator('table.changes');
  await expect(changes.getByRole('row', { name: /\/spec\/description/ })).toHaveText(
    /"Access key"\s*.*removed/
  );
  // Secrets cannot be compared, so the key is listed, masked on both sides, and not removed.
  await expect(changes.getByRole('row', { name: /\/spec\/keySource/ })).toHaveText(
    /\/spec\/keySource\s*secret\s*secret/
  );
  await expect(changes.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText('2 fields, 1 removed')).toBeVisible();

  const apply = page.getByRole('button', { name: 'Apply bundle' });
  let imports = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/config-bundles/import')) imports++;
  });
  // The click returns once the confirmation is answered, so answer it from a listener.
  let question = '';
  page.once('dialog', (dialog) => {
    question = dialog.message();
    void dialog.dismiss();
  });
  await apply.click();
  expect(question).toContain(`KeyChain/${full.spec.id}`);

  page.once('dialog', (next) => void next.accept());
  await apply.click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  // Only the accepted confirmation sent the import.
  expect(imports).toBe(1);
  expect((await tenant.plan(minimal)).items[0].action).toBe('unchanged');
});

test('masks a secret the upsert removes and counts it among the removals', async ({ page }) => {
  const tenant = await createTenant();
  const db = { id: 'db', type: 'db' };
  const vault = {
    id: 'vault',
    type: 'vault',
    vaultUrl: 'https://vault.example.invalid',
    vaultToken: 'vault-secret',
  };
  await tenant.importBundle(kmsBundle(tenant.id, { providers: [db, vault] }));
  await openConfigPortability(page, tenant);

  await planBundle(page, kmsBundle(tenant.id, { providers: [db] }));

  await expect(page.getByRole('heading', { name: 'Changes to KmsConfig/kms' })).toBeVisible();
  const changes = page.locator('table.changes');
  // The token is shown as "secret", never as its value.
  await expect(changes.getByRole('row', { name: /vaultToken/ })).toHaveText(
    /vaultToken\s*secret\s*.*removed/
  );
  await expect(changes).not.toContainText('vault-secret');
  const rows = await changes.locator('tbody tr').count();
  expect(rows).toBeGreaterThan(1);
  await expect(page.getByText(`${rows} fields, ${rows} removed`)).toBeVisible();
});

test('applies an upsert without removals without asking', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(endpointBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });

  await planBundle(page, endpointBundle(tenant.id, { ...fullSpec, name: 'Other events' }));
  const row = page.locator('table.changes').getByRole('row', { name: /\/spec\/name/ });
  await expect(row).toHaveText(/"Events"\s*"Other events"/);
  await expect(page.getByText('1 field', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply bundle' }).click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  expect(asked).toBe(false);
});

test('names the resources a replace import deletes before applying it', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(endpointBundle(tenant.id, fullSpec));
  // The same source without the webhook endpoint: replace mode deletes it.
  const empty = endpointBundle(tenant.id, endpointSpec);
  empty.manifest.resources = [];
  empty.documents = [];
  await openConfigPortability(page, tenant);
  await page.getByRole('combobox', { name: 'Import mode' }).click();
  await page.getByRole('option', { name: 'Replace managed resources' }).click();

  await planBundle(page, empty);
  await expect(
    page.getByRole('row', { name: /WebhookEndpoint\/events/ }).getByText('delete', { exact: true })
  ).toBeVisible();

  let imports = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/config-bundles/import')) imports++;
  });
  let question = '';
  page.once('dialog', (dialog) => {
    question = dialog.message();
    void dialog.dismiss();
  });
  const apply = page.getByRole('button', { name: 'Apply bundle' });
  await apply.click();
  expect(question).toContain('not in the bundle: WebhookEndpoint/events.');
  expect(question).toContain('This cannot be undone.');

  page.once('dialog', (next) => void next.accept());
  await apply.click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  expect(imports).toBe(1);
  expect((await tenant.plan(endpointBundle(tenant.id, fullSpec))).items[0].action).toBe('create');
});

test('filters the resource ownership table by kind and text', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(endpointBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  const ownership = page.locator('mat-card', { hasText: 'Resource ownership' });
  const rows = ownership.locator('tbody tr');
  await expect(ownership.getByRole('status')).toHaveText(/^\s*\d+ resources\s*$/);
  // The tenant records more resources than the webhook endpoint, so the filter has rows to hide.
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);

  await ownership.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: /^WebhookEndpoint \(1\)/ }).click();
  await page.keyboard.press('Escape');

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('WebhookEndpoint/events');
  await expect(ownership.getByRole('status')).toHaveText(`Showing 1 of ${total} resources`);

  await ownership.getByRole('combobox', { name: 'Ownership' }).click();
  await page.getByRole('option', { name: /^unmanaged/ }).click();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveText(['No resources match the filters.']);
  // A click while the panel still closes would reopen it only to have the closing panel shut it.
  await expect(page.getByRole('listbox')).toBeHidden();
  await ownership.getByRole('combobox', { name: 'Ownership' }).click();
  await page.getByRole('option', { name: /^unmanaged/ }).click();
  await page.getByRole('option', { name: /^file-managed/ }).click();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(1);

  await ownership.getByRole('textbox', { name: 'Search' }).fill('no-such-resource');
  await expect(rows).toHaveText(['No resources match the filters.']);

  await ownership.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(ownership.getByRole('status')).toHaveText(`${total} resources`);
  await expect(rows).toHaveCount(total);
  await expect(ownership.getByRole('textbox', { name: 'Search' })).toHaveValue('');
});

test('detaches only the file-managed resources the filters show', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(endpointBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  const ownership = page.locator('mat-card', { hasText: 'Resource ownership' });
  const rows = ownership.locator('tbody tr');
  await expect(ownership.getByRole('status')).toHaveText(/^\s*\d+ resources\s*$/);
  const total = await rows.count();

  await ownership.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: /^WebhookEndpoint/ }).click();
  await page.keyboard.press('Escape');
  await ownership
    .getByRole('checkbox', { name: 'Select all detachable resources in view' })
    .check();
  await expect(ownership.getByText('1 selected')).toBeVisible();

  let question = '';
  page.once('dialog', (dialog) => {
    question = dialog.message();
    void dialog.accept();
  });
  await ownership.getByRole('button', { name: 'Detach selected' }).click();

  await expect(page.getByText('Detached 1 resource(s)')).toBeVisible();
  expect(question).toContain('Detach 1 resource(s): WebhookEndpoint/events?');
  await expect(rows.first()).toContainText('detached');
  await ownership.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(rows).toHaveCount(total);
  await expect(rows.filter({ hasText: 'detached' })).toHaveCount(1);
});
