import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { createKeyChain } from './support/key-chains';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest } from './support/tenants';
import { acceptCredentialOffer } from './support/wallet';

// The Credential Status card of an issuance session: a credential that the headless wallet
// redeemed is suspended, reinstated and revoked there, each after its confirmation. Revocation
// is final, so the card then offers no action for it.

/** Opens the card's confirmation for an action, checks its title and confirms it. */
async function changeStatus(page: Page, action: 'Suspend' | 'Reinstate' | 'Revoke') {
  const card = page.locator('app-credential-status-card');
  await card.getByRole('button', { name: action }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText(`${action} 1 credential?`);
  if (action === 'Revoke') {
    await expect(dialog).toContainText('Revocation is final');
  }
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.use({ storageState: { cookies: [], origins: [] } });

test('suspends, reinstates and revokes the credential of a session from its status card', async ({
  page,
}) => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  // Suspension needs a status list with 2 bits, which the demo tenant does not have, so a new
  // tenant gets one, bound to a credential config the headless wallet can redeem.
  const tenant = await createTenant('credential-status', 'Credential Status', [
    'issuance:manage',
    'issuance:offer',
    'keys:manage',
  ]);
  const issuer = await tenantRequest(tenant, 'POST', '/issuer/config', {
    display: [{ name: 'Membership issuer', locale: 'en' }],
  });
  expect(issuer.ok, await issuer.clone().text()).toBe(true);
  const signing = await createKeyChain(tenant.token, 'attestation', 'Membership signing');
  const statusKeys = await createKeyChain(tenant.token, 'statusList', 'Membership status');
  const config = await tenantRequest(tenant, 'POST', '/issuer/credentials', {
    id: 'membership',
    vct: 'urn:example:membership',
    keyChainId: signing,
    keyBinding: true,
    statusManagement: true,
    config: { format: 'dc+sd-jwt', display: [] },
    fields: [{ path: ['name'], type: 'string', defaultValue: 'Ada' }],
  });
  expect(config.status, await config.clone().text()).toBe(201);
  const list = await tenantRequest(tenant, 'POST', '/status-lists', {
    capacity: 1000,
    bits: 2,
    credentialConfigurationId: 'membership',
    keyChainId: statusKeys,
  });
  expect(list.status, await list.clone().text()).toBe(201);
  const offer = await tenantRequest(tenant, 'POST', '/issuer/offer', {
    response_type: 'uri',
    credentialConfigurationIds: ['membership'],
    flow: 'pre_authorized_code',
  });
  expect(offer.ok, `create an issuance offer: ${await offer.clone().text()}`).toBe(true);
  const { uri, session } = (await offer.json()) as { uri: string; session: string };
  await acceptCredentialOffer(uri);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/session-management/${session}`);
  const card = page.locator('app-credential-status-card');
  await expect(card.getByRole('heading', { name: 'Credential Status' })).toBeVisible();
  await expect(card).toContainText('1 valid');

  await changeStatus(page, 'Suspend');
  await expect(page.getByText('Credentials suspended')).toBeVisible();
  await expect(card).toContainText('1 suspended');

  await changeStatus(page, 'Reinstate');
  await expect(card).toContainText('1 valid');

  await changeStatus(page, 'Revoke');
  await expect(card).toContainText('1 revoked');
  for (const action of ['Suspend', 'Reinstate', 'Revoke']) {
    await expect(card.getByRole('button', { name: action })).toHaveCount(0);
  }
});
