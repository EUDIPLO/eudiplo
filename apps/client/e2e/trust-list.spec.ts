import type { Page, Response } from '@playwright/test';
import { expect, test } from './support/test';
import { useTenantClient } from './support/clients';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { certificatePem, createKeyChain } from './support/key-chains';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';
import { createTrustList } from './support/trust-lists';

function isTrustListRequest(response: Response): boolean {
  return response.url().endsWith('/api/trust-list') && response.request().method() === 'GET';
}

test.describe('verifier admin', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const { clientId, clientSecret } = useTenantClient(
    'trust-lists',
    ['presentation:manage'],
    'E2E verifier admin without issuance roles'
  );

  /** Signs in and leaves the dashboard, which loads trust lists too, for a page that does not. */
  async function signInOnKeys(page: Page): Promise<void> {
    await loginWithClientCredentials(page, clientId, clientSecret);
    await page.goto('/keys');
  }

  test('opens Trust Lists from the navigation without issuance roles', async ({ page }) => {
    await signInOnKeys(page);
    const entry = page.locator('mat-sidenav').getByText('Trust Lists', { exact: true });
    await expect(entry).toHaveCount(1);

    const lists = page.waitForResponse(isTrustListRequest);
    await entry.click();
    await expect(page).toHaveURL(/\/trust-list$/);
    expect((await lists).ok(), 'GET /api/trust-list').toBe(true);
    await expect(page.getByRole('heading', { name: 'Trust lists' })).toBeVisible();
  });

  /** Opens the trust list with this id, or the first one, or skips the test when there is none. */
  async function openTrustList(page: Page, id?: string): Promise<void> {
    const lists = page.waitForResponse(isTrustListRequest);
    await page.goto('/trust-list');
    const ids = ((await (await lists).json()) as { id: string }[]).map((list) => list.id);
    const found = id ? ids.includes(id) : ids.length > 0;
    // Build mode imports the demo tenant and its trust list; a development tenant may have none.
    if (resolvedE2EConfig.useBuild) expect(found, `trust list ${id ?? 'of the tenant'}`).toBe(true);
    else test.skip(!found, 'No trust list to open.');
    await page.goto(`/trust-list/${id ?? ids[0]}`);
  }

  test('is told that credential config references need issuance:manage', async ({ page }) => {
    await signInOnKeys(page);
    await openTrustList(page);

    await expect(page.getByText('You need the issuance:manage role')).toBeVisible();
    await expect(page.getByText('No credential configs reference this trust list.')).toHaveCount(0);
  });

  test('sees which presentation configs reference the trust list', async ({ page }) => {
    await signInOnKeys(page);
    // The demo trust list; the demo presentation configs pid and age-over-18 accept its issuers.
    await openTrustList(page, '580831bc-ef11-43f4-a3be-a2b6bf1b29a3');

    const card = page
      .locator('mat-card')
      .filter({ has: page.getByText('Referenced by Presentation Configs', { exact: true }) });
    await expect(card.locator('a[href="/presentation-config/pid"]')).toBeVisible();
    await expect(card.locator('a[href="/presentation-config/age-over-18"]')).toBeVisible();
  });
});

