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
    if (step === 2) {
      // The template's two display entries replace the empty one, each in its own card.
      const descriptions = page.getByRole('textbox', { name: 'Description' });
      await expect(descriptions).toHaveCount(2);
      await expect(descriptions.nth(0)).toHaveValue('PID Credential');
      await expect(descriptions.nth(1)).toHaveValue('PID Nachweis');
    }
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

test('edits every display entry and keeps all of them on save', async ({ page, request }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-displays-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  const display = [
    {
      name: 'Membership',
      description: 'Member card',
      locale: 'en-US',
      background_color: '#112233',
      text_color: '#FFFFFF',
    },
    {
      name: 'Mitgliedschaft',
      description: 'Mitgliedskarte',
      locale: 'de-DE',
      background_color: '#445566',
      text_color: '#000000',
    },
  ];
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Display entries',
          vct: `urn:${id}`,
          config: { format: 'dc+sd-jwt', display },
          fields: [],
        },
      }),
    `create ${id}`
  );

  try {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Appearance/ }).click();
    const names = page.getByRole('textbox', { name: 'Display Name' });
    await expect(names).toHaveCount(2);
    await expect(names.nth(0)).toHaveValue('Membership');
    await expect(names.nth(1)).toHaveValue('Mitgliedschaft');

    await names.nth(1).fill('Mitgliedschaft Plus');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    expect(((await response.json()) as { config: { display: unknown[] } }).config.display).toEqual([
      display[0],
      { ...display[1], name: 'Mitgliedschaft Plus' },
    ]);

    // Removing the first entry leaves the card of the second one, not a card of the removed one.
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Appearance/ }).click();
    await expect(names).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove display configuration 1' }).click();
    await expect(names).toHaveCount(1);
    await expect(names).toHaveValue('Mitgliedschaft Plus');
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('Mitgliedskarte');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const afterRemove = await request.get(`${url}/${id}`, { headers });
    expect(afterRemove.ok(), `GET ${id}`).toBe(true);
    expect(
      ((await afterRemove.json()) as { config: { display: unknown[] } }).config.display
    ).toEqual([{ ...display[1], name: 'Mitgliedschaft Plus' }]);
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});

test('keeps optional display fields as loaded and refuses colors and locales wallets cannot read', async ({
  page,
  request,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-display-optional-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  // Only name and locale are required; colors are CSS Color Level 3 numerical values.
  const display = [
    { name: 'Membership', locale: 'en-US' },
    {
      name: 'Mitgliedschaft',
      locale: 'de-DE',
      background_color: 'rgb(18, 16, 124)',
      text_color: '#fff',
    },
  ];
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Optional display fields',
          vct: `urn:${id}`,
          config: { format: 'dc+sd-jwt', display },
          fields: [],
        },
      }),
    `create ${id}`
  );

  try {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Appearance/ }).click();
    await expect(page.getByRole('textbox', { name: 'Display Name' })).toHaveCount(2);
    const [first, second] = [
      page.locator('.display-config-card').first(),
      page.locator('.display-config-card').nth(1),
    ];
    await expect(first.getByRole('textbox', { name: 'Description' })).toHaveValue('');
    await first.getByRole('button', { name: 'Colors and images (optional)' }).click();
    await expect(first.getByRole('textbox', { name: 'Background Color' })).toHaveValue('');

    // A color wallets cannot read is refused with the accepted forms.
    const text = first.getByRole('textbox', { name: 'Text Color' });
    await expect(text).toHaveValue('');
    await text.fill('navy');
    await text.blur();
    const colorError = first.getByText(
      'Use #rgb, #rrggbb, transparent, or lowercase rgb(), rgba(), hsl() or hsla() with commas'
    );
    await expect(colorError).toBeVisible();
    await expect(text).toHaveAttribute('aria-invalid', 'true');
    await text.fill('');
    await expect(colorError).toHaveCount(0);

    // A locale the other entry uses cannot be chosen: wallets accept one entry per language.
    await expect(second.getByRole('combobox', { name: 'Locale' })).toHaveText(/German/);
    await first.getByRole('combobox', { name: 'Locale' }).click();
    await expect(page.getByRole('option', { name: 'German (Germany)' })).toBeDisabled();
    await expect(page.getByRole('option', { name: 'French (France)' })).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    expect(((await response.json()) as { config: { display: unknown[] } }).config.display).toEqual(
      display
    );
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});

