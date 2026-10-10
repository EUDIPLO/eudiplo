import { TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { JwtService } from '../services/jwt.service';
import { DashboardService } from './dashboard.service';

const statusCounts = (counts: Record<string, number> = {}) => ({
  active: 0,
  fetched: 0,
  completed: 0,
  expired: 0,
  failed: 0,
  cancelled: 0,
  ...counts,
});

const day = 24 * 60 * 60 * 1000;
const accessKeyChain = (expiresInDays: number) => ({
  id: 'access',
  usageType: 'access',
  activeCertificate: {
    pem: '-----BEGIN CERTIFICATE-----',
    notAfter: new Date(Date.now() + expiresInDays * day).toISOString(),
  },
});

describe('DashboardService', () => {
  let roles: string[];
  let responses: Record<string, unknown>;
  let requests: string[];
  let service: DashboardService;

  beforeEach(() => {
    roles = [];
    responses = {};
    requests = [];
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname + url.search);
        const body = responses[url.pathname];
        return new Response(JSON.stringify(body ?? {}), {
          status: body === undefined ? 404 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
          },
        },
      ],
    });
    service = TestBed.inject(DashboardService);
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('counts sessions of every status and page from the stats endpoint', async () => {
    roles = ['issuance:offer', 'presentation:request'];
    responses['/api/session/stats'] = {
      issuance: {
        total: 30,
        byStatus: statusCounts({ active: 20, cancelled: 10 }),
        lastCompletedAt: null,
      },
      presentation: {
        total: 5,
        byStatus: statusCounts({ completed: 5 }),
        lastCompletedAt: '2026-10-10T08:00:00.000Z',
      },
    };
    responses['/api/session'] = {
      items: [{ id: 'session-1', status: 'active', updatedAt: '2026-10-10T09:00:00.000Z' }],
      total: 35,
      page: 1,
      pageSize: 5,
      totalPages: 7,
    };

    await service.getCounters();

    expect(service.totalSessions).toBe(35);
    expect(service.sessionActive).toBe(20);
    expect(service.sessionCancelled).toBe(10);
    expect(service.sessionCompleted).toBe(5);
    expect(service.lastSuccessfulIssuanceAt).toBeNull();
    expect(service.lastSuccessfulPresentationAt).toBe('2026-10-10T08:00:00.000Z');
    expect(service.recentSessions.map((session) => session.id)).toEqual(['session-1']);
    expect(requests).toContain('/api/session?pageSize=5&sortBy=updatedAt&sortOrder=desc');
  });

  it('raises no access certificate warning for users who cannot read key chains', async () => {
    roles = ['issuance:offer'];
    responses['/api/session/stats'] = {
      issuance: { total: 1, byStatus: statusCounts({ active: 1 }), lastCompletedAt: null },
    };

    await service.getCounters();

    expect(requests).not.toContain('/api/key-chain');
    expect(service.warningMessages).toEqual([]);
    expect(service.hasHealthSignals).toBe(true);
    // The session list answered 404 in this test.
    expect(service.sessionStatsLoaded).toBe(true);
    expect(service.recentSessionsLoaded).toBe(false);
  });

  it('neither shows zero sessions nor warns when the session counts fail to load', async () => {
    roles = ['issuance:offer'];
    responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };

    await service.getCounters();

    expect(service.sessionStatsLoaded).toBe(false);
    expect(service.recentSessionsLoaded).toBe(true);
    expect(service.warningMessages).toEqual([]);
    expect(service.hasHealthSignals).toBe(false);
  });

  it('shows no health signals to users whose roles have none', async () => {
    roles = ['clients:manage'];

    await service.getCounters();

    expect(service.hasHealthSignals).toBe(false);
    expect(requests).toEqual([]);
  });

  it('warns key chain managers about a missing access certificate', async () => {
    roles = ['issuance:manage'];
    responses['/api/key-chain'] = [];

    await service.getCounters();

    expect(requests).toContain('/api/key-chain');
    expect(service.warningMessages).toContain(
      'No access certificate configured. Issuance and presentation flows cannot start.'
    );
    expect(service.verifyReadinessReason).toBe(
      'Read-only: missing presentation:manage or presentation:request role'
    );
  });

  it('names the missing key chain to presentation managers', async () => {
    roles = ['presentation:manage'];
    responses['/api/key-chain'] = [];
    responses['/api/verifier/config'] = [{ id: 'pid' }];

    await service.getCounters();

    expect(service.verifyReadinessReason).toBe('No key chain configured');
  });

  it.each([
    [-1, 'Access certificate is expired. Renew it before issuing or requesting presentations.'],
    [10, 'Access certificate expires within 30 days. Plan renewal to avoid interruptions.'],
  ])('warns about an access certificate expiring in %i days', async (days, warning) => {
    roles = ['issuance:manage'];
    responses['/api/key-chain'] = [accessKeyChain(days)];

    await service.getCounters();

    expect(service.warningMessages).toContain(warning);
  });

  it('lets presentation:request users start a presentation once a config exists', async () => {
    roles = ['presentation:request'];
    responses['/api/verifier/config'] = [{ id: 'pid' }];

    await service.getCounters();

    expect(service.presentationConfigs).toBe(1);
    expect(service.isReadyToVerify).toBe(true);
    expect(service.verifyReadinessReason).toBeNull();
    expect(requests).not.toContain('/api/trust-list');
  });

  it('names the missing presentation config to presentation:request users', async () => {
    roles = ['presentation:request'];
    responses['/api/verifier/config'] = [];

    await service.getCounters();

    expect(service.isReadyToVerify).toBe(false);
    expect(service.verifyReadinessReason).toBe(
      'No presentation config; ask a user with presentation:manage to create one'
    );
  });

  it('keeps the setup guide while the issuance a manager owns is not set up', async () => {
    roles = ['issuance:manage', 'presentation:request'];
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [{ id: 'pid' }];

    await service.getCounters();

    expect(service.isReadyToVerify).toBe(true);
    expect(service.isReadyToIssue).toBe(false);
    expect(service.isSetupComplete).toBe(false);
    expect(service.showSetupGuide).toBe(true);
  });
});
