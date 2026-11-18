import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { AuditLogResponseDto } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTION_TYPES, objectTypeOf } from './activity-log-labels';
import { ActivityLogService } from './activity-log.service';
import { AdminActivityLogsComponent, describeAction } from './admin-activity-logs.component';

describe('describeAction', () => {
  it('names any action by its object and verb, with the colour of the verb', () => {
    expect(describeAction('credential_config_created')).toEqual(
      expect.objectContaining({
        object: 'credential_config',
        verb: 'created',
        label: 'Credential Config Created',
        tone: 'tone-success',
      })
    );
    expect(describeAction('oidc_client_secret_added').label).toBe(
      'OpenID Connect Client Secret Added'
    );
    expect(describeAction('oidc_client_secret_added').object).toBe('oidc_client_secret');
    // Config Portability actions, which a fixed list of labels left out
    expect(describeAction('config_bundle_exported')).toEqual(
      expect.objectContaining({ object: 'config_bundle', label: 'Config Bundle Exported' })
    );
    expect(describeAction('config_resource_reattached').label).toBe('Config Resource Reattached');
    expect(describeAction('session_cancelled').tone).toBe('tone-danger');
    expect(describeAction('audit_log_pruned')).toEqual(
      expect.objectContaining({ object: 'audit_log', label: 'Audit Log Pruned' })
    );
  });

  it('keeps an action without a known verb readable', () => {
    expect(describeAction('tenant_archived')).toEqual(
      expect.objectContaining({ object: 'tenant_archived', verb: '', label: 'Tenant Archived' })
    );
    expect(describeAction(undefined).label).toBe('Unknown');
  });

  it('agrees with the filter catalog on the object of every recorded action', () => {
    for (const action of ACTION_TYPES) {
      expect(describeAction(action).object, action).toBe(objectTypeOf(action));
    }
  });
});

