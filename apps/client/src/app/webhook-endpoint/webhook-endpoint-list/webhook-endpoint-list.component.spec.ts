import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { JwtService } from '../../services/jwt.service';
import { WebhookEndpointService } from '../webhook-endpoint.service';
import { WebhookEndpointListComponent } from './webhook-endpoint-list.component';

const ownership = { provide: ConfigOwnershipService, useValue: { get: async () => undefined } };
const manager = { provide: JwtService, useValue: { hasRole: () => true } };

const orders = {
  id: 'orders',
  name: 'Order events',
  description: 'Shop backend',
  url: 'https://shop.example/hooks',
  auth: { type: 'apiKey', config: { headerName: 'X-Key' } },
};
const audit = {
  id: 'audit',
  name: 'Audit trail',
  url: 'https://audit.example/in',
  auth: { type: 'none' },
};

describe('WebhookEndpointListComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function render(service: Record<string, unknown>, options: { canManage?: boolean } = {}) {
    const snackBar = { open: vi.fn() };
    TestBed.configureTestingModule({
      imports: [WebhookEndpointListComponent],
      providers: [
        provideRouter([]),
        { provide: WebhookEndpointService, useValue: service },
        { provide: JwtService, useValue: { hasRole: () => options.canManage ?? true } },
        { provide: MatSnackBar, useValue: snackBar },
        ownership,
      ],
    });
    const fixture = TestBed.createComponent(WebhookEndpointListComponent);
    const loadItems = vi.spyOn(fixture.componentInstance, 'loadItems');
    fixture.detectChanges();
    await loadItems.mock.results[0].value;
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement, snackBar };
  }

  function rowNames(element: HTMLElement): string[] {
    return [...element.querySelectorAll('a.endpoint-link')].map((a) => a.textContent!.trim());
  }

  it('shows loading, then the error with a retry, then the empty state', async () => {
    let fail!: (error: unknown) => void;
    const getAll = vi
      .fn()
      .mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
      .mockResolvedValueOnce([]);
    TestBed.configureTestingModule({
      imports: [WebhookEndpointListComponent],
      providers: [
        provideRouter([]),
        { provide: WebhookEndpointService, useValue: { getAll } },
        manager,
        ownership,
      ],
    });
    const fixture = TestBed.createComponent(WebhookEndpointListComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('mat-spinner')).not.toBeNull();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fail({ statusCode: 403, message: 'Forbidden resource' });
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load webhook endpoints: Forbidden resource'
    );
    expect(element.querySelector('table')).toBeNull();

    (element.querySelector('app-load-error button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).toContain('No webhook endpoints yet.');
  });

  it('lists the endpoints by name with a link, their ID, URL and authentication', async () => {
    const { element } = await render({ getAll: async () => [orders, audit] });

    expect(rowNames(element)).toEqual(['Audit trail', 'Order events']);
    expect(element.querySelector('a.endpoint-link')?.getAttribute('href')).toBe('/audit');
    const cells = [...element.querySelectorAll('tr[mat-row]')].map((row) =>
      [...row.querySelectorAll('td')].slice(1, 3).map((td) => td.textContent?.trim())
    );
    expect(cells).toEqual([
      ['https://audit.example/in', 'No authentication'],
      ['https://shop.example/hooks', 'API key'],
    ]);
    expect(element.querySelector('tr[mat-row] small')?.textContent).toBe('audit');
    expect(element.querySelector('.table-title output')?.textContent?.trim()).toBe('2 endpoints');
    expect(
      [...element.querySelectorAll('tr[mat-row] .row-actions [aria-label]')].map((action) =>
        action.getAttribute('aria-label')
      )
    ).toEqual([
      'Edit webhook endpoint Audit trail',
      'Delete webhook endpoint Audit trail',
      'Edit webhook endpoint Order events',
      'Delete webhook endpoint Order events',
    ]);
  });

  it('searches the ID, name, description and URL, and says when nothing matches', async () => {
    const { fixture, element } = await render({ getAll: async () => [orders, audit] });
    const component = fixture.componentInstance;

    for (const [search, expected] of [
      ['SHOP BACKEND', ['Order events']],
      ['audit.example', ['Audit trail']],
      ['orders', ['Order events']],
    ] as const) {
      component.search = search;
      fixture.detectChanges();
      expect(rowNames(element)).toEqual(expected);
    }
    expect(element.querySelector('.table-title output')?.textContent?.trim()).toBe(
      '1 of 2 endpoints'
    );

    component.search = 'nothing';
    fixture.detectChanges();
    expect(element.querySelector('.no-match')?.textContent).toContain(
      'No webhook endpoint matches "nothing".'
    );
    const clear = [...element.querySelectorAll<HTMLButtonElement>('.no-match button')][0];
    clear.click();
    fixture.detectChanges();
    expect(rowNames(element)).toEqual(['Audit trail', 'Order events']);
  });

  it('deletes an endpoint once after confirming, removes its row and focuses the next one', async () => {
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { fixture, element, snackBar } = await render({
      getAll: async () => [orders, audit],
      delete: remove,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const component = fixture.componentInstance;

    const first = component.deleteEndpoint(audit as never);
    fixture.detectChanges();
    const button = element.querySelector<HTMLButtonElement>(
      '[aria-label="Delete webhook endpoint Audit trail"]'
    )!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    // A second click while the delete runs does nothing.
    await component.deleteEndpoint(audit as never);
    finish();
    await first;
    fixture.detectChanges();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('audit');
    expect(rowNames(element)).toEqual(['Order events']);
    // The row with the focused Delete is gone; focus moves to the endpoint now in its place.
    await vi.waitFor(() => {
      TestBed.inject(ApplicationRef).tick();
      expect(document.activeElement).toBe(element.querySelector('a.endpoint-link'));
    });
    expect(snackBar.open).toHaveBeenCalledWith(
      'Webhook endpoint deleted successfully',
      'Close',
      expect.anything()
    );
  });

  it('focuses the heading after the last endpoint was deleted', async () => {
    const { fixture, element } = await render({
      getAll: async () => [audit],
      delete: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    element.querySelector<HTMLButtonElement>('.delete-action')!.focus();

    await fixture.componentInstance.deleteEndpoint(audit as never);
    fixture.detectChanges();

    expect(element.textContent).toContain('No webhook endpoints yet.');
    await vi.waitFor(() => {
      TestBed.inject(ApplicationRef).tick();
      expect(document.activeElement).toBe(element.querySelector('h1'));
    });
  });

  it("lets another endpoint's Delete run while one delete is pending", async () => {
    const remove = vi.fn(() => new Promise<void>(() => undefined));
    const { fixture, element } = await render({
      getAll: async () => [orders, audit],
      delete: remove,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    void fixture.componentInstance.deleteEndpoint(audit as never);
    void fixture.componentInstance.deleteEndpoint(orders as never);
    fixture.detectChanges();

    expect(remove.mock.calls).toEqual([['audit'], ['orders']]);
    // Each Delete shows it is busy.
    expect(
      [...element.querySelectorAll('.delete-action')].map((b) => b.getAttribute('aria-disabled'))
    ).toEqual(['true', 'true']);
  });

  it('keeps the endpoint when the delete is not confirmed, fails, or the caller lacks the role', async () => {
    const remove = vi.fn().mockRejectedValue({ statusCode: 409, message: 'In use' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { fixture, element, snackBar } = await render({
      getAll: async () => [audit],
      delete: remove,
    });
    await fixture.componentInstance.deleteEndpoint(audit as never);
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await fixture.componentInstance.deleteEndpoint(audit as never);
    fixture.detectChanges();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(rowNames(element)).toEqual(['Audit trail']);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Failed to delete webhook endpoint: In use',
      'Close',
      expect.anything()
    );
    // The failed delete leaves Delete usable.
    await fixture.componentInstance.deleteEndpoint(audit as never);
    expect(remove).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule();

    const denied = await render(
      { getAll: async () => [audit], delete: remove },
      { canManage: false }
    );
    expect(
      denied.element
        .querySelector('[aria-label="Delete webhook endpoint Audit trail"]')
        ?.getAttribute('aria-disabled')
    ).toBe('true');
    await denied.fixture.componentInstance.deleteEndpoint(audit as never);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  describeListStates({
    component: WebhookEndpointListComponent,
    service: WebhookEndpointService,
    fetchMethod: 'getAll',
    item: { id: 'notify', name: 'Notify', url: 'https://hooks.example', auth: { type: 'none' } },
    loading: 'Loading webhook endpoints',
    empty: 'No webhook endpoints yet.',
    create: 'Create webhook endpoint',
    failure: 'Failed to load webhook endpoints',
    heading: 'h1',
    firstCell: 'Notify',
    providers: [manager, ownership],
  });
});
