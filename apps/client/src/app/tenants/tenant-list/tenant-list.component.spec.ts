import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantListComponent } from './tenant-list.component';

describe('TenantListComponent', () => {
  let component: TenantListComponent;
  let fixture: ComponentFixture<TenantListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TenantListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TenantListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('TenantListComponent table', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('shows each tenant by name and ID, and says when its status is not set', async () => {
    stubFetch(200, [
      { id: 'acme', name: 'ACME Corp', description: 'Main tenant', status: 'active' },
      { id: 'legacy', name: 'Legacy', description: null, status: null },
    ]);
    await TestBed.configureTestingModule({
      imports: [TenantListComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(TenantListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelectorAll('tr.mat-mdc-row')).toHaveLength(2);
    });

    const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
    const rows = Array.from(page.querySelectorAll('tr.mat-mdc-row'), (row) => [
      text(row.querySelector('.tenant-copy strong')),
      text(row.querySelector('.tenant-copy code')),
      text(row.querySelector('td.mat-column-description')),
      text(row.querySelector('td.mat-column-status')),
    ]);
    expect(rows).toEqual([
      ['ACME Corp', 'acme', 'Main tenant', 'active'],
      ['Legacy', 'legacy', 'No description', 'Not set'],
    ]);
    expect(page.querySelector('output')?.textContent?.trim()).toBe('2 tenants');
    expect(page.querySelector('a.tenant-link')?.getAttribute('href')).toBe('/acme');
  });
});

describe('TenantListComponent search and pages', () => {
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  async function render(count: number) {
    stubFetch(
      200,
      Array.from({ length: count }, (_, index) => ({
        id: `tenant-${index + 1}`,
        name: index === 0 ? 'ACME Corp' : `Tenant ${index + 1}`,
        description: index === 1 ? 'Runs the acme pilot' : null,
        status: 'active',
      }))
    );
    await TestBed.configureTestingModule({
      imports: [TenantListComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(TenantListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('table')).not.toBeNull();
    });
    const ids = () =>
      Array.from(page.querySelectorAll('tr.mat-mdc-row .tenant-copy code'), (code) => text(code));
    return { fixture, component: fixture.componentInstance, page, ids };
  }

  it('shows the first page and moves to the next', async () => {
    const { fixture, component, page, ids } = await render(12);

    expect(ids()).toHaveLength(10);
    expect(page.querySelector('mat-paginator')).not.toBeNull();

    component.onPageChange({ pageIndex: 1, pageSize: 10, previousPageIndex: 0, length: 12 });
    fixture.detectChanges();

    expect(ids()).toEqual(['tenant-11', 'tenant-12']);
  });

  it('offers the page size in a menu and keeps the first tenant of the page in view', async () => {
    const { fixture, component, page, ids } = await render(30);
    const trigger = page.querySelector('.page-size-trigger') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Rows per page: 10');
    // The paginator's own select is replaced by the menu
    expect(page.querySelector('mat-paginator mat-select')).toBeNull();

    trigger.click();
    fixture.detectChanges();
    const options = Array.from(
      document.querySelectorAll('.m3-menu [role="menuitemradio"]'),
      (option) => [
        option.textContent?.replace('check', '').trim(),
        option.getAttribute('aria-checked'),
      ]
    );
    expect(options).toEqual([
      ['10 rows', 'true'],
      ['25 rows', 'false'],
      ['50 rows', 'false'],
    ]);
    (document.querySelectorAll('.m3-menu [role="menuitemradio"]')[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(ids()).toHaveLength(25);

    // From the second page of 25, tenant 26 stays in view at 10 per page
    component.onPageChange({ pageIndex: 1, pageSize: 25, previousPageIndex: 0, length: 30 });
    component.setPageSize(10);
    fixture.detectChanges();
    expect(component.pageIndex).toBe(2);
    expect(ids()[0]).toBe('tenant-21');
    expect(ids()).toContain('tenant-26');
  });

  it('needs no pages for a few tenants', async () => {
    const { page } = await render(3);

    expect(page.querySelector('mat-paginator')).toBeNull();
  });

  it('finds tenants by name, ID or description and starts on the first page', async () => {
    const { fixture, component, page, ids } = await render(12);
    component.onPageChange({ pageIndex: 1, pageSize: 10, previousPageIndex: 0, length: 12 });

    component.search = 'ACME';
    component.onSearchChange();
    fixture.detectChanges();

    // The name of the first tenant and the description of the second
    expect(ids()).toEqual(['tenant-1', 'tenant-2']);
    expect(component.pageIndex).toBe(0);
    expect(text(page.querySelector('output'))).toBe('2 of 12 tenants');

    component.search = 'tenant-12';
    component.onSearchChange();
    fixture.detectChanges();
    expect(ids()).toEqual(['tenant-12']);
  });

  it('says when no tenant matches and clears the search on request', async () => {
    const { fixture, component, page, ids } = await render(3);

    component.search = 'nothing';
    component.onSearchChange();
    fixture.detectChanges();

    expect(text(page.querySelector('.no-match'))).toContain('No tenant matches "nothing".');
    const clear = Array.from(page.querySelectorAll('.no-match button')).find(
      (button) => text(button) === 'Clear search'
    ) as HTMLButtonElement;
    clear.click();
    fixture.detectChanges();

    expect(component.search).toBe('');
    expect(ids()).toHaveLength(3);
  });

  it('sorts by name with numbers by value, and the other way round on request', async () => {
    const { fixture, component, ids } = await render(12);

    expect(ids().slice(0, 4)).toEqual(['tenant-1', 'tenant-2', 'tenant-3', 'tenant-4']);

    component.onSortChange({ active: 'name', direction: 'desc' });
    fixture.detectChanges();
    expect(ids().slice(0, 3)).toEqual(['tenant-12', 'tenant-11', 'tenant-10']);

    // Without a direction the API's order comes back
    component.onSortChange({ active: 'name', direction: '' });
    fixture.detectChanges();
    expect(ids()[0]).toBe('tenant-1');
  });

  it('opens a tenant through the link in its row, which keyboard and mouse share', async () => {
    const { page } = await render(3);
    const row = page.querySelector('tr.mat-mdc-row') as HTMLElement;

    // The link stretches over the row in CSS; the row itself has no click handler of its own
    expect(row.querySelector('a.tenant-link')?.getAttribute('href')).toBe('/tenant-1');
    // The actions button is not part of the link, so it opens its menu instead
    expect(row.querySelector('a.tenant-link button')).toBeNull();
    expect(row.querySelector('button[aria-label="Actions for tenant tenant-1"]')).not.toBeNull();
  });

  it('stays on a page that still has tenants after a delete', async () => {
    const { component } = await render(11);
    component.onPageChange({ pageIndex: 1, pageSize: 10, previousPageIndex: 0, length: 11 });
    expect(component.shownTenants.map((tenant) => tenant.id)).toEqual(['tenant-11']);

    component.tenants = component.tenants.filter((tenant) => tenant.id !== 'tenant-11');
    component.applyFilters();

    expect(component.pageIndex).toBe(0);
    expect(component.shownTenants).toHaveLength(10);
  });
});

describe('TenantListComponent errors', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
  });

  it('says why the tenants could not be loaded', async () => {
    stubFetch(403, { statusCode: 403, message: 'Forbidden resource' });
    const component = new TenantListComponent({ open: vi.fn() } as never);

    await component.loadTenants();

    expect(component.loadError).toBe('Failed to load tenants: Forbidden resource');
  });

  it('says why a tenant could not be deleted', async () => {
    stubFetch(409, { statusCode: 409, message: 'Tenant is file-managed' });
    vi.stubGlobal('confirm', () => true);
    const snackBar = { open: vi.fn() };
    const component = new TenantListComponent(snackBar as never);

    component.deleteTenant({ id: 't-1', name: 'Tenant' } as never);

    await vi.waitFor(() =>
      expect(snackBar.open.mock.lastCall?.[0]).toBe(
        'Failed to delete tenant: Tenant is file-managed'
      )
    );
  });
});

function stubFetch(status: number, body: unknown) {
  client.setConfig({
    fetch: vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  });
}