test('creates a configuration whose display has only a name', async ({ page, request }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-display-minimal-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };

  await page.goto('/credential-config/create');
  // Basics, without the optional description
  await page.getByRole('textbox', { name: 'Configuration ID' }).fill(id);
  await page.getByText('No (Custom URI)').click();
  await page.getByRole('textbox', { name: 'VCT URI' }).fill(`urn:${id}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  // Claims
  await page.getByRole('button', { name: 'Continue' }).click();
  // Appearance: no description and no colors
  await page.getByRole('textbox', { name: 'Display Name' }).fill('Membership');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Settings
  await page.getByRole('button', { name: 'Continue' }).click();
  // Review: no dash after the configuration or an entry without description
  await expect(page.getByRole('definition').first()).toHaveText(id);
  await expect(page.getByText('Membership (en-US)', { exact: true })).toBeVisible();

  try {
    await page.getByRole('button', { name: 'Create Configuration' }).click();
    await expect(page).toHaveURL(/\/credential-config$/);

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    const saved = (await response.json()) as {
      description?: string | null;
      config: { display: unknown[] };
    };
    expect(saved.config.display).toEqual([{ name: 'Membership', locale: 'en-US' }]);
    expect(saved.description ?? null).toBeNull();
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
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

    // The show page lists each field's constraints, edited and untouched alike.
    await page.getByRole('tab', { name: /Claims & Disclosure/ }).click();
    const matrix = page.locator('.claims-matrix');
    await expect(matrix.locator('.claims-matrix-row', { hasText: 'birthdate' })).toContainText(
      '"pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"'
    );
    await expect(matrix.locator('.claims-matrix-row', { hasText: 'nationalities' })).toContainText(
      '"items"'
    );

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

test('removing a claim or label leaves the next one in its place with its own values', async ({
  page,
  request,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-claim-rows-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Claim rows',
          vct: `urn:${id}`,
          config: {
            format: 'dc+sd-jwt',
            display: [{ name: 'Claim rows', description: 'Claim rows', locale: 'en-US' }],
          },
          fields: [
            {
              path: ['given_name'],
              type: 'string',
              display: [
                { locale: 'en-US', name: 'Given name' },
                { locale: 'de-DE', name: 'Vorname' },
              ],
            },
            {
              path: ['family_name'],
              type: 'string',
              display: [{ locale: 'en-US', name: 'Family name' }],
            },
            {
              path: ['birthdate'],
              type: 'string',
              display: [
                { locale: 'en-US', name: 'Birth date' },
                { locale: 'de-DE', name: 'Geburtsdatum' },
              ],
            },
          ],
        },
      }),
    `create ${id}`
  );

  try {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Claims/ }).click();
    await page.getByRole('button', { name: /^family_name string/ }).click();
    await page
      .getByRole('region', { name: /^family_name string/ })
      .getByRole('button', { name: 'Remove Field' })
      .click();

    // The next claim takes the place and the focus of the removed one, with its own values.
    await expect(page.getByRole('button', { name: /^family_name string/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^birthdate string/ })).toBeFocused();
    await page.keyboard.press('Enter');
    const birthdate = page.getByRole('region', { name: /^birthdate string/ });
    await expect(birthdate.getByRole('textbox', { name: 'Path' })).toHaveValue('birthdate');
    await birthdate.getByRole('textbox', { name: 'Default Value' }).fill('1990-01-01');

    // The next label of the same claim takes the focus, not a label of an earlier claim.
    const birthdateLabels = birthdate.getByRole('textbox', { name: 'Name', exact: true });
    await birthdate.getByRole('button', { name: 'Remove label en-US of claim 2' }).click();
    await expect(birthdateLabels).toHaveCount(1);
    await expect(birthdateLabels).toHaveValue('Geburtsdatum');
    await expect(birthdateLabels).toBeFocused();
    // Without labels left, focus goes to the claim's Add Label.
    await birthdate.getByRole('button', { name: 'Remove label de-DE of claim 2' }).click();
    await expect(birthdateLabels).toHaveCount(0);
    await expect(birthdate.getByRole('button', { name: 'Add Label' })).toBeFocused();

    await page.getByRole('button', { name: /^given_name string/ }).click();
    const givenName = page.getByRole('region', { name: /^given_name string/ });
    await givenName.getByRole('button', { name: 'Remove label en-US of claim 1' }).click();
    const givenNameLabels = givenName.getByRole('textbox', { name: 'Name', exact: true });
    await expect(givenNameLabels).toHaveCount(1);
    await expect(givenNameLabels).toHaveValue('Vorname');
    await expect(givenNameLabels).toBeFocused();

    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    const fields = ((await response.json()) as { fields: ClaimFieldDefinitionDto[] }).fields;
    expect(fields.map((field) => field.path)).toEqual([['given_name'], ['birthdate']]);
    expect(fields[0].defaultValue).toBeUndefined();
    expect(fields[0].display).toEqual([{ locale: 'de-DE', name: 'Vorname' }]);
    expect(fields[1].defaultValue).toBe('1990-01-01');
    expect(fields[1].display).toBeUndefined();
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});

test('moving or removing an interactive authorization step keeps each step with its values', async ({
  page,
  request,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-iae-steps-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  const step = (name: string) => ({
    type: 'redirect_to_web',
    label: name,
    url: `https://example.com/${name}`,
    description: `Step ${name}`,
  });
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Interactive authorization steps',
          vct: `urn:${id}`,
          config: {
            format: 'dc+sd-jwt',
            display: [{ name: 'Steps', description: 'Steps', locale: 'en-US' }],
          },
          fields: [],
          iaeActions: [step('a'), step('b'), step('c')],
        },
      }),
    `create ${id}`
  );
  const expectOrder = async (...names: string[]) => {
    for (const [index, name] of names.entries()) {
      await expect(urls.nth(index)).toHaveValue(`https://example.com/${name}`);
    }
  };
  const urls = page.getByRole('textbox', { name: 'Redirect URL' });

  try {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Settings/ }).click();
    await page.getByRole('button', { name: 'Interactive Authorization Actions' }).click();
    await expect(urls).toHaveCount(3);

    // A moved step shows its own values at its new position and keeps the focus.
    await page.getByRole('button', { name: 'Move step 3 up' }).click();
    await expectOrder('a', 'c', 'b');
    await expect(page.getByRole('button', { name: 'Move step 2 up' })).toBeFocused();

    // At the top, Move up keeps the focus and does nothing when pressed again.
    await page.keyboard.press('Enter');
    await expectOrder('c', 'a', 'b');
    const firstUp = page.getByRole('button', { name: 'Move step 1 up' });
    await expect(firstUp).toBeFocused();
    await expect(firstUp).toHaveAttribute('aria-disabled', 'true');
    await expect(firstUp).toHaveAccessibleDescription('Step 1 is already first');
    await page.keyboard.press('Enter');
    await expectOrder('c', 'a', 'b');

    await page.getByRole('button', { name: 'Move step 2 down' }).click();
    await expectOrder('c', 'b', 'a');
    const lastDown = page.getByRole('button', { name: 'Move step 3 down' });
    await expect(lastDown).toBeFocused();
    await expect(lastDown).toHaveAccessibleDescription('Step 3 is already last');

    // Dragging a step by its handle moves its values with it. The first card goes to the top
    // of the viewport, so the handle of the second one is on screen as well.
    await page
      .locator('.iae-action-card')
      .first()
      .evaluate((card) => card.scrollIntoView({ block: 'start' }));
    const handles = page.locator('.iae-action-card .drag-handle');
    const from = (await handles.nth(1).boundingBox())!;
    const to = (await handles.nth(0).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.up();
    await expectOrder('b', 'c', 'a');

    // Removing a step that is not the last focuses the step now in its place.
    await page.getByRole('button', { name: 'Remove step 2' }).click();
    await expect(urls).toHaveCount(2);
    await expectOrder('b', 'a');
    await expect(page.getByText('Step 2: Redirect to Web')).toBeFocused();

    await urls.nth(0).fill('https://example.com/b2');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));

    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    expect(((await response.json()) as { iaeActions: unknown[] }).iaeActions).toEqual([
      { ...step('b'), url: 'https://example.com/b2' },
      step('a'),
    ]);
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});

