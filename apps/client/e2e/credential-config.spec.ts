import type { ClaimFieldDefinitionDto } from '@eudiplo/sdk-core';
import { test, expect } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { tenantToken, writeConfig } from './support/clients';

test('create credential config', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  // The template's id (pid) usually exists already.
  const id = `e2e-pid-${Date.now()}`;
  await page.goto('/');

  await page.getByText('Credential Types').click();
  await page.getByRole('button').filter({ hasText: 'add' }).click();
  await page.getByRole('button', { name: 'Templates' }).click();
  await page
    .getByRole('menuitem', {
      name: 'PID (Personal Identity Document) German Personal Identity Document configuration',
    })
    .click();
  await page.getByRole('textbox', { name: 'Configuration ID' }).fill(id);
  // Guided setup: Basics, Claims, Appearance, Settings, Review
  for (let step = 0; step < 4; step++) {
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('button', { name: 'Create Configuration' }).click();
  await expect(page).toHaveURL(/\/credential-config$/);
  await expect(page.getByText(id, { exact: true })).toBeVisible();
});

test('a failed load says why and loads again on Retry', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  let failLoading = true;
  await page.route('**/api/issuer/credentials', (route) =>
    failLoading && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { message: 'Internal server error' } })
      : route.fallback()
  );
  await page.goto('/credential-config');

  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Failed to load credential configurations: Internal server error' });
  await expect(alert).toBeVisible();
  await expect(page.getByText('No credential configurations yet.')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);

  failLoading = false;
  await page.getByRole('button', { name: 'Retry' }).click();

  // The table, or the empty state on a tenant without configurations.
  await expect(
    page.getByRole('table').or(page.getByText('No credential configurations yet.'))
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  // Retry left with the error card, so keyboard focus continues from the page heading.
  await expect(
    page.getByRole('heading', { name: 'Credential Configurations', level: 2 })
  ).toBeFocused();
});

test('saves edited claim constraints and keeps untouched ones', async ({ page, request }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-constraints-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Claim constraints',
          vct: `urn:${id}`,
          config: {
            format: 'dc+sd-jwt',
            display: [{ name: 'Constraints', description: 'Constraints', locale: 'en-US' }],
          },
          fields: [
            { path: ['birthdate'], type: 'string', constraints: { pattern: '^\\d{4}$' } },
            { path: ['nationalities'], type: 'array', constraints: { items: { type: 'string' } } },
          ],
        },
      }),
    `create ${id}`
  );

  try {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Claims/ }).click();
    await page.getByRole('button', { name: /^birthdate string/ }).click();
    const constraints = page
      .getByRole('region', { name: /^birthdate string/ })
      .getByRole('textbox', { name: 'Constraints' });
    await expect(constraints).toHaveValue(/"pattern"/);

    await constraints.fill('{ "pattern": ');
    await constraints.blur();
    await expect(page.getByText('Enter valid JSON: ')).toBeVisible();

    // Constraints accept only JSON Schema keywords, so Save refuses a misspelled one
    // without sending it.
    const saves: string[] = [];
    const recordSave = (sent: { method(): string; url(): string }) => {
      if (sent.method() !== 'GET' && sent.url().includes(`/issuer/credentials/${id}`)) {
        saves.push(sent.method());
      }
    };
    page.on('request', recordSave);
    await constraints.fill('{ "patern": "^\\\\d{4}$" }');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page.getByText('Not a supported JSON Schema keyword: patern.')).toBeVisible();
    await expect(page.getByText(/Check the highlighted fields in Claims/)).toBeVisible();
    page.off('request', recordSave);
    expect(saves).toEqual([]);

    await constraints.fill('{ "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}$" }');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    const fields = ((await response.json()) as { fields: ClaimFieldDefinitionDto[] }).fields;
    expect(fields.find((field) => field.path[0] === 'birthdate')?.constraints).toEqual({
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    });
    expect(fields.find((field) => field.path[0] === 'nationalities')?.constraints).toEqual({
      items: { type: 'string' },
    });
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});
