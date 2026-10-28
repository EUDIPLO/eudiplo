import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import type { KeyChainImportDto, KeyChainResponseDto } from '@eudiplo/sdk-core';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { tenantToken, writeConfig } from './support/clients';

// Test-only keys and certificates, valid until 2126: a CA (CA=true) and a
// self-signed certificate that is not a CA.
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'key-chain', name), 'utf8');
const caKey = fixture('ca-key.pem');
const caCertificate = fixture('ca-cert.pem');
const leafKey = fixture('leaf-key.pem');
const leafCertificate = fixture('leaf-cert.pem');

function isImport(request: Request): boolean {
  return request.url().endsWith('/api/key-chain/import') && request.method() === 'POST';
}

/** Opens the configuration step of the wizard through these choices. */
async function configure(page: Page, choices: string[], description: string): Promise<void> {
  await page.goto('/keys/create');
  for (const choice of choices) {
    await page.getByRole('radio', { name: choice }).check();
    await page.getByRole('button', { name: /^(Next|Configure Key)/ }).click();
  }
  await page.getByRole('textbox', { name: 'Description' }).fill(description);
}

async function fillKeyAndCertificate(page: Page, key: string, certificate: string): Promise<void> {
  await page.getByRole('textbox', { name: 'External private key' }).fill(key);
  await page.getByRole('textbox', { name: 'External certificate chain' }).fill(certificate);
}

async function keyChain(request: APIRequestContext, id: string): Promise<KeyChainResponseDto> {
  const response = await request.get(`${resolvedE2EConfig.apiBaseUrl}/api/key-chain/${id}`, {
    headers: { Authorization: `Bearer ${await tenantToken(request)}` },
  });
  expect(response.ok(), `GET /api/key-chain/${id}`).toBe(true);
  return (await response.json()) as KeyChainResponseDto;
}

async function deleteKeyChain(request: APIRequestContext, id: string): Promise<void> {
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  await writeConfig(
    () => request.delete(`${resolvedE2EConfig.apiBaseUrl}/api/key-chain/${id}`, { headers }),
    `delete key chain ${id}`
  );
}

test.describe('key creation wizard imports', () => {
  const suffix = randomBytes(4).toString('hex');
  const created: string[] = [];

  test.beforeEach(() => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteKeyChain(request, id);
  });

  /**
   * Clicks the import button and returns the request body and the ID of the imported key chain,
   * recorded for deletion before the page is checked.
   */
  async function submitImport(
    page: Page,
    button: string
  ): Promise<{ body: KeyChainImportDto; id: string }> {
    const answered = page.waitForResponse((response) => isImport(response.request()));
    await page.getByRole('button', { name: button }).click();
    const response = await answered;
    expect(response.ok(), `POST /api/key-chain/import: ${await response.text()}`).toBe(true);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    return { body: response.request().postDataJSON() as KeyChainImportDto, id };
  }

  test('imports an External CA Chain without rotation', async ({ page, request }) => {
    const description = `E2E external CA ${suffix}`;
    await configure(page, ['Credential Signing (Attestation)', 'External CA Chain'], description);
    await fillKeyAndCertificate(page, caKey, caCertificate);

    const rotation = page.getByRole('switch', { name: 'Enable automatic key rotation' });
    await expect(rotation).toBeChecked();
    await expect(page.getByRole('spinbutton', { name: 'Rotation Interval (days)' })).toBeVisible();
    await rotation.click();
    await expect(rotation).not.toBeChecked();
    await expect(page.getByRole('spinbutton', { name: 'Rotation Interval (days)' })).toHaveCount(0);
    await expect(page.locator('.summary-card')).toContainText(/Rotation:\s*Off/);

    const { body, id } = await submitImport(page, 'Import CA & Create Chain');
    expect(body.type).toBe('internalChain');
    expect(body.rotationPolicy).toMatchObject({ enabled: false });
    expect(body.rotationPolicy?.intervalDays).toBeUndefined();
    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();

    const stored = await keyChain(request, id);
    expect(stored.type).toBe('internalChain');
    expect(stored.rotationPolicy.enabled).toBe(false);
  });

  test('imports a status list External CA Chain with rotation', async ({ page, request }) => {
    const description = `E2E status list CA ${suffix}`;
    await configure(page, ['Status List Signing', 'External CA Chain'], description);
    await fillKeyAndCertificate(page, caKey, caCertificate);
    await expect(page.getByRole('switch', { name: 'Enable automatic key rotation' })).toBeChecked();

    const { body, id } = await submitImport(page, 'Import CA & Create Chain');
    expect(body).toMatchObject({ usageType: 'statusList', type: 'internalChain' });
    expect(body.rotationPolicy).toMatchObject({ enabled: true });
    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();

    const stored = await keyChain(request, id);
    expect(stored).toMatchObject({ usageType: 'statusList', type: 'internalChain' });
    expect(stored.rotationPolicy.enabled).toBe(true);
  });

  test('refuses an External CA Chain whose certificate is not a CA', async ({ page }) => {
    await configure(
      page,
      ['Credential Signing (Attestation)', 'External CA Chain'],
      `E2E not a CA ${suffix}`
    );
    await fillKeyAndCertificate(page, leafKey, leafCertificate);

    const answered = page.waitForResponse((response) => isImport(response.request()));
    await page.getByRole('button', { name: 'Import CA & Create Chain' }).click();
    expect((await answered).status()).toBe(400);
    await expect(page.getByText(/certificate must be a CA/)).toBeVisible();
    await expect(page).toHaveURL(/\/keys\/create$/);
  });

  test('imports an External Certificate as a standalone key chain', async ({ page, request }) => {
    const description = `E2E external access ${suffix}`;
    await configure(page, ['Access Certificate', 'External Certificate'], description);
    await fillKeyAndCertificate(page, leafKey, leafCertificate);

    const { body, id } = await submitImport(page, 'Import Key & Certificate');
    expect(body.type).toBe('standalone');
    expect(body.rotationPolicy).toBeUndefined();
    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();

    const stored = await keyChain(request, id);
    expect(stored.type).toBe('standalone');
  });
});

