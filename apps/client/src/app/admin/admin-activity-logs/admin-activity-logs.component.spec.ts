import { ComponentFixture, TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  });

  it('keeps an action without a known verb readable', () => {
    expect(describeAction('tenant_archived')).toEqual(
      expect.objectContaining({ object: 'tenant_archived', verb: '', label: 'Tenant Archived' })
    );
    expect(describeAction(undefined).label).toBe('Unknown');
  });
});

describe('AdminActivityLogsComponent', () => {
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);

  const logs = [
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
      actorDisplay: 'Jo',
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

  let response: { status: number; body: unknown };
  let fixture: ComponentFixture<AdminActivityLogsComponent>;
  let component: AdminActivityLogsComponent;
  let page: HTMLElement;
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  beforeEach(() => {
    response = { status: 200, body: logs };
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  async function render(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AdminActivityLogsComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminActivityLogsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(component.activityLoading).toBe(false);
    });
    fixture.detectChanges();
  }

  const actions = () => Array.from(page.querySelectorAll('.entry-action'), text);

  it('groups the entries by day and names every action', async () => {
    await render();

    expect(Array.from(page.querySelectorAll('.day-label'), text)).toEqual(['Today', 'Yesterday']);
    expect(actions()).toEqual([
      'Credential Config Updated',
      'Config Bundle Exported',
      'Tenant Created',
    ]);
    expect(text(page.querySelector('.feed-title output'))).toBe('3 entries');
  });

  it('limits the entries to an object type, including Config Portability actions', async () => {
    await render();

    expect(component.objectTypes.map((type) => type.label)).toEqual([
      'Config Bundle',
      'Credential Config',
      'Tenant',
    ]);
    component.selectObjectType('config_bundle');
    fixture.detectChanges();

    expect(actions()).toEqual(['Config Bundle Exported']);
    expect(text(page.querySelector('.feed-title output'))).toBe('1 of 3 entries');
  });

  it('finds entries by actor and changed field, and says when none match', async () => {
    await render();

    component.search = 'jo';
    component.onFilterChange();
    fixture.detectChanges();
    expect(actions()).toEqual(['Config Bundle Exported']);

    component.search = 'description';
    component.onFilterChange();
    fixture.detectChanges();
    expect(actions()).toEqual(['Credential Config Updated']);

    component.search = 'nothing';
    component.onFilterChange();
    fixture.detectChanges();
    expect(text(page.querySelector('.no-match'))).toContain('No activity matches the filters.');
  });

  it('opens an entry to show each changed field before and after', async () => {
    await render();
    const row = page.querySelector('.entry-row') as HTMLButtonElement;
    expect(row.getAttribute('aria-expanded')).toBe('false');

    row.click();
    fixture.detectChanges();

    expect(row.getAttribute('aria-expanded')).toBe('true');
    const cells = Array.from(page.querySelectorAll('.changes tbody tr'), (tr) =>
      Array.from(tr.querySelectorAll('th, td'), text)
    );
    expect(cells).toEqual([['description', 'Old', 'New']]);
  });

  it('shows only the values of a new object, which has none before', async () => {
    await render();
    (page.querySelectorAll('.entry-row')[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(Array.from(page.querySelectorAll('.changes thead th'), text)).toEqual([
      'Field',
      'Value',
    ]);
    expect(
      Array.from(page.querySelectorAll('.changes tbody tr'), (tr) =>
        Array.from(tr.querySelectorAll('th, td'), text)
      )
    ).toEqual([['documents', '3']]);
  });

  it('shows the fields of an entry without changed fields from its recorded values', async () => {
    await render();

    expect(component.fieldChanges(logs[1] as never)).toEqual([
      { field: 'documents', before: undefined, after: '3' },
    ]);
  });

  it('says why the log could not be loaded and loads it again on Retry', async () => {
    response = { status: 403, body: { statusCode: 403, message: 'Forbidden resource' } };
    await render();

    expect(text(page.querySelector('app-load-error'))).toContain(
      'Failed to load activity logs: Forbidden resource'
    );

    response = { status: 200, body: logs };
    await component.loadActivityLogs();
    fixture.detectChanges();
    expect(actions()).toHaveLength(3);
  });

  it('says when there is no activity yet', async () => {
    response = { status: 200, body: [] };
    await render();

    expect(text(page.querySelector('.empty-state'))).toContain('No activity yet');
  });
});
