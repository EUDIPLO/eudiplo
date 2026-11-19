import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// Webhook endpoints and attribute providers share one form. Creating one opens its own
// page, like the other create flows, and a URL the backend would not call is refused in
// the form before anything is sent.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('endpoint-create', 'Endpoint Create', ['issuance:manage']);
});

const flows = [
  { list: 'webhook-endpoints', id: 'billing-events', name: 'Billing events' },
  { list: 'attribute-providers', id: 'crm-claims', name: 'CRM claims' },
];

for (const flow of flows) {
  test(`checks the URL and opens the new item from ${flow.list}/create on its page`, async ({
    page,
  }) => {
    await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
    await page.goto(`/${flow.list}/create`);
    await page.getByRole('textbox', { name: 'ID', exact: true }).fill(flow.id);
    await page.getByRole('textbox', { name: 'Name' }).fill(flow.name);
    const url = page.getByRole('textbox', { name: 'URL' });
    await url.fill('example.com/in');

    const saves: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes(`/${flow.list}`)) {
        saves.push(request.url());
      }
    });
    const create = page.getByRole('button', { name: 'Create', exact: true });
    await expect(create).not.toHaveAttribute('aria-busy', 'true');
    await create.click();

    await expect(url).toBeFocused();
    await expect(
      page.getByText('Enter an absolute http or https URL, such as https://example.com/path')
    ).toBeVisible();
    expect(saves).toEqual([]);

    await url.fill('https://example.com/in');
    await create.click();

    await expect(page).toHaveURL(new RegExp(`/${flow.list}/${flow.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: flow.name })).toBeVisible();
    expect(saves).toHaveLength(1);
  });
}