test('removing the last row of a list moves focus to its Add button', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  await page.goto('/credential-config/create');
  await page.getByRole('button', { name: 'Show all settings' }).click();

  await page.getByRole('tab', { name: /Claims/ }).click();
  const addField = page.getByRole('button', { name: 'Add Field' });
  await addField.click();
  await page.getByRole('button', { name: 'Remove Field' }).click();
  await expect(page.getByRole('button', { name: 'Remove Field' })).toHaveCount(0);
  await expect(addField).toBeFocused();

  // A display entry other than the first goes to the one before it.
  await page.getByRole('tab', { name: /Appearance/ }).click();
  await page.getByRole('button', { name: 'Add Display Configuration' }).click();
  await page.getByRole('button', { name: 'Remove display configuration 2' }).click();
  await expect(page.getByText('Display Configuration 1', { exact: true })).toBeFocused();

  await page.getByRole('tab', { name: /Settings/ }).click();
  await page.getByRole('button', { name: 'Interactive Authorization Actions' }).click();
  const addAction = page.getByRole('button', { name: 'Add Action' });
  await addAction.click();
  await page.getByRole('menuitem', { name: 'Redirect to Web' }).click();
  await page.getByRole('button', { name: 'Remove step 1' }).click();
  await expect(page.getByRole('button', { name: 'Remove step 1' })).toHaveCount(0);
  await expect(addAction).toBeFocused();
});