test.describe('key creation wizard signing algorithm', () => {
  const created: string[] = [];

  test.beforeEach(() => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteKeyChain(request, id);
  });

  test('creates an ES384 key chain on P-384', async ({ page, request }) => {
    const description = `E2E ES384 ${randomBytes(4).toString('hex')}`;
    await configure(
      page,
      ['Credential Signing (Attestation)', 'Create Key Chain (Recommended)'],
      description
    );

    const algorithm = page.getByRole('combobox', { name: 'Signing Algorithm' });
    await expect(algorithm).toContainText('ES256 (ECDSA P-256)');
    await algorithm.click();
    await page.getByRole('option', { name: 'ES384 (ECDSA P-384)' }).click();
    await expect(page.locator('.summary-card')).toContainText(/Algorithm:\s*ES384 \(ECDSA P-384\)/);

    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/key-chain') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create Key Chain' }).click();
    const response = await answered;
    expect(response.ok(), `POST /api/key-chain: ${await response.text()}`).toBe(true);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    expect(response.request().postDataJSON()).toMatchObject({ alg: 'ES384' });

    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();
    await expect(page.getByText('ES384 (ECDSA P-384)')).toBeVisible();
    const stored = await keyChain(request, id);
    expect(stored.alg).toBe('ES384');
    expect(stored.activePublicKey.crv).toBe('P-384');
  });
});

test.describe('key creation wizard status list keys', () => {
  const created: string[] = [];

  test.beforeEach(() => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteKeyChain(request, id);
  });

  test('creates a rotating status list key chain', async ({ page, request }) => {
    const description = `E2E status list ${randomBytes(4).toString('hex')}`;
    await configure(page, ['Status List Signing', 'Create Key Chain (Recommended)'], description);

    await expect(page.getByRole('switch', { name: 'Enable automatic key rotation' })).toBeChecked();
    await page.getByRole('spinbutton', { name: 'Rotation Interval (days)' }).fill('20');
    await expect(page.locator('.summary-card')).toContainText(/Rotation Interval:\s*20 days/);

    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/key-chain') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create Key Chain' }).click();
    const response = await answered;
    expect(response.ok(), `POST /api/key-chain: ${await response.text()}`).toBe(true);
    const { id } = (await response.json()) as { id: string };
    created.push(id);

    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();
    const stored = await keyChain(request, id);
    expect(stored).toMatchObject({ usageType: 'statusList', type: 'internalChain' });
    expect(stored.rotationPolicy).toMatchObject({ enabled: true, intervalDays: 20 });
  });
});

/** The certificate the test CA issues for the CSR, as an external CA would. */
function issueWithTestCa(csr: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eudiplo-csr-'));
  try {
    writeFileSync(join(dir, 'request.csr'), csr);
    writeFileSync(join(dir, 'ca.pem'), caCertificate);
    writeFileSync(join(dir, 'ca.key'), caKey);
    return execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        join(dir, 'request.csr'),
        '-CA',
        join(dir, 'ca.pem'),
        '-CAkey',
        join(dir, 'ca.key'),
        '-set_serial',
        '1',
        '-days',
        '30',
        '-sha256',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('key creation wizard certificate requests', () => {
  const suffix = randomBytes(4).toString('hex');
  const created: string[] = [];

  test.beforeEach(() => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
    );
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteKeyChain(request, id);
  });

  test('creates an access key, requests its certificate with a CSR and stores it', async ({
    page,
    request,
  }) => {
    const description = `E2E CSR access ${suffix}`;
    await configure(page, ['Access Certificate', 'External Certificate'], description);
    await page
      .getByRole('radio', {
        name: 'Create the key in EUDIPLO and request its certificate with a CSR',
      })
      .check();
    await expect(page.getByRole('textbox', { name: 'External private key' })).toHaveCount(0);

    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/key-chain') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create Key Chain' }).click();
    const response = await answered;
    expect(response.ok(), `POST /api/key-chain: ${await response.text()}`).toBe(true);
    const { id } = (await response.json()) as { id: string };
    created.push(id);
    await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();

    // The key was created for this, so the steps are open.
    const subject = `C=DE, O=EUDIPLO E2E, CN=E2E Verifier ${suffix}`;
    await page.getByRole('textbox', { name: 'Subject' }).fill(subject);
    await page.getByRole('button', { name: 'Create CSR' }).click();
    const csrField = page.getByRole('textbox', { name: 'CSR (PEM)' });
    await expect(csrField).toHaveValue(/-----BEGIN CERTIFICATE REQUEST-----/);

    const certificateField = page.getByRole('textbox', { name: 'Certificate Chain (PEM)' });
    // A certificate for another key is refused, and the reason is shown.
    await certificateField.fill(leafCertificate);
    await page.getByRole('button', { name: 'Store Certificate' }).click();
    await expect(page.getByRole('alert')).toContainText('not issued for the active key');

    await certificateField.fill(
      `${issueWithTestCa(await csrField.inputValue())}\n${caCertificate}`
    );
    await page.getByRole('button', { name: 'Store Certificate' }).click();
    await expect(page.getByText('Certificate stored for this key')).toBeVisible();

    const stored = await keyChain(request, id);
    expect(stored.activeCertificate?.subject).toBe(subject);
    expect(stored.activeCertificate?.issuer).not.toBe(subject);
    await expect(page.getByText(stored.activeCertificate!.issuer).first()).toBeVisible();
  });
});