test.describe('entities', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('removing an entity leaves the next one in its place with its own values', async ({
    page,
  }) => {
    test.skip(
      !hasRootCredentials,
      'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
    );
    const tenant = await createTenant('trust-list-rows', 'Trust List Rows', ['issuance:manage']);
    const api = `${resolvedE2EConfig.apiBaseUrl}/api/trust-list`;
    const headers = { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' };
    const keyChainId = await createKeyChain(tenant.token, 'trustList', 'Trust list rows signing');
    const created = await fetch(api, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'rows',
        description: 'Three entities',
        keyChainId,
        entities: ['A', 'B', 'C'].map((name) => ({
          type: 'external',
          providerType: 'attestation-provider',
          issuerCertPem: certificatePem,
          revocationCertPem: certificatePem,
          info: { name: `Entity ${name}`, country: name === 'C' ? 'FR' : 'DE' },
        })),
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);

    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    await page.goto('/trust-list/rows/edit');
    await page.getByRole('button', { name: /External Entity #2/ }).click();
    await page
      .getByRole('region', { name: /External Entity #2/ })
      .getByRole('button', { name: 'Remove Entity' })
      .click();

    // The next entity takes the place and the focus of the removed one, with its own values.
    await expect(page.getByRole('button', { name: /External Entity #3/ })).toHaveCount(0);
    const header = page.getByRole('button', { name: /External Entity #2/ });
    await expect(header).toBeFocused();
    // The header names the entity, so it does not read like the one just removed.
    await expect(header).toHaveAccessibleName(/^External Entity #2 · Entity C/);
    // Opening entity 2 closed the last one: only one panel is open at a time.
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    const second = page.getByRole('region', { name: /External Entity #2/ });
    await expect(second.getByRole('textbox', { name: 'Entity Name' })).toHaveValue('Entity C');
    await expect(second.getByRole('textbox', { name: 'Country' })).toHaveValue('FR');
    await second.getByRole('textbox', { name: 'Entity Name' }).fill('Entity C edited');

    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
    await save.click();
    await expect(page).toHaveURL(/\/trust-list$/);

    const stored = await fetch(`${api}/rows`, { headers });
    expect(stored.ok).toBe(true);
    const { entityConfig } = (await stored.json()) as {
      entityConfig: { info: { name: string; country?: string } }[];
    };
    expect(entityConfig.map(({ info }) => [info.name, info.country])).toEqual([
      ['Entity A', 'DE'],
      ['Entity C edited', 'FR'],
    ]);

    // Removing the last entity moves focus to the new last one, the only one to Add Internal Entity.
    await page.goto('/trust-list/rows/edit');
    await page
      .getByRole('region', { name: /External Entity #2/ })
      .getByRole('button', { name: 'Remove Entity' })
      .click();
    await expect(page.getByRole('button', { name: /External Entity #1 · Entity A/ })).toBeFocused();
    await page
      .getByRole('region', { name: /External Entity #1/ })
      .getByRole('button', { name: 'Remove Entity' })
      .click();
    await expect(page.getByRole('button', { name: 'Add Internal Entity' })).toBeFocused();
  });
});

test.describe('edit page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const id = 'load-check';

  /**
   * Signs in as the admin of a new tenant that has one trust list with an external entity, and
   * no key chains besides the one that signs it. Returns the admin's access token.
   */
  async function signInWithTrustList(page: Page): Promise<string> {
    test.skip(
      !hasRootCredentials,
      'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
    );
    const tenant = await createTenant('trust-list-load', 'Trust List Load', ['issuance:manage']);
    await createTrustList(tenant.token, id, 'Loaded on the edit page');
    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    return tenant.token;
  }

  test('a failed load says why and loads again on Retry', async ({ page }) => {
    await signInWithTrustList(page);
    let failLoading = true;
    await page.route(`**/api/trust-list/${id}`, (route) =>
      failLoading && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: { message: 'Internal server error' } })
        : route.fallback()
    );
    await page.goto(`/trust-list/${id}/edit`);

    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Failed to load trust list: Internal server error' });
    await expect(alert).toBeVisible();
    // Neither an empty form nor a redirect to the list.
    await expect(page.getByRole('textbox', { name: 'ID', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add Internal Entity' })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/trust-list/${id}/edit$`));

    failLoading = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();

    await expect(page.getByRole('textbox', { name: 'ID', exact: true })).toHaveValue(id);
    await expect(
      page.getByRole('button', { name: /^External Entity #1 · Example Wallet Provider/ })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /External Entity #2/ })).toHaveCount(0);
    await expect(alert).toHaveCount(0);
    // Retry left with the error card, so keyboard focus continues from the page heading.
    await expect(page.getByRole('heading', { name: 'Edit Trust List', level: 2 })).toBeFocused();
  });

  test('a failed key chain load is shown at the key chain select and loads again on Retry', async ({
    page,
  }) => {
    await signInWithTrustList(page);
    let failLoading = true;
    await page.route('**/api/key-chain', (route) =>
      failLoading && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: { message: 'Internal server error' } })
        : route.fallback()
    );
    await page.goto(`/trust-list/${id}/edit`);

    const signingKeyChain = page.getByRole('combobox', { name: 'Signing Key Chain' });
    await expect(signingKeyChain).toBeVisible();
    await expect(page.getByText('Could not load key chains.')).toBeVisible();

    failLoading = false;
    await page.getByRole('button', { name: 'Retry loading key chains' }).click();

    await expect(page.getByText('Could not load key chains.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry loading key chains' })).toHaveCount(0);
    // The Retry button is gone, so focus moves to the select it was for.
    await expect(signingKeyChain).toBeFocused();
    await signingKeyChain.click();
    await expect(
      page.getByRole('option', { name: /Loaded on the edit page signing/ })
    ).toBeVisible();
  });

  test('an internal entity without key chains links to create them and loads them on Reload', async ({
    page,
  }) => {
    const token = await signInWithTrustList(page);
    await page.goto(`/trust-list/${id}/edit`);
    await page.getByRole('button', { name: 'Add Internal Entity' }).click();

    const noIssuer = page.getByText(
      'No credential signing key chains. Create one in Key Management.'
    );
    await expect(noIssuer).toBeVisible();
    await expect(
      page.getByText(
        'No status list or credential signing key chains. Create one in Key Management.'
      )
    ).toBeVisible();
    // A new tab, so the form keeps what was entered.
    const createIssuer = page.getByRole('link', {
      name: 'Create credential signing key chain (opens in a new tab)',
    });
    await expect(createIssuer).toHaveAttribute('href', '/keys/create?usage=attestation');
    await expect(createIssuer).toHaveAttribute('target', '_blank');
    await expect(
      page.getByRole('link', { name: 'Create status list key chain (opens in a new tab)' })
    ).toHaveAttribute('href', '/keys/create?usage=statusList');
    // With the entity named, Save points at the empty key chain selects.
    await page
      .getByRole('region', { name: /Internal Entity #2/ })
      .getByRole('textbox', { name: 'Entity Name' })
      .fill('Own Issuer');
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
    await save.click();
    const issuer = page.getByRole('combobox', { name: /^Issuer Key Chain/ });
    await expect(issuer).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/trust-list/${id}/edit$`));

    // Created in the other tab.
    await createKeyChain(token, 'attestation', 'Own issuer');
    await createKeyChain(token, 'statusList', 'Own status list');
    await page.getByRole('button', { name: 'Reload key chains' }).click();

    await expect(noIssuer).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Create .* key chain/ })).toHaveCount(0);
    // The Reload button is gone, so focus moves to the first select it was for.
    await expect(issuer).toBeFocused();
    await issuer.click();
    await expect(page.getByRole('option', { name: /^Own issuer/ })).toBeVisible();
  });

  test('without status list key chains, the credential signing key chain also signs revocation', async ({
    page,
  }) => {
    const token = await signInWithTrustList(page);
    const keyChainId = await createKeyChain(token, 'attestation', 'Own issuer');
    await page.goto(`/trust-list/${id}/edit`);
    await page.getByRole('button', { name: 'Add Internal Entity' }).click();
    const entity = page.getByRole('region', { name: /Internal Entity #2/ });

    await entity.getByRole('combobox', { name: /^Issuer Key Chain/ }).click();
    await page.getByRole('option', { name: /^Own issuer/ }).click();
    // A click while the panel still closes would reopen it or hit its backdrop.
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(
      entity.getByText(
        'No status list key chains, so a credential signing key chain signs the status lists.'
      )
    ).toBeVisible();
    await entity.getByRole('combobox', { name: /^Revocation Key Chain/ }).click();
    await expect(page.getByRole('group', { name: 'Credential signing key chains' })).toBeVisible();
    await page.getByRole('option', { name: /^Own issuer/ }).click();
    await entity.getByRole('textbox', { name: 'Entity Name' }).fill('Own Issuer');

    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
    await save.click();
    await expect(page).toHaveURL(/\/trust-list$/);

    // The backend accepted it for revocation, and the stored list names it there.
    const stored = await fetch(`${resolvedE2EConfig.apiBaseUrl}/api/trust-list/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stored.ok).toBe(true);
    const { entityConfig } = (await stored.json()) as {
      entityConfig: { type: string; issuerKeyChainId?: string; revocationKeyChainId?: string }[];
    };
    expect(entityConfig.find((entry) => entry.type === 'internal')).toMatchObject({
      issuerKeyChainId: keyChainId,
      revocationKeyChainId: keyChainId,
    });
  });

  test('Save opens the collapsed entity whose field keeps the trust list from saving', async ({
    page,
  }) => {
    await signInWithTrustList(page);
    let updates = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith(`/api/trust-list/${id}`)) updates++;
    });
    await page.goto(`/trust-list/${id}/edit`);
    const first = page.getByRole('region', { name: /External Entity #1/ });
    const name = first.getByRole('textbox', { name: 'Entity Name' });
    await name.fill('');
    // The new entity opens, which collapses the first one with its empty name.
    await page.getByRole('button', { name: 'Add Internal Entity' }).click();
    const firstHeader = page.getByRole('button', { name: /^External Entity #1/ });
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');

    // Save is not disabled for an incomplete form: a click says what is missing, and where.
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).toBeEnabled();
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
    await save.click();

    await expect(name).toBeFocused();
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(first.getByText('Entity name is required')).toBeVisible();
    await expect(
      page.getByText('Check the highlighted fields in External Entity #1, Internal Entity #2.')
    ).toBeVisible();
    // The new entity, collapsed now, says in its header that it needs a look too.
    await expect(page.getByRole('button', { name: /^Internal Entity #2/ })).toHaveAccessibleName(
      /Check the highlighted fields/
    );
    await expect(page).toHaveURL(new RegExp(`/trust-list/${id}/edit$`));
    expect(updates).toBe(0);
  });

  test('Enter moves focus into an empty certificate editor, where a paste goes', async ({
    page,
  }) => {
    await signInWithTrustList(page);
    await page.goto(`/trust-list/${id}/edit`);
    await page.getByRole('button', { name: 'Add External Entity' }).click();
    const second = page.getByRole('region', { name: /External Entity #2/ });
    const entityName = second.getByRole('textbox', { name: 'Entity Name' });
    await entityName.fill('Other Issuer');
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toHaveAttribute(
      'aria-busy',
      'true'
    );
    // Enter submits the form as a click on Save does.
    await entityName.press('Enter');

    // Monaco's input, named after its certificate, takes the focus.
    const issuerCertificate = second.getByRole('textbox', { name: /Issuer certificate \(PEM\)/ });
    await expect(issuerCertificate).toBeFocused();
    await expect(issuerCertificate).toHaveAttribute('aria-required', 'true');
    await expect(second.getByText('Paste the issuer certificate.')).toBeVisible();
    await page.keyboard.type('-----BEGIN CERTIFICATE-----');
    await expect(second.locator('app-editor').first()).toContainText('-----BEGIN CERTIFICATE-----');
  });
});
