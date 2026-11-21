import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { client, type TenantResponseDto } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { buildSettingGroups, TenantShowComponent } from './tenant-show.component';

describe('TenantShowComponent', () => {
  let fixture: ComponentFixture<TenantShowComponent>;
  let tenantResponse: { status: number; body: unknown };
  let requests: string[];

  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  beforeEach(async () => {
    requests = [];
    tenantResponse = {
      status: 200,
      body: {
        id: 'acme',
        name: 'ACME Corp',
        description: null,
        status: 'active',
        sessionConfig: { ttlSeconds: 7 * 86_400, cleanupMode: 'anonymize' },
        statusListConfig: null,
        defaultKeyChains: { access: 'access-chain' },
        clients: [{ clientId: 'acme-admin', roles: ['clients:manage'] }],
      },
    };
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (request.method === 'DELETE') return new Response(null, { status: 200 });
        const { status, body } =
          url.pathname === '/api/tenant/acme' ? tenantResponse : { status: 200, body: {} };
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      imports: [TenantShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'acme' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
  });

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(TenantShowComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      if (page.querySelector('mat-spinner[aria-label="Loading tenant"]')) {
        throw new Error('still loading');
      }
    });
    return page;
  }

  it('heads the page with the tenant, its ID, status and missing description', async () => {
    const page = await render();

    expect(text(page.querySelector('h1'))).toBe('ACME Corp');
    expect(text(page.querySelector('.id-chip code'))).toBe('acme');
    expect(text(page.querySelector('.hero .badge'))).toBe('active');
    expect(text(page.querySelector('.hero-description'))).toBe('No description');
    expect(text(page.querySelector('.clients-card mat-card-subtitle'))).toBe(
      '1 client signs in to this tenant'
    );
    expect(page.querySelector('app-client-list')).not.toBeNull();
  });

  it('lists the settings, and the instance default where the tenant has none', async () => {
    const page = await render();

    const groups = Array.from(page.querySelectorAll('.setting-group'), (group) => [
      text(group.querySelector('h3'))?.replace(/^\S+ /, ''),
      Array.from(group.querySelectorAll('.setting'), (row) => [
        text(row.querySelector('dt')),
        text(row.querySelector('dd')),
        row.querySelector('dd')?.classList.contains('default'),
      ]),
    ]);
    expect(groups).toEqual([
      [
        'Sessions',
        [
          ['Kept for', '7 days', false],
          ['Afterwards', 'Personal data removed, metadata kept', false],
        ],
      ],
      [
        'Status lists',
        [
          ['Capacity', 'Instance default', true],
          ['Bits per entry', 'Instance default', true],
          ['Token lifetime', 'Instance default', true],
          ['New token after a change', 'Instance default', true],
          ['Aggregation', 'Instance default', true],
        ],
      ],
      [
        'Default key chains',
        [
          ['Access', 'access-chain', false],
          ['Authorization server', 'Oldest of the tenant', true],
        ],
      ],
    ]);
  });

  it('says when the tenant has no clients', async () => {
    tenantResponse = {
      status: 200,
      body: { id: 'acme', name: 'ACME Corp', status: 'active', clients: [] },
    };

    const page = await render();

    expect(page.querySelector('app-client-list')).toBeNull();
    expect(text(page.querySelector('.empty-clients'))).toContain('This tenant has no clients yet.');
    // The operator has no tenant, so the page names the ways that do add a client.
    expect(text(page.querySelector('.empty-clients'))).toContain('send POST /api/tenant again');
  });

  it('deletes the tenant once its ID is typed and returns to the list', async () => {
    const prompt = vi.fn<typeof globalThis.prompt>(() => 'acme');
    vi.stubGlobal('prompt', prompt);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await render();
    // The component imports MatSnackBarModule, which gives it its own MatSnackBar
    const snackBar = vi.spyOn(
      (fixture.componentInstance as unknown as { snackBar: MatSnackBar }).snackBar,
      'open'
    );

    await fixture.componentInstance.deleteTenant();

    expect(requests).toContain('DELETE /api/tenant/acme');
    expect(snackBar).toHaveBeenCalledWith('Tenant deleted successfully', 'Close', {
      duration: 3000,
    });
    expect(navigate).toHaveBeenCalledWith(['../'], expect.anything());
    expect(prompt.mock.lastCall?.[0]).toContain(
      'Delete tenant "ACME Corp" (acme) and all its data?'
    );
    expect(prompt.mock.lastCall?.[0]).toContain('Type the tenant ID "acme" to confirm.');
  });

  it('keeps the tenant when the deletion is cancelled', async () => {
    vi.stubGlobal('prompt', () => null);
    await render();

    await fixture.componentInstance.deleteTenant();

    expect(requests).not.toContain('DELETE /api/tenant/acme');
  });

  it('keeps the tenant and says so when another ID, such as its name, is typed', async () => {
    vi.stubGlobal('prompt', () => 'ACME Corp');
    await render();
    const snackBar = vi.spyOn(
      (fixture.componentInstance as unknown as { snackBar: MatSnackBar }).snackBar,
      'open'
    );

    await fixture.componentInstance.deleteTenant();

    expect(requests).not.toContain('DELETE /api/tenant/acme');
    expect(snackBar.mock.lastCall?.[0]).toBe(
      'The ID you typed is not "acme". The tenant was not deleted.'
    );
  });

  it('sends one delete when Delete tenant is selected twice, and disables it meanwhile', async () => {
    const prompt = vi.fn<typeof globalThis.prompt>(() => 'acme');
    vi.stubGlobal('prompt', prompt);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await render();
    const component = fixture.componentInstance;

    const first = component.deleteTenant();
    expect(component.deleting).toBe(true);
    await component.deleteTenant();
    await first;

    expect(prompt).toHaveBeenCalledOnce();
    expect(requests.filter((r) => r === 'DELETE /api/tenant/acme')).toHaveLength(1);
    expect(component.deleting).toBe(false);
  });

  it('says why the tenant could not be loaded instead of staying empty', async () => {
    tenantResponse = { status: 404, body: { statusCode: 404, message: 'Tenant not found' } };

    const page = await render();

    expect(text(page.querySelector('app-load-error'))).toContain(
      'Failed to load tenant: Tenant not found'
    );
    expect(page.querySelector('h1')).toBeNull();
  });
});

describe('buildSettingGroups', () => {
  it('describes every status list setting the tenant sets', () => {
    const groups = buildSettingGroups({
      id: 'acme',
      name: 'ACME',
      status: 'active',
      statusListConfig: {
        capacity: 10000,
        bits: 2,
        ttl: 3600,
        immediateUpdate: false,
        enableAggregation: true,
      },
      sessionConfig: { cleanupMode: 'full' },
    } as TenantResponseDto);

    expect(groups[1].settings.map((setting) => setting.value)).toEqual([
      (10000).toLocaleString(),
      '2',
      '1 hour',
      'When the token expires',
      'On',
    ]);
    expect(groups[0].settings.map((setting) => setting.value)).toEqual([
      undefined,
      'Deleted completely',
    ]);
  });
});
