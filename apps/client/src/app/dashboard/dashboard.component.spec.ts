import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import { ApiService } from '../core';
import { GrafanaLinkService } from '../services/grafana-link.service';
import { JwtService } from '../services/jwt.service';
import { DashboardComponent } from './dashboard.component';
import { DashboardService } from './dashboard.service';
import {
  DEFAULT_DASHBOARD_SECTIONS,
  DashboardPreferencesService,
} from './dashboard-preferences.service';

const statusCounts = (counts: Record<string, number> = {}) => ({
  active: 0,
  fetched: 0,
  completed: 0,
  expired: 0,
  failed: 0,
  cancelled: 0,
  ...counts,
});

describe('DashboardComponent', () => {
  let roles: string[];
  /** Emits like JwtService when a caller with other roles was loaded. */
  let callerChanged: Subject<void>;
  /** Whether JwtService has the caller's roles. */
  let callerLoaded: boolean;
  let loadCaller: ReturnType<typeof vi.fn>;
  let responses: Record<string, unknown>;
  let requests: string[];
  let fixture: ComponentFixture<DashboardComponent>;
  let grafanaEnabled: boolean;
  let preferences: {
    load: () => object;
    save: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };

  /** Waits until the dashboard data has loaded, then renders it. */
  async function settle(): Promise<void> {
    const service = TestBed.inject(DashboardService);
    await vi.waitFor(() => {
      if (service.isLoading) throw new Error('still loading');
    });
    fixture.detectChanges();
  }

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  beforeEach(() => {
    // Day boundaries and links must not move while a test runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 11, 15, 30));
    roles = [];
    callerChanged = new Subject();
    callerLoaded = true;
    loadCaller = vi.fn(async () => undefined);
    grafanaEnabled = false;
    preferences = {
      load: () => ({ ...DEFAULT_DASHBOARD_SECTIONS }),
      save: vi.fn(),
      reset: vi.fn(),
    };
    responses = { '/api/key-chain/providers/health': [] };
    requests = [];
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname);
        // Stats of one bucket or of the whole window may get their own answer.
        const range = url.searchParams.has('createdTo')
          ? '?bucket'
          : url.searchParams.has('createdFrom')
            ? '?window'
            : '';
        let body =
          url.pathname + range in responses
            ? responses[url.pathname + range]
            : responses[url.pathname];
        // Stats always report the retention; tests that do not care keep two weeks.
        if (url.pathname === '/api/session/stats' && body && !('retention' in (body as object))) {
          body = {
            ...(body as object),
            retention: { ttlSeconds: 14 * 86_400, cleanupMode: 'full' },
          };
        }
        return new Response(JSON.stringify(body ?? { statusCode: 500 }), {
          status: body === undefined ? 500 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { getBaseUrl: () => 'http://localhost:3000' } },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
            callerChanged$: callerChanged,
            getCaller: () =>
              callerLoaded ? { subject: 'shop', tenantId: 'acme', roles } : undefined,
            loadCaller,
          },
        },
        {
          provide: GrafanaLinkService,
          useValue: { getConfig: () => Promise.resolve(), isEnabled: () => grafanaEnabled },
        },
        {
          provide: DashboardPreferencesService,
          useValue: preferences,
        },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.useRealTimers();
  });

  it('shows failed session counts as unavailable and retries on request', async () => {
    roles = ['issuance:offer'];
    responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };

    const page = await render();

    const card = Array.from(page.querySelectorAll('.stat-card-link')).find(
      (link) => text(link.querySelector('.stat-label')) === 'Pending sessions'
    );
    expect(text(card?.querySelector('.stat-value') ?? null)).toBe('–');
    expect(text(card?.querySelector('.stat-note') ?? null)).toBe('Could not be loaded');
    expect(text(page.querySelector('.warnings-card'))).toContain('Could not load session counts.');
    expect(page.querySelector('.health-card')).toBeNull();

    responses['/api/session/stats'] = {
      issuance: {
        total: 3,
        byStatus: statusCounts({ active: 3 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
    };
    const retry = Array.from(page.querySelectorAll('.warnings-card button')).find(
      (button) => text(button) === 'refresh Retry'
    ) as HTMLButtonElement;
    retry.click();
    await settle();

    expect(text(card?.querySelector('.stat-value') ?? null)).toBe('3');
    expect(page.querySelector('.warnings-card')).toBeNull();
  });

  it('links recent sessions to their page and says what they are', async () => {
    roles = ['presentation:request'];
    responses['/api/verifier/config'] = [{ id: 'age-check' }];
    responses['/api/session/stats'] = {
      presentation: {
        total: 1,
        byStatus: statusCounts({ failed: 1 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
    };
    responses['/api/session'] = {
      items: [
        {
          id: '9c100000-0000-4000-8000-000000000004',
          status: 'failed',
          updatedAt: '2026-10-10T09:00:00.000Z',
          requestId: 'age-check',
          reference: 'case-42',
          failureCode: 'trust_chain_not_trusted',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 5,
      totalPages: 1,
    };

    const page = await render();

    const row = page.querySelector('.activity-row') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe(
      '/session-management/9c100000-0000-4000-8000-000000000004'
    );
    expect(text(row.querySelector('strong'))).toBe('Presentation failed');
    expect(text(row.querySelector('small'))).toBe(
      'age-check · case-42 · trust_chain_not_trusted · 9c100000'
    );
  });

  it('links a warning to the page that fixes it', async () => {
    roles = ['presentation:manage'];
    responses['/api/key-chain'] = [
      {
        id: 'access',
        usageType: 'access',
        activeCertificate: { pem: 'pem', notAfter: '2999-01-01T00:00:00.000Z' },
      },
    ];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    responses['/api/trust-list'] = [];

    const page = await render();

    const action = page.querySelector('.warnings-card a') as HTMLAnchorElement;
    expect(text(action)).toBe('Add Trust List');
    expect(action.getAttribute('href')).toBe('/trust-list/create');
  });

  it('hides the health card when no signal applies to the role', async () => {
    roles = ['clients:manage'];

    const page = await render();

    expect(page.querySelector('.health-card')).toBeNull();
    expect(page.querySelector('.warnings-card')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('says which health signals could not be loaded instead of guessing', async () => {
    roles = ['presentation:manage', 'registrar:manage'];
    responses['/api/key-chain'] = [];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    delete responses['/api/key-chain/providers/health'];

    const page = await render();

    const health = text(page.querySelector('.health-card'));
    expect(health).toContain('Registrar: Could not be loaded');
    expect(health).toContain('KMS: Could not be loaded');
    expect(health).toContain('Access Certificate: Missing');
    expect(text(page.querySelector('.warnings-card'))).toContain('Could not load trust lists.');
  });

  it('counts unreachable KMS providers in the health card', async () => {
    roles = ['presentation:manage'];
    responses['/api/key-chain'] = [];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    responses['/api/trust-list'] = [{ id: 'list' }];
    responses['/api/key-chain/providers/health'] = [
      { providerId: 'db', type: 'db', ok: true },
      { providerId: 'vault', type: 'vault', ok: false },
    ];

    const page = await render();

    expect(text(page.querySelector('.health-card'))).toContain('KMS: 1 of 2 unreachable');
  });

  it('shows configuration counts to managers who cannot read sessions', async () => {
    roles = ['issuance:manage'];
    responses['/api/key-chain'] = [];
    responses['/api/issuer/credentials'] = [{ id: 'pid' }, { id: 'mdl' }];
    responses['/api/issuer/config'] = { id: 'config' };

    const page = await render();

    expect(
      Array.from(page.querySelectorAll('.stat-card-link'), (link) => [
        text(link.querySelector('.stat-label')),
        text(link.querySelector('.stat-value')),
      ])
    ).toEqual([
      ['Credential Configs', '2'],
      ['Key Chains', '0'],
    ]);
  });

  it('loads its figures and sections again once the roles are loaded, for example by a Retry', async () => {
    responses['/api/key-chain'] = [];
    responses['/api/issuer/credentials'] = [{ id: 'pid' }, { id: 'mdl' }];
    responses['/api/issuer/config'] = { id: 'config' };
    const saved = { ...DEFAULT_DASHBOARD_SECTIONS, quickActions: false };
    const load = vi
      .fn()
      .mockReturnValueOnce({ ...DEFAULT_DASHBOARD_SECTIONS })
      .mockReturnValueOnce(saved);
    preferences.load = load;
    callerLoaded = false;
    const page = await render();
    expect(page.querySelectorAll('.stat-card-link')).toHaveLength(0);
    expect(text(page.querySelector('.subtitle'))).toBe('Your roles could not be loaded');
    expect(page.querySelector('.updated-at')).toBeNull();
    expect(text(page.querySelector('.roles-missing-card'))).toContain('Could not load your roles');

    Array.from(page.querySelectorAll<HTMLButtonElement>('.roles-missing-card button'))
      .find((button) => text(button) === 'refresh Retry')
      ?.click();
    expect(loadCaller).toHaveBeenCalledWith({ reload: true });

    roles = ['issuance:manage'];
    callerLoaded = true;
    callerChanged.next();
    fixture.detectChanges();
    await settle();

    expect(load).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.sections).toEqual(saved);
    expect(
      Array.from(page.querySelectorAll('.stat-card-link'), (link) =>
        text(link.querySelector('.stat-value'))
      )
    ).toEqual(['2', '0']);
    expect(page.querySelector('.roles-missing-card')).toBeNull();
  });

  it('shows a failed recent activity request with a way to the session list', async () => {
    roles = ['issuance:offer'];
    responses['/api/session/stats'] = {
      issuance: {
        total: 2,
        byStatus: statusCounts({ active: 2 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
    };

    const page = await render();

    const card = page.querySelector('.recent-activity-card');
    expect(text(card)).toContain('Recent activity could not be loaded');
    expect(card?.querySelector('a[href="/session-management"]')).not.toBeNull();
  });

  it('shows spinners and disables refreshing while loading', async () => {
    roles = ['issuance:offer'];
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });

    fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    expect(page.querySelector('.stat-card mat-spinner')).not.toBeNull();
    expect(page.querySelector('mat-progress-bar')).not.toBeNull();
    const refresh = page.querySelector(
      'button[aria-label="Refresh dashboard"]'
    ) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(page.querySelector('.warnings-card')).toBeNull();
  });

  it('offers Grafana in the header when it is configured', async () => {
    roles = ['clients:manage'];
    grafanaEnabled = true;

    const page = await render();

    expect(page.querySelector('.header-actions button[aria-label="Open Grafana"]')).not.toBeNull();
  });

  it('shows no setup guide or blocked hint before the first load finished', async () => {
    roles = ['issuance:manage', 'issuance:offer'];
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });

    fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    expect(text(page)).not.toContain('Getting Started');
    expect(page.querySelector('.actions-hint')).toBeNull();
  });

  it('tells monitoring users what their roles allow', async () => {
    roles = ['issuance:offer'];
    responses['/api/session/stats'] = {
      issuance: {
        total: 1,
        byStatus: statusCounts({ active: 1 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
    };
    responses['/api/session'] = { items: [], total: 1, page: 1, pageSize: 5, totalPages: 1 };

    const page = await render();

    expect(text(page.querySelector('.subtitle'))).toBe(
      'Monitoring access: your roles cannot change the issuance or presentation setup'
    );
  });

  it('opens the existing access key chain from the setup guide', async () => {
    roles = ['issuance:manage'];
    responses['/api/key-chain'] = [{ id: 'kc', usageType: 'access' }];
    responses['/api/issuer/credentials'] = [];
    responses['/api/issuer/config'] = { id: 'config' };

    const page = await render();

    const configure = Array.from(page.querySelectorAll('.setup-card a')).find(
      (link) => text(link) === 'verified Configure'
    );
    expect(configure?.getAttribute('href')).toBe('/keys/kc');
  });

  it('tells issuance:offer users why they cannot issue from here', async () => {
    roles = ['issuance:offer'];
    responses['/api/session/stats'] = {
      issuance: { total: 0, byStatus: statusCounts(), failureCodes: [], lastCompletedAt: null },
    };
    responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };

    const page = await render();

    expect(text(page.querySelector('.actions-hint'))).toBe(
      'info Issuance is blocked: The issuance form needs the issuance:manage role.'
    );
  });

  describe('for users who read sessions', () => {
    const stats = {
      presentation: {
        total: 4,
        byStatus: statusCounts({ active: 1, completed: 2, failed: 1 }),
        failureCodes: [{ code: 'trust_chain_not_trusted', count: 1 }],
        lastCompletedAt: null,
      },
    };

    beforeEach(() => {
      roles = ['issuance:offer', 'presentation:request', 'issuance:manage'];
      responses['/api/verifier/config'] = [{ id: 'pid' }];
      responses['/api/key-chain'] = [];
      responses['/api/issuer/credentials'] = [];
      responses['/api/issuer/config'] = { id: 'config' };
      responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };
      responses['/api/session/stats'] = stats;
    });

    it('leads with key figures over the window that open the matching sessions', async () => {
      // All time, the window and each bucket differ, so every tile shows which one it reads.
      responses['/api/session/stats'] = {
        presentation: {
          total: 20,
          byStatus: statusCounts({ active: 1, completed: 10, failed: 9 }),
          failureCodes: [],
          lastCompletedAt: null,
        },
      };
      responses['/api/session/stats?window'] = stats;
      responses['/api/session/stats?bucket'] = {
        presentation: {
          total: 1,
          byStatus: statusCounts({ failed: 1 }),
          failureCodes: [],
          lastCompletedAt: null,
        },
      };

      const page = await render();

      const tiles = Array.from(page.querySelectorAll('.stat-card-link'), (link) => ({
        label: text(link.querySelector('.stat-label')),
        value: text(link.querySelector('.stat-value')),
        note: text(link.querySelector('.stat-note')),
        href: decodeURIComponent(link.getAttribute('href') ?? ''),
      }));
      expect(tiles.map(({ label, value, note }) => [label, value, note])).toEqual([
        ['Sessions · 7 days', '4', '1 today'],
        ['Success rate · 7 days', '67%', 'of 3 finished'],
        ['Failed · 7 days', '1', '1 today'],
        ['Pending sessions', '1', 'waiting for a wallet'],
      ]);
      expect(tiles.map(({ href }) => href)).toEqual([
        '/session-management?createdFrom=2026-10-05',
        '/session-management?createdFrom=2026-10-05&status=completed&status=failed&status=expired',
        '/session-management?createdFrom=2026-10-05&status=failed',
        '/session-management?status=active&status=fetched',
      ]);
    });

    it('shows the week by day and links each failure reason to its sessions', async () => {
      const page = await render();

      const card = page.querySelector('.activity-card');
      expect(card?.querySelectorAll('app-activity-chart .column')).toHaveLength(7);
      expect(card?.querySelector('.retention-note')).toBeNull();
      const reason = card?.querySelector('.failure-codes a');
      expect(reason?.getAttribute('aria-label')).toBe('trust_chain_not_trusted: 1 failed session');
      expect(decodeURIComponent(reason?.getAttribute('href') ?? '')).toBe(
        '/session-management?status=failed&createdFrom=2026-10-05&failureCode=trust_chain_not_trusted'
      );
    });

    it('shows the last 24 hours by hour when sessions are deleted after a day', async () => {
      responses['/api/session/stats'] = {
        ...stats,
        retention: { ttlSeconds: 86_400, cleanupMode: 'full' },
      };
      responses['/api/session/stats?bucket'] = {
        presentation: {
          total: 2,
          byStatus: statusCounts({ completed: 2 }),
          failureCodes: [],
          lastCompletedAt: null,
        },
      };

      const page = await render();

      expect(text(page.querySelector('.activity-card .retention-note'))).toBe(
        'info Only the last 24 hours: sessions are deleted 1 day after creation.'
      );
      expect(page.querySelectorAll('.activity-card app-activity-chart .column')).toHaveLength(24);
      expect(text(page.querySelector('.stat-card-link .stat-label'))).toBe('Sessions · 24 hours');
      expect(text(page.querySelector('.stat-card-link .stat-note'))).toBe('2 this hour');
    });

    it.each([
      [7_200, 'Only the last 2 hours: sessions are deleted 2 hours after creation.'],
      [5_400, 'Only the last hour: sessions are deleted 90 minutes after creation.'],
      [90, 'Only the last hour: sessions are deleted 90 seconds after creation.'],
      [3 * 86_400, 'Only the last 3 days: sessions are deleted 3 days after creation.'],
    ])('explains a window shortened by a retention of %i seconds', async (ttlSeconds, note) => {
      responses['/api/session/stats'] = {
        ...stats,
        retention: { ttlSeconds, cleanupMode: 'full' },
      };

      const page = await render();

      expect(text(page.querySelector('.activity-card .retention-note'))).toBe(`info ${note}`);
    });

    it('says when no session failed in the window', async () => {
      responses['/api/session/stats?window'] = {
        presentation: {
          total: 2,
          byStatus: statusCounts({ completed: 2 }),
          failureCodes: [],
          lastCompletedAt: null,
        },
      };

      const page = await render();

      expect(text(page.querySelector('.failure-codes .no-failures'))).toBe(
        'check_circle No failed sessions in the last 7 days'
      );
    });

    it('shows when the failure reasons of the window could not be loaded', async () => {
      responses['/api/session/stats?window'] = undefined;

      const page = await render();

      expect(text(page.querySelector('.failure-codes .card-state'))).toBe(
        'error_outline Could not be loaded'
      );
      expect(page.querySelectorAll('.activity-card app-activity-chart .column')).toHaveLength(7);
    });

    it('links each status of the overview to its sessions', async () => {
      const page = await render();

      const failed = Array.from(page.querySelectorAll('.session-overview-card a.status-link')).find(
        (link) => text(link)?.includes('Failed')
      );
      expect(text(failed?.querySelector('span') ?? null)).toBe('1 Failed');
      expect(failed?.getAttribute('href')).toBe('/session-management?status=failed');
    });

    it('says when failed sessions carry no failure code instead of all clear', async () => {
      responses['/api/session/stats'] = {
        issuance: {
          total: 2,
          byStatus: statusCounts({ failed: 2 }),
          failureCodes: [],
          lastCompletedAt: null,
        },
      };

      const page = await render();

      const reasons = page.querySelector('.failure-codes');
      expect(text(reasons?.querySelector('.no-failures') ?? null)).toBe(
        'info 2 failed sessions have no failure code. Show them'
      );
      expect(decodeURIComponent(reasons?.querySelector('a')?.getAttribute('href') ?? '')).toBe(
        '/session-management?status=failed&createdFrom=2026-10-05'
      );
    });

    it('shows when the activity could not be loaded but keeps the window', async () => {
      const fetchImpl = client.getConfig().fetch!;
      client.setConfig({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return url.searchParams.has('createdTo')
            ? new Response(JSON.stringify({ statusCode: 503 }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              })
            : fetchImpl(input, init);
        },
      });

      const page = await render();

      expect(text(page.querySelector('.activity-chart-slot'))).toBe(
        'error_outline Could not be loaded'
      );
      expect(text(page.querySelector('.activity-card mat-card-subtitle'))).toBe(
        'Sessions created in the last 7 days, by outcome'
      );
      const failed = Array.from(page.querySelectorAll('.stat-card-link')).find((link) =>
        text(link.querySelector('.stat-label'))?.startsWith('Failed')
      );
      expect(decodeURIComponent(failed?.getAttribute('href') ?? '')).toBe(
        '/session-management?createdFrom=2026-10-05&status=failed'
      );
    });

    it('hides a section on request and shows all sections again', async () => {
      const page = await render();
      fixture.componentInstance.customizePanelOpen = true;
      fixture.detectChanges();

      const panel = page.querySelector('.customization-card');
      expect(Array.from(panel?.querySelectorAll('mat-checkbox') ?? [], (box) => text(box))).toEqual(
        ['Sessions by outcome', 'Recent activity', 'Session overview', 'Quick actions']
      );
      expect(panel?.querySelector('.focus-option')).toBeNull();

      (panel?.querySelector('mat-checkbox input') as HTMLInputElement).click();
      fixture.detectChanges();
      expect(page.querySelector('.activity-card')).toBeNull();
      expect(preferences.save).toHaveBeenCalledWith({
        ...DEFAULT_DASHBOARD_SECTIONS,
        activity: false,
      });

      const showAll = Array.from(panel?.querySelectorAll('button') ?? []).find((button) =>
        text(button)?.includes('Show all sections')
      ) as HTMLButtonElement;
      showAll.click();
      fixture.detectChanges();
      expect(preferences.reset).toHaveBeenCalledOnce();
      expect(page.querySelector('.activity-card')).not.toBeNull();
    });
  });
});