describe('AdminActivityLogsComponent', () => {
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);

  const logs: AuditLogResponseDto[] = [
    {
      id: 'a',
      tenantId: 'acme',
      actionType: 'credential_config_updated',
      actorType: 'client',
      actorId: 'acme-admin',
      changedFields: ['description'],
      before: { description: 'Old' },
      after: { description: 'New' },
      timestamp: now.toISOString(),
    },
    {
      id: 'b',
      tenantId: 'acme',
      actionType: 'config_bundle_exported',
      actorType: 'user',
      actorId: 'user-sub-1',
      actorDisplay: 'web-console',
      after: { documents: 3 },
      timestamp: hoursAgo(0.01),
    },
    {
      id: 'c',
      tenantId: 'acme',
      actionType: 'tenant_created',
      actorType: 'system',
      timestamp: yesterday.toISOString(),
    },
  ];
  const pageOf = (items: AuditLogResponseDto[], total = items.length, page = 1) => ({
    items,
    total,
    page,
    pageSize: 25,
    totalPages: Math.ceil(total / 25),
  });

  let fixture: ComponentFixture<AdminActivityLogsComponent>;
  let component: AdminActivityLogsComponent;
  let page: HTMLElement;
  let search: ReturnType<typeof vi.fn> | undefined;
  let navigate: ReturnType<typeof vi.spyOn>;

  async function render(queryParams: Record<string, string | string[]> = {}) {
    vi.useFakeTimers();
    search ??= vi.fn().mockResolvedValue(pageOf(logs));
    const retention = vi.fn().mockResolvedValue({ retentionDays: 0, maxEntriesPerTenant: 0 });
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
    page = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    await settle();
  }

  /** Let the debounced filter change and the request through. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(300);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const text = (element: Element | null = page) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const actions = () => Array.from(page.querySelectorAll('.entry-action'), (e) => text(e));
  const searchMock = () => search!;

  afterEach(() => {
    vi.useRealTimers();
    search = undefined;
  });

  describe('the feed', () => {
    it('groups the page by day, names every action and counts all matches', async () => {
      search = vi.fn().mockResolvedValue(pageOf(logs, 30));
      await render();

      expect(Array.from(page.querySelectorAll('.day-label'), (e) => text(e))).toEqual([
        'Today',
        'Yesterday',
      ]);
      expect(actions()).toEqual([
        'Credential Config Updated',
        'Config Bundle Exported',
        'Tenant Created',
      ]);
      expect(text(page.querySelector('.feed-title output'))).toBe('30 entries');
    });

    it('opens an entry to show each changed field before and after', async () => {
      await render();
      const row = page.querySelector('.entry-row') as HTMLButtonElement;
      expect(row.getAttribute('aria-expanded')).toBe('false');

      row.click();
      fixture.detectChanges();

      expect(row.getAttribute('aria-expanded')).toBe('true');
      const cells = Array.from(page.querySelectorAll('.changes tbody tr'), (tr) =>
        Array.from(tr.querySelectorAll('th, td'), (e) => text(e))
      );
      expect(cells).toEqual([['description', 'Old', 'New']]);
    });

    it('shows only the values of a new object, which has none before', async () => {
      await render();
      (page.querySelectorAll('.entry-row')[1] as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(Array.from(page.querySelectorAll('.changes thead th'), (e) => text(e))).toEqual([
        'Field',
        'Value',
      ]);
      expect(component.fieldChanges(logs[1])).toEqual([
        { field: 'documents', before: undefined, after: '3' },
      ]);
    });

    it('shows the id the actor filter matches when the label shows the client', async () => {
      await render();
      const meta = Array.from(page.querySelectorAll('.entry-meta'), (e) => text(e));
      expect(meta[1]).toContain('web-console');
      expect(meta[1]).toContain('User ID user-sub-1');
      // The label already is the id: no second line.
      expect(meta[0]).not.toContain('ID acme-admin');
    });

    it('says when there is no activity yet', async () => {
      search = vi.fn().mockResolvedValue(pageOf([]));
      await render();
      expect(text(page.querySelector('.empty-state'))).toContain('No activity yet');
    });
  });

  describe('server-side filters', () => {
    it('loads the first page without filters and keeps the URL clean', async () => {
      await render();
      expect(searchMock()).toHaveBeenCalledExactlyOnceWith({ page: 1, pageSize: 25 });
      const params = navigate.mock.calls[0][1]!.queryParams!;
      expect(Object.values(params).every((value) => value === null)).toBe(true);
    });

    it('searches on the server, from page 1', async () => {
      await render({ page: '2' });
      searchMock().mockResolvedValue(pageOf([logs[1]]));
      const input = page.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = ' web-console ';
      input.dispatchEvent(new Event('input'));
      await settle();

      expect(searchMock()).toHaveBeenLastCalledWith({ page: 1, pageSize: 25, q: 'web-console' });
      expect(actions()).toEqual(['Config Bundle Exported']);
      expect(text(page.querySelector('.feed-title output'))).toBe('1 entry match');
      expect(navigate.mock.calls.at(-1)![1]!.queryParams).toMatchObject({
        q: 'web-console',
        page: null,
      });
    });

    it('offers every object as a chip and filters by it on the server', async () => {
      await render();
      const chips = Array.from(page.querySelectorAll('mat-chip-option'), (e) => text(e));
      expect(chips).toContain('Config Bundle');
      expect(chips).toContain('Audit Log');

      component.filters.controls.objectType.setValue('config_bundle');
      await settle();
      expect(searchMock()).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 25,
        objectType: 'config_bundle',
      });
    });

    it('restores the filters from the URL and ignores unknown values', async () => {
      await render({
        q: 'secret',
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
      expect(searchMock()).toHaveBeenCalledWith({
        page: 3,
        pageSize: 50,
        q: 'secret',
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
      await render({ within: '1h' });
      const [query] = searchMock().mock.calls[0];
      expect(Date.now() - new Date(query.from).getTime()).toBeLessThanOrEqual(61 * 60_000);
      expect(Date.now() - new Date(query.from).getTime()).toBeGreaterThan(59 * 60_000);
      expect(query.to).toBeUndefined();
      expect(navigate.mock.calls[0][1]!.queryParams).toMatchObject({ within: '1h', from: null });
    });

    it('drops chosen actions that do not belong to a newly chosen object', async () => {
      await render({ actionType: ['tenant_updated', 'oidc_client_created'] });
      component.filters.controls.objectType.setValue('tenant');
      await settle();
      expect(component.filters.controls.actionType.value).toEqual(['tenant_updated']);
      expect(component.actionGroups().map((group) => group.objectType)).toEqual(['tenant']);
    });

    it('shows the last page when a bookmarked page lies past the end', async () => {
      search = vi.fn(async ({ page: requested }: { page: number }) =>
        requested === 4 ? { ...pageOf([], 30, 4), totalPages: 2 } : pageOf(logs, 30, requested)
      );
      await render({ page: '4' });
      expect(searchMock()).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
      expect(component.pageIndex).toBe(1);
      expect(actions()).toHaveLength(3);
    });

    it('tells an empty filter result from an empty log', async () => {
      await render();
      searchMock().mockResolvedValue(pageOf([]));
      component.filters.controls.actorType.setValue('system');
      await settle();
      expect(text(page.querySelector('.no-match'))).toContain('No activity matches the filters.');
      expect(page.querySelector('.empty-state')).toBeNull();

      component.clearFilters();
      await settle();
      expect(text(page.querySelector('.empty-state'))).toContain('No activity yet');
    });
  });

  describe('invalid filters', () => {
    it('does not ask for a reversed time range and says what to fix', async () => {
      await render();
      searchMock().mockClear();
      component.filters.setValue({
        ...component.filters.getRawValue(),
        time: 'custom',
        from: '2026-11-18T15:00',
        to: '2026-11-18T14:00',
      });
      await settle();
      expect(searchMock()).not.toHaveBeenCalled();
      expect(text()).toContain('Must not be before From');
      expect(actions()).toEqual([]);
    });

    it('re-checks the range when From changes after To', async () => {
      await render();
      component.filters.controls.time.setValue('custom');
      component.filters.controls.to.setValue('2026-11-18T14:00');
      await settle();
      searchMock().mockClear();

      component.filters.controls.from.setValue('2026-11-18T15:00');
      await settle();
      expect(searchMock()).not.toHaveBeenCalled();
      expect(text()).toContain('Must not be before From');

      component.filters.controls.from.setValue('2026-11-18T13:00');
      await settle();
      expect(searchMock()).toHaveBeenCalledTimes(1);
      expect(text()).not.toContain('Must not be before From');
    });

    it('measures text without surrounding spaces, as the backend does', async () => {
      await render();
      searchMock().mockClear();
      component.filters.controls.actorId.setValue(` ${'x'.repeat(255)} `);
      await settle();
      expect(searchMock()).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'x'.repeat(255) })
      );
    });

    it.each(['q', 'requestId'] as const)(
      'does not send a %s longer than the backend accepts and says why',
      async (field) => {
        await render();
        searchMock().mockClear();
        component.filters.controls[field].setValue('x'.repeat(256));
        await settle();
        expect(searchMock()).not.toHaveBeenCalled();
        expect(text()).toMatch(/at most 255 characters/i);
      }
    );
  });

  describe('focus and errors', () => {
    it('says why the log could not be loaded, and Retry loads it and focuses the heading', async () => {
      search = vi
        .fn()
        .mockRejectedValueOnce({ message: 'Forbidden resource' })
        .mockResolvedValue(pageOf(logs));
      await render();
      expect(text(page.querySelector('app-load-error'))).toContain('Forbidden resource');

      const retry = page.querySelector<HTMLButtonElement>('app-load-error button')!;
      retry.focus();
      retry.click();
      await settle();
      expect(actions()).toHaveLength(3);
      expect(document.activeElement?.tagName).toBe('H1');
    });

    it('moves focus to the heading when Clear filters removes itself', async () => {
      await render({ actorType: 'system' });
      const clear = Array.from(page.querySelectorAll<HTMLButtonElement>('.filter-row button')).find(
        (button) => text(button).includes('Clear filters')
      )!;
      clear.focus();
      clear.click();
      await settle();
      expect(document.activeElement?.tagName).toBe('H1');
    });
  });

  it.each([
    [{ retentionDays: 0, maxEntriesPerTenant: 0 }, 'Entries are kept until the operator sets'],
    [{ retentionDays: 365, maxEntriesPerTenant: 0 }, 'delete entries older than 365 days every'],
    [
      { retentionDays: 30, maxEntriesPerTenant: 1000 },
      'entries older than 30 days and all but the newest 1,000 entries',
    ],
  ])('explains the retention %j', async (limits, sentence) => {
    await render();
    component.retention = limits;
    fixture.detectChanges();
    expect(text()).toContain(sentence);
  });
});
