import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { AuditLogResponseDto } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { ACTION_TYPES, OBJECT_TYPES, detailsOf, objectTypeOf } from './activity-log-labels';
import { ActivityLogService } from './activity-log.service';
import { AdminActivityLogsComponent } from './admin-activity-logs.component';

const entry = (overrides: Partial<AuditLogResponseDto> = {}): AuditLogResponseDto => ({
  id: 'log-1',
  tenantId: 'root',
  actionType: 'tenant_updated',
  actorType: 'client',
  actorId: 'ops',
  changedFields: ['name'],
  timestamp: '2026-11-18T10:00:00.000Z',
  ...overrides,
});

describe('AdminActivityLogsComponent', () => {
  let fixture: ComponentFixture<AdminActivityLogsComponent>;
  let component: AdminActivityLogsComponent;
  let search: ReturnType<typeof vi.fn>;
  let retention: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  async function setup(queryParams: Record<string, string | string[]> = {}) {
    vi.useFakeTimers();
    search = vi.fn().mockResolvedValue({
      items: [entry()],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    retention = vi.fn().mockResolvedValue({ retentionDays: 0, maxEntriesPerTenant: 0 });
    await TestBed.configureTestingModule({
      imports: [AdminActivityLogsComponent],
      providers: [
        provideRouter([]),
        { provide: ActivityLogService, useValue: { search, retention } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams), queryParams } },
        },
      ],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(AdminActivityLogsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Let the debounced filter change through. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(300);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the first page without filters and keeps the URL clean', async () => {
    await setup();
    expect(search).toHaveBeenCalledExactlyOnceWith({ page: 1, pageSize: 25 });
    const params = navigate.mock.calls[0][1]!.queryParams!;
    expect(Object.values(params).every((value) => value === null)).toBe(true);
    expect(text()).toContain('Tenant Updated');
    expect(text()).toContain('ops (API Client)');
  });

  it('restores the filters from the URL and ignores unknown values', async () => {
    await setup({
      objectType: 'oidc_client',
      actionType: ['oidc_client_deleted', 'unknown_action'],
      actorType: 'user',
      actorId: 'alice',
      requestId: 'req-1',
      from: '2026-11-18T14:00',
      to: '2026-11-18T14:30',
      page: '3',
      pageSize: '50',
    });
    expect(search).toHaveBeenCalledWith({
      page: 3,
      pageSize: 50,
      objectType: 'oidc_client',
      actionType: ['oidc_client_deleted'],
      actorType: 'user',
      actorId: 'alice',
      requestId: 'req-1',
      from: new Date(2026, 10, 18, 14, 0).toISOString(),
      to: new Date(2026, 10, 18, 14, 30, 59, 999).toISOString(),
    });
    expect(component.filters.controls.time.value).toBe('custom');
  });

  it('turns a relative window into a start time and keeps it relative in the URL', async () => {
    await setup({ within: '1h' });
    const [query] = search.mock.calls[0];
    expect(Date.now() - new Date(query.from).getTime()).toBe(60 * 60_000);
    expect(query.to).toBeUndefined();
    expect(navigate.mock.calls[0][1]!.queryParams).toMatchObject({ within: '1h', from: null });
  });

  it('reloads from page 1 when a filter changes', async () => {
    await setup({ page: '2' });
    component.filters.controls.actorId.setValue(' alice ');
    await settle();
    expect(search).toHaveBeenLastCalledWith({ page: 1, pageSize: 25, actorId: 'alice' });
    expect(navigate.mock.calls.at(-1)![1]!.queryParams).toMatchObject({
      actorId: 'alice',
      page: null,
    });
  });

  it('drops chosen actions that do not belong to a newly chosen object', async () => {
    await setup({ actionType: ['tenant_updated', 'oidc_client_created'] });
    component.filters.controls.objectType.setValue('tenant');
    await settle();
    expect(component.filters.controls.actionType.value).toEqual(['tenant_updated']);
    expect(component.actionGroups().map((group) => group.objectType)).toEqual(['tenant']);
  });

  it('does not ask for a reversed time range and says what to fix', async () => {
    await setup();
    search.mockClear();
    component.filters.setValue({
      ...component.filters.getRawValue(),
      time: 'custom',
      from: '2026-11-18T15:00',
      to: '2026-11-18T14:00',
    });
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(text()).toContain('Must not be before From');
    expect(text()).not.toContain('Tenant Updated');
  });

  it('does not send an id longer than the backend accepts and says why', async () => {
    await setup();
    search.mockClear();
    component.filters.controls.requestId.setValue('x'.repeat(256));
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(text()).toContain('At most 255 characters');
  });

  it('shows the last page when a bookmarked page lies past the end', async () => {
    await setup({ page: '4' });
    search.mockImplementation(async ({ page }: { page: number }) =>
      page === 4
        ? { items: [], total: 30, page: 4, pageSize: 25, totalPages: 2 }
        : { items: [entry()], total: 30, page, pageSize: 25, totalPages: 2 }
    );
    component.refresh();
    await settle();
    expect(search).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
    expect(component.pageIndex).toBe(1);
    expect(text()).toContain('Tenant Updated');
  });

  it('shows the id the actor filter matches when the label shows the client', async () => {
    await setup();
    search.mockResolvedValue({
      items: [entry({ actorType: 'user', actorId: 'user-sub-1', actorDisplay: 'web-client' })],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    component.refresh();
    await settle();
    expect(text()).toContain('web-client (User)');
    expect(text()).toContain('ID user-sub-1');
  });

  it('names the entry on each copy button', async () => {
    await setup();
    const button = (fixture.nativeElement as HTMLElement).querySelector('td button');
    expect(button?.getAttribute('aria-label')).toMatch(/^Copy log entry Tenant Updated of /);
  });

  it('moves focus to the heading when Clear Filters removes itself', async () => {
    await setup({ actorType: 'system' });
    const clear = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Clear Filters'))!;
    clear.focus();
    clear.click();
    await settle();
    expect(document.activeElement?.textContent).toContain('Activity Logs');
  });

  it('tells an empty filter result from an empty log', async () => {
    await setup();
    search.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    component.filters.controls.actorType.setValue('system');
    await settle();
    expect(text()).toContain('No activity logs match these filters');
    component.clearFilters();
    await settle();
    expect(text()).toContain('No activity logs found for your tenant');
  });

  it('shows a load error with Retry instead of an empty list', async () => {
    await setup();
    search.mockRejectedValueOnce({ message: 'Database unavailable' });
    component.refresh();
    await settle();
    expect(text()).toContain('Database unavailable');
    expect(text()).not.toContain('No activity logs');

    const retry = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'app-load-error button'
    )!;
    retry.focus();
    retry.click();
    await settle();
    expect(text()).toContain('Tenant Updated');
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it.each([
    [{ retentionDays: 0, maxEntriesPerTenant: 0 }, 'Entries are kept until the operator sets'],
    [{ retentionDays: 365, maxEntriesPerTenant: 0 }, 'delete entries older than 365 days every'],
    [
      { retentionDays: 30, maxEntriesPerTenant: 1000 },
      'entries older than 30 days and all but the newest 1,000 entries',
    ],
  ])('explains the retention %j', async (limits, sentence) => {
    await setup();
    component.retention = limits;
    fixture.detectChanges();
    expect(text()).toContain(sentence);
  });
});

describe('activity log labels', () => {
  it('maps every action to a listed object', () => {
    for (const action of ACTION_TYPES) {
      expect(OBJECT_TYPES).toContain(objectTypeOf(action));
    }
    expect(objectTypeOf('oidc_client_secret_added')).toBe('oidc_client_secret');
    expect(objectTypeOf('oidc_client_created')).toBe('oidc_client');
    expect(objectTypeOf('config_bundle_imported')).toBe('config_bundle');
  });

  it('describes a retention run', () => {
    expect(detailsOf(entry({ actionType: 'audit_log_pruned', after: { deletedEntries: 3 } }))).toBe(
      '3 entries deleted by the retention settings'
    );
    expect(detailsOf(entry({ changedFields: [] }))).toBe('—');
  });
});
