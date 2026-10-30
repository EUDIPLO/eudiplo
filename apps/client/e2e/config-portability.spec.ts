import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant as createTestTenant, type TestTenant } from './support/tenants';

// The import plan on the Config Portability screen against the real backend. A registrar
// configuration document replaces the stored one, so a bundle without the client secret and
// the registration certificate defaults removes them: the plan lists the removals and the
// client asks before applying them. Imports do not contact the registrar or its OIDC realm.
// Each test gets its own tenant whose admin client has tenant:admin.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

const registrarSpec = {
  registrarUrl: 'https://registrar.example.invalid/api',
  oidcUrl: 'https://auth.example.invalid/realms/registrar',
  clientId: 'registrar-client',
  username: 'registrar-user',
  password: 'registrar-password',
};

const fullSpec = {
  ...registrarSpec,
  clientSecret: 'registrar-secret',
  registrationCertificateDefaults: { privacy_policy: 'https://rp.example/privacy' },
};

/** A JSON bundle with one registrar configuration document. */
function registrarBundle(tenantId: string, spec: Record<string, unknown>) {
  const document = {
    $schema: 'https://eudiplo.dev/schemas/v1/RegistrarConfigFile.schema.json',
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
          kind: 'RegistrarConfig',
          id: 'registrar',
          $schema: document.$schema,
          path: 'registrar.json',
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
    name: 'registrar-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(page.getByText('registrar-bundle.json')).toBeVisible();
  await page.getByRole('button', { name: 'Plan and validate' }).click();
  await expect(page.getByText('Ready to apply')).toBeVisible();
}

test.beforeEach(() => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant for the import.'
  );
});

test('lists the registrar values an upsert removes and asks before applying it', async ({
  page,
}) => {
  const tenant = await createTenant();
  await tenant.importBundle(registrarBundle(tenant.id, fullSpec));
  const minimal = registrarBundle(tenant.id, registrarSpec);
  await openConfigPortability(page, tenant);

  await planBundle(page, minimal);

  await expect(
    page.getByRole('heading', { name: 'Changes to RegistrarConfig/registrar' })
  ).toBeVisible();
  const changes = page.locator('table.changes');
  await expect(changes.getByRole('row', { name: /\/spec\/clientSecret/ })).toHaveText(
    /\/spec\/clientSecret\s*secret\s*.*removed/
  );
  await expect(
    changes.getByRole('row', { name: /registrationCertificateDefaults\/privacy_policy/ })
  ).toHaveText(/"https:\/\/rp\.example\/privacy"\s*.*removed/);
  await expect(page.getByText('2 fields, 2 removed')).toBeVisible();

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
  expect(question).toContain('RegistrarConfig/registrar (2 fields)');

  page.once('dialog', (next) => void next.accept());
  await apply.click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  // Only the accepted confirmation sent the import.
  expect(imports).toBe(1);
  expect((await tenant.plan(minimal)).items[0].action).toBe('unchanged');
});

test('applies an upsert without removals without asking', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(registrarBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });

  await planBundle(
    page,
    registrarBundle(tenant.id, { ...fullSpec, clientId: 'other-registrar-client' })
  );
  const row = page.locator('table.changes').getByRole('row', { name: /\/spec\/clientId/ });
  await expect(row).toHaveText(/"registrar-client"\s*"other-registrar-client"/);
  await expect(page.getByText('1 field', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply bundle' }).click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  expect(asked).toBe(false);
});

test('names the resources a replace import deletes before applying it', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(registrarBundle(tenant.id, fullSpec));
  // The same source without the registrar: replace mode deletes it.
  const empty = registrarBundle(tenant.id, registrarSpec);
  empty.manifest.resources = [];
  empty.documents = [];
  await openConfigPortability(page, tenant);
  await page.getByRole('combobox', { name: 'Import mode' }).click();
  await page.getByRole('option', { name: 'Replace managed resources' }).click();

  await planBundle(page, empty);
  await expect(
    page
      .getByRole('row', { name: /RegistrarConfig\/registrar/ })
      .getByText('delete', { exact: true })
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
  expect(question).toContain('not in the bundle: RegistrarConfig/registrar.');
  expect(question).toContain('This cannot be undone.');

  page.once('dialog', (next) => void next.accept());
  await apply.click();

  await expect(page.getByText('Configuration bundle imported')).toBeVisible();
  expect(imports).toBe(1);
  expect((await tenant.plan(registrarBundle(tenant.id, fullSpec))).items[0].action).toBe('create');
});

test('filters the resource ownership table by kind and text', async ({ page }) => {
  const tenant = await createTenant();
  await tenant.importBundle(registrarBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  const ownership = page.locator('mat-card', { hasText: 'Resource ownership' });
  const rows = ownership.locator('tbody tr');
  await expect(ownership.getByRole('status')).toHaveText(/^\s*\d+ resources\s*$/);
  // The tenant records more resources than the registrar, so the filter has rows to hide.
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);

  await ownership.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: /^RegistrarConfig \(1\)/ }).click();
  await page.keyboard.press('Escape');

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('RegistrarConfig/registrar');
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
  await tenant.importBundle(registrarBundle(tenant.id, fullSpec));
  await openConfigPortability(page, tenant);
  const ownership = page.locator('mat-card', { hasText: 'Resource ownership' });
  const rows = ownership.locator('tbody tr');
  await expect(ownership.getByRole('status')).toHaveText(/^\s*\d+ resources\s*$/);
  const total = await rows.count();

  await ownership.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: /^RegistrarConfig/ }).click();
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
  expect(question).toContain('Detach 1 resource(s): RegistrarConfig/registrar?');
  await expect(rows.first()).toContainText('detached');
  await ownership.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(rows).toHaveCount(total);
  await expect(rows.filter({ hasText: 'detached' })).toHaveCount(1);
});
