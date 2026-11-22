import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';
import { createKeyChain } from './support/key-chains';
import { holdRequests } from './support/routes';

// "Rotate key now" asks first, names the key chain and what happens to its certificate, and
// sends one rotation while it runs. The demo tenant's key chains are file-managed, so the test
// gets its own tenant.

test.use({ storageState: { cookies: [], origins: [] } });

const api = resolvedE2EConfig.apiBaseUrl;

/** Turns rotation on, so the key chain offers "Rotate key now". */
async function enableRotation(token: string, id: string): Promise<void> {
  const response = await fetch(`${api}/api/key-chain/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotationPolicy: { enabled: true, intervalDays: 30 } }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
});

test('asks before rotating a key chain and rotates it once', async ({ page }) => {
  const tenant = await createTenant('key-rotate-e2e', 'Key Rotate E2E', ['keys:manage']);
  const id = await createKeyChain(tenant.token, 'attestation', 'Rotating key');
  await enableRotation(tenant.token, id);
  const rotations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/rotate')) {
      rotations.push(new URL(request.url()).pathname);
    }
  });

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/keys');
  const rotate = page
    .getByRole('row', { name: /Rotating key/ })
    .getByRole('button', { name: 'Rotate key chain Rotating key now' });
  // appConfigManaged holds clicks back until its ownership lookup has answered.
  await expect(rotate).not.toHaveAttribute('aria-busy', 'true');

  // Dismissing the question keeps the key: no rotation leaves the page.
  const dismissed = new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      const message = dialog.message();
      void dialog.dismiss().then(() => resolve(message));
    })
  );
  await rotate.click();
  const question = await dismissed;
  expect(question).toContain(`Rotate key chain "Rotating key" (${id}) now?`);
  expect(question).toContain('The new key gets a new self-signed certificate.');
  expect(question).toContain('This cannot be undone.');
  expect(rotations).toEqual([]);

  // While the rotation runs, the button waits instead of sending a second one.
  const { sent, release } = await holdRequests(page, 'POST', `/api/key-chain/${id}/rotate`);
  page.once('dialog', (dialog) => void dialog.accept());
  await rotate.click();
  await sent;
  await expect(rotate).toHaveAttribute('aria-disabled', 'true');
  await rotate.click({ force: true });

  release();
  await expect(page.getByText('Key chain rotated', { exact: true })).toBeVisible();
  expect(rotations).toHaveLength(1);

  // The key page asks the same question.
  await page.goto(`/keys/${id}`);
  const rotateOnPage = page.getByRole('button', { name: 'Rotate key now' });
  await expect(rotateOnPage).not.toHaveAttribute('aria-busy', 'true');
  const asked = new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      const message = dialog.message();
      void dialog.accept().then(() => resolve(message));
    })
  );
  await rotateOnPage.click();
  expect(await asked).toContain(`Rotate key chain "Rotating key" (${id}) now?`);
  await expect(page.getByText('Key chain rotated successfully')).toBeVisible();
  expect(rotations).toHaveLength(2);
});
