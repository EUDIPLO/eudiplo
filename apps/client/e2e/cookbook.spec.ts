import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { acceptCredentialOffer, type HolderCredential, presentCredential } from './support/wallet';

// Walks the "Issue and verify" cookbook in the Web Client: chapter 2
// (apps/docs/docs/cookbooks/first-credential.md) and chapter 3
// (first-presentation.md). A headless wallet stands in for the phone. Keep the
// steps, labels and values in sync with the cookbook.

test.use({ storageState: { cookies: [], origins: [] } });

// A new tenant per run, so the spec also passes against a reused dev backend
// and in parallel workers. Everything else uses the cookbook's shared values.
const tenantId = `membership-demo-${randomBytes(4).toString('hex')}`;
const vct = 'urn:example:membership:1';

function openNav(page: Page, item: string) {
  return page.locator('mat-sidenav').getByText(item, { exact: true }).click();
}

// Icon buttons have no accessible name; the cookbook names them by their tooltip.
// Material switches update aria-checked after the click, so specs click them and
// then assert the state instead of using check().
function iconButton(page: Page, tooltip: string) {
  return page.locator(`button[mattooltip="${tooltip}"]`);
}

async function createKeyChain(page: Page, choices: string[], description: string) {
  await openNav(page, 'Keys');
  await iconButton(page, 'Create Key').click();
  for (const choice of choices) {
    await page.getByRole('radio', { name: choice }).check();
    await page.getByRole('button', { name: /^(Next|Configure Key)/ }).click();
  }
  await page.getByRole('textbox', { name: 'Description' }).fill(description);
  await page.getByRole('button', { name: 'Create Key Chain' }).click();
  await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();
}