test('loading a template over existing claims shows and edits the loaded claims', async ({
  page,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  await page.goto('/credential-config/create');
  await page.getByRole('button', { name: 'Show all settings' }).click();
  await page.getByRole('tab', { name: /Claims/ }).click();
  await page.getByRole('button', { name: 'Add Field' }).click();
  await page.getByRole('textbox', { name: 'Path' }).fill('custom_claim');

  await page.getByRole('button', { name: 'Templates' }).click();
  await page
    .getByRole('menuitem', {
      name: 'PID (Personal Identity Document) German Personal Identity Document configuration',
    })
    .click();
  await expect(page.getByRole('button', { name: /^custom_claim/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^address\.country string/ }).click();
  const path = page
    .getByRole('region', { name: /^address\.country string/ })
    .getByRole('textbox', { name: 'Path' });
  await expect(path).toHaveValue('address.country');

  // The input edits the claim its panel shows, so the panel title follows it.
  await path.fill('address.country_code');
  await expect(page.getByRole('button', { name: /^address\.country_code string/ })).toBeVisible();
});

test('turns Revoke with Wallet Unit on and off with the settings it needs', async ({
  page,
  request,
}) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );
  const id = `e2e-wallet-unit-${Date.now()}`;
  const url = `${resolvedE2EConfig.apiBaseUrl}/api/issuer/credentials`;
  const headers = { Authorization: `Bearer ${await tenantToken(request)}` };
  await writeConfig(
    () =>
      request.post(url, {
        headers,
        data: {
          id,
          description: 'Wallet unit revocation',
          vct: `urn:${id}`,
          statusManagement: false,
          config: { format: 'dc+sd-jwt', display: [{ name: 'Member', locale: 'en-US' }] },
          fields: [],
        },
      }),
    `create ${id}`
  );
  const stored = async () => {
    const response = await request.get(`${url}/${id}`, { headers });
    expect(response.ok(), `GET ${id}`).toBe(true);
    return (await response.json()) as {
      revokeWithWalletUnit?: boolean;
      statusManagement?: boolean;
      config: { keyAttestationsRequired?: unknown };
    };
  };
  const openFeatures = async () => {
    await page.goto(`/credential-config/${id}/edit`);
    await page.getByRole('tab', { name: /Settings/ }).click();
    await page.getByRole('button', { name: 'Credential Features' }).click();
  };
  const revoke = page.getByRole('switch', { name: /^Revoke with Wallet Unit/ });
  const statusManagement = page.getByRole('switch', { name: /^Status Management/ });
  const keyAttestation = page.getByRole('switch', { name: /^Require Key Attestation/ });

  try {
    await openFeatures();
    await expect(revoke).not.toBeChecked();
    await expect(statusManagement).not.toBeChecked();
    await revoke.click();
    await expect(statusManagement).toBeChecked();
    await expect(statusManagement).toBeDisabled();
    await expect(statusManagement).toHaveAccessibleName(/Required by Revoke with Wallet Unit/);
    await expect(keyAttestation).toBeChecked();
    await expect(keyAttestation).toBeDisabled();
    // Locked, but still reachable with Tab so that the reason can be read.
    await statusManagement.focus();
    await expect(statusManagement).toBeFocused();
    await keyAttestation.focus();
    await expect(keyAttestation).toBeFocused();
    await expect(keyAttestation).toHaveAccessibleName(/Required by Revoke with Wallet Unit/);
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));
    expect(await stored()).toMatchObject({
      revokeWithWalletUnit: true,
      statusManagement: true,
      config: { keyAttestationsRequired: {} },
    });

    await page.getByRole('tab', { name: /Business Logic/ }).click();
    await expect(page.getByText('Required, no level constraints')).toBeVisible();
    await expect(
      page.getByText(
        'Enabled: credentials are revoked when their wallet unit attestation is revoked'
      )
    ).toBeVisible();

    // Turning it off unlocks the settings it needed, which then can be turned off as well.
    await openFeatures();
    await expect(revoke).toBeChecked();
    await revoke.click();
    await expect(keyAttestation).toBeEnabled();
    await keyAttestation.click();
    await statusManagement.click();
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page).toHaveURL(new RegExp(`/credential-config/${id}$`));
    const after = await stored();
    expect(after).toMatchObject({ revokeWithWalletUnit: false, statusManagement: false });
    expect(after.config.keyAttestationsRequired).toBeUndefined();
  } finally {
    await writeConfig(() => request.delete(`${url}/${id}`, { headers }), `delete ${id}`);
  }
});