async function selectOption(page: Page, field: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

/** The offer or request URI that the QR code on the session page encodes. */
async function scanQrCode(page: Page): Promise<string> {
  const link = page.locator('.uri-value a');
  await expect(link).toBeVisible();
  return (await link.getAttribute('href'))!;
}

test('issue and verify cookbook', async ({ page }) => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to run the cookbook as root.'
  );
  test.setTimeout(180_000);

  let holder: HolderCredential;

  await test.step('chapter 1, step 5: sign in as root', async () => {
    await loginWithClientCredentials(
      page,
      resolvedE2EConfig.rootClientId!,
      resolvedE2EConfig.rootClientSecret!
    );
  });

  await test.step('chapter 2, step 1: create a tenant for the recipe', async () => {
    await openNav(page, 'Tenants');
    await iconButton(page, 'Create New Tenant').click();
    await page.getByRole('textbox', { name: 'tenant ID' }).fill(tenantId);
    await page.getByRole('textbox', { name: 'Name' }).fill('Membership Demo');
    await page.getByRole('combobox', { name: 'Client Roles' }).click();
    for (const role of [
      'issuance:manage',
      'issuance:offer',
      'presentation:manage',
      'presentation:request',
    ]) {
      await page.getByRole('option', { name: role, exact: true }).click();
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Create tenant' }).click();

    const dialog = page.getByRole('dialog', { name: 'Client Secret Generated' });
    await expect(dialog.getByText(`${tenantId}-admin`, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Login as this Client' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.getByRole('button', { name: 'Example icon-button with a menu' }).click();
    await expect(page.getByText(`Client ID: ${tenantId}-admin`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('mat-sidenav').getByText('Credential Issuance')).toBeVisible();
    await expect(page.locator('mat-sidenav').getByText('Credential Verification')).toBeVisible();
  });

  await test.step('chapter 2, step 2: create the signing and access keys', async () => {
    await createKeyChain(
      page,
      ['Credential Signing (Attestation)', 'Create Key Chain (Recommended)'],
      'Membership credential signing'
    );
    await createKeyChain(
      page,
      ['Access Certificate', 'Self-Signed Certificate'],
      'Membership verifier access'
    );
    await openNav(page, 'Keys');
    await expect(page.getByText('Membership credential signing')).toBeVisible();
    await expect(page.getByText('Membership verifier access')).toBeVisible();
  });

  await test.step('chapter 2, step 3: set up the issuer', async () => {
    await openNav(page, 'Issuer Settings');
    await page.getByRole('link', { name: 'Use guided setup' }).click();
    await expect(page.getByText('Step 1 of 4 · Identity')).toBeVisible();
    await page.getByRole('textbox', { name: 'Name' }).fill('Membership Demo');
    await selectOption(page, 'Locale', 'English (US)');
    for (const step of ['Wallet access', 'Trust', 'Review']) {
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText(`· ${step}`)).toBeVisible();
    }
    await page.getByRole('button', { name: 'Save settings' }).click();

    await expect(page).toHaveURL(/\/issuance-config$/);
    await expect(page.getByText('Membership Demo').first()).toBeVisible();
  });

  await test.step('chapter 2, step 4: define the membership credential', async () => {
    await openNav(page, 'Credential Types');
    await iconButton(page, 'Create New Credential Configuration').click();

    // Basics
    await page.getByRole('textbox', { name: 'Configuration ID' }).fill('membership');
    await page
      .getByRole('textbox', { name: 'Description' })
      .fill('Membership credential for the cookbook');
    await expect(page.getByRole('combobox', { name: 'Credential Format' })).toHaveText(
      /dc\+sd-jwt/
    );
    await page.getByText('No (Custom URI)').click();
    await page.getByRole('textbox', { name: 'VCT URI' }).fill(vct);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Claims
    const claims = [
      { path: 'name', value: 'Max' },
      { path: 'member_id', value: 'M-001' },
    ];
    for (const [i, claim] of claims.entries()) {
      await page.getByRole('button', { name: 'Add Field' }).click();
      await page.getByRole('textbox', { name: 'Path' }).nth(i).fill(claim.path);
      await expect(page.getByRole('combobox', { name: 'Type' }).nth(i)).toHaveText('string');
      await page.getByRole('textbox', { name: 'Default Value' }).nth(i).fill(claim.value);
      const mandatory = page.getByRole('switch', { name: 'Mandatory' }).nth(i);
      await mandatory.click();
      await expect(mandatory).toBeChecked();
      await expect(
        page.getByRole('switch', { name: 'Selectively Disclosable' }).nth(i)
      ).toBeChecked();
    }
    await page.getByRole('button', { name: 'Continue' }).click();

    // Appearance
    await page.getByRole('textbox', { name: 'Display Name' }).fill('Membership');
    await page.getByRole('textbox', { name: 'Description' }).fill('Example membership card');
    await expect(page.getByRole('combobox', { name: 'Locale' })).toHaveText(/United States/);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Settings
    await page.getByRole('button', { name: 'Signing, lifetime and trust' }).click();
    await selectOption(page, 'Signing Key Chain', /Membership credential signing/);
    await selectOption(page, 'Credential Lifetime', '1 day');
    await expect(page.getByRole('combobox', { name: 'SD-JWT Trust Format' })).toHaveText(/x5c/);
    await page.getByRole('button', { name: 'Credential Features' }).click();
    await expect(page.getByRole('switch', { name: /Key Binding/ })).toBeChecked();
    const statusManagement = page.getByRole('switch', { name: /Status Management/ });
    await statusManagement.click();
    await expect(statusManagement).not.toBeChecked();
    await page.getByRole('combobox', { name: 'Supported Proof Types' }).click();
    await page.getByRole('option', { name: 'Attestation (preferred)' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Supported Proof Types' })).toHaveText('JWT');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Review
    await page.getByRole('button', { name: 'Create Configuration' }).click();
    await expect(page).toHaveURL(/\/credential-config$/);
    await expect(page.getByText('membership', { exact: true })).toBeVisible();
  });

  await test.step('chapter 2, step 5: send an offer to the wallet', async () => {
    await openNav(page, 'New Issuance');
    await page.getByRole('radio', { name: /Pre-Authorized Code/ }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    // The tenant's only credential type is preselected.
    await expect(page.getByRole('combobox', { name: 'Credential Configuration IDs' })).toHaveText(
      'membership'
    );
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Use Pre-configured Default Values' }).click();
    // The claim inputs carry no label: claims without display labels have no
    // schema title for the form to show.
    const claimInputs = page.locator('formly-form input');
    await expect(claimInputs.nth(0)).toHaveValue('Max');
    await expect(claimInputs.nth(1)).toHaveValue('M-001');
    await expect(page.getByRole('textbox', { name: 'Transaction Code (Optional)' })).toHaveValue(
      ''
    );
    await page.getByRole('button', { name: 'Generate Offer' }).click();
    await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
    await expect(page.getByText('Issuance Offer QR Code')).toBeVisible();

    holder = await acceptCredentialOffer(await scanQrCode(page));
    expect(holder.claims).toMatchObject({ vct, name: 'Max', member_id: 'M-001' });
    await expect(page.locator('mat-chip').first()).toHaveText(/fetched|completed/);
  });

  await test.step('chapter 3, step 1: create the keys for the trust list', async () => {
    await createKeyChain(page, ['Trust List Signing'], 'Membership trust list signing');
    await createKeyChain(page, ['Status List Signing'], 'Membership status list signing');
    await openNav(page, 'Keys');
    await expect(page.getByText('Membership trust list signing')).toBeVisible();
    await expect(page.getByText('Membership status list signing')).toBeVisible();
  });

  await test.step('chapter 3, step 2: publish the trust list', async () => {
    await openNav(page, 'Trust Lists');
    await iconButton(page, 'Create new Trust List').click();
    await page.getByRole('textbox', { name: 'ID', exact: true }).fill('membership-issuers');
    await page
      .getByRole('textbox', { name: 'Description' })
      .fill('Issuers accepted for membership checks');
    await selectOption(page, 'Signing Key Chain', /Membership trust list signing/);
    await page.getByRole('button', { name: 'Add Internal Entity' }).click();
    await expect(page.getByRole('combobox', { name: 'Provider type' })).toHaveText(
      'Credential provider'
    );
    await selectOption(page, 'Issuer Key Chain', /Membership credential signing/);
    await selectOption(page, 'Revocation Key Chain', /Membership status list signing/);
    await page.getByRole('textbox', { name: 'Entity Name' }).fill('Membership Demo');
    await page.getByRole('button', { name: 'Create Trust List' }).click();
    await expect(page).toHaveURL(/\/trust-list$/);

    await page
      .getByRole('row', { name: /membership-issuers/ })
      .locator('button[mattooltip="View details"]')
      .click();
    const trustListUrl = `${resolvedE2EConfig.apiBaseUrl}/issuers/${tenantId}/trust-list/membership-issuers`;
    await expect(page.getByRole('textbox', { name: 'Trust List URL' })).toHaveValue(trustListUrl);
    // The URL serves the signed trust list JWT.
    const trustList = await fetch(trustListUrl);
    expect(trustList.status).toBe(200);
    expect(await trustList.text()).toMatch(/^eyJ/);
  });

  await test.step('chapter 3, steps 3 and 4: define the verification request', async () => {
    await openNav(page, 'Verification Configs');
    await iconButton(page, 'Create Configuration').click();

    // 1. Name
    await page.getByRole('textbox', { name: 'ID', exact: true }).fill('membership-check');
    await page
      .getByRole('textbox', { name: 'Description' })
      .fill('Verify a membership name and ID');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 2. Credentials
    await page.getByRole('button', { name: 'Add credential' }).click();
    await page.getByRole('textbox', { name: 'Query ID' }).fill('membership');
    await expect(page.getByRole('combobox', { name: 'Credential format' })).toHaveText('SD-JWT VC');
    await page.getByRole('textbox', { name: 'Credential type (VCT)' }).fill(vct);
    await page.getByRole('textbox', { name: 'Claim path' }).fill('name');
    await page.getByRole('button', { name: 'Add claim' }).click();
    await page.getByRole('textbox', { name: 'Claim path' }).nth(1).fill('member_id');
    await page.getByRole('button', { name: 'Issuer trust' }).click();
    await page.getByRole('button', { name: 'Add managed trust list' }).click();
    await selectOption(page, 'Managed trust list', /\(membership-issuers\)/);
    await expect(page.getByRole('combobox', { name: 'Which credentials are needed?' })).toHaveText(
      'Require all selected credentials'
    );
    await page.getByRole('button', { name: 'Continue' }).click();

    // 3. Settings
    await page.getByRole('button', { name: 'Request and verification options' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Lifetime of the request' })).toHaveValue(
      '300'
    );
    await expect(page.getByRole('combobox', { name: 'Status List Check Mode' })).toHaveText(
      /Strict/
    );
    await selectOption(page, 'Access Key Chain (optional)', /Membership verifier access/);
    await page.getByRole('button', { name: 'Continue' }).click();

    // 4. Review
    await expect(page.getByText('name', { exact: true })).toBeVisible();
    await expect(page.getByText('member_id', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create Configuration' }).click();
    await expect(page).toHaveURL(/\/presentation-config\/membership-check$/);
    await openNav(page, 'Verification Configs');
    await expect(page.getByText('membership-check', { exact: true })).toBeVisible();
  });

  await test.step('chapter 3, step 5: generate and approve a request', async () => {
    await openNav(page, 'New Verification');
    await selectOption(page, 'Presentation Configuration', 'membership-check');
    await page.getByRole('button', { name: 'Generate Request' }).click();
    await expect(page).toHaveURL(/\/session-management\/[^/]+$/);
    await expect(page.getByText('Presentation Request QR Code')).toBeVisible();

    const response = await presentCredential(await scanQrCode(page), holder);
    expect(response.status, await response.text()).toBe(200);
  });

  await test.step('chapter 3, step 6: inspect the verified session', async () => {
    await expect(page.locator('mat-chip').first()).toHaveText('completed');
    await page.getByRole('tab', { name: 'Credentials (1)' }).click();
    const credentials = page.getByRole('tabpanel');
    await expect(credentials).toContainText('"membership"');
    await expect(credentials).toContainText('"name": "Max"');
    await expect(credentials).toContainText('"member_id": "M-001"');
  });
});
