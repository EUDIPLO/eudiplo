import { effectiveRoles } from '../services/role-grants';
import { TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { JwtService } from '../services/jwt.service';
import { activityWindow, DashboardService } from './dashboard.service';

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
/** The frozen clock of every test; test data built at load time must use it, not the real clock. */
const now = new Date(2026, 9, 11, 15, 30);
const accessKeyChain = (expiresInDays: number, id = 'access') => ({
  id,
  usageType: 'access',
  activeCertificate: {
    pem: '-----BEGIN CERTIFICATE-----',
    notAfter: new Date(now.getTime() + expiresInDays * day).toISOString(),
  },
});

/** Answers of a tenant whose issuance is fully set up. */
const issuanceSetUp = {
  '/api/key-chain': [accessKeyChain(365)],
  '/api/issuer/credentials': [{ id: 'pid' }],
  '/api/issuer/config': { id: 'config' },
};

/**
 * Answers of a tenant without sessions, for the manage roles, which include
 * issuance:offer or presentation:request and so read sessions.
 */
const noSessions = {
  '/api/session/stats': {},
  '/api/session': { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 },
};

/** Sessions kept long enough for a full week of activity. */
const twoWeeks = { ttlSeconds: 14 * 86_400, cleanupMode: 'full' };

describe('DashboardService', () => {
  let roles: string[];
  let responses: Record<string, unknown>;
  /** HTTP status per path for requests that fail; other unknown paths answer 404. */
  let failures: Record<string, number>;
  let requests: string[];
  let service: DashboardService;

  const messages = () => service.warnings.map((warning) => warning.message);

  beforeEach(() => {
    // Day and hour boundaries must not move while a test runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    roles = [];
    // Every key chain reader also loads the KMS health, and every issuance:read caller the
    // credential configs and issuer settings; answer them unless a test overrides them.
    responses = {
      '/api/key-chain/providers/health': [],
      '/api/issuer/credentials': [],
      '/api/issuer/config': { id: 'config' },
    };
    failures = {};
    requests = [];
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname + url.search);
        let body = responses[url.pathname];
        // Stats always report the retention; tests that do not care keep two weeks.
        if (url.pathname === '/api/session/stats' && body && !('retention' in (body as object))) {
          body = { ...(body as object), retention: twoWeeks };
        }
        const status = body === undefined ? (failures[url.pathname] ?? 404) : 200;
        return new Response(JSON.stringify(status === 200 ? body : { statusCode: status }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) =>
              [role].flat().some((r) => effectiveRoles(roles).includes(r)),
          },
        },
      ],
    });
    service = TestBed.inject(DashboardService);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.useRealTimers();
  });

  it('counts sessions of every status and page from the stats endpoint', async () => {
    roles = ['issuance:offer', 'presentation:request'];
    // issuance:read and presentation:read, which these roles include, read the key chains.
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [];
    responses['/api/session/stats'] = {
      issuance: {
        total: 30,
        byStatus: statusCounts({ active: 20, cancelled: 10 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
      presentation: {
        total: 5,
        byStatus: statusCounts({ completed: 5 }),
        failureCodes: [],
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
    expect(service.warnings).toEqual([]);
    expect(service.lastUpdatedAt).toBeInstanceOf(Date);
  });

  it('loads the key chains for issuance:offer, which includes issuance:read', async () => {
    roles = ['issuance:offer'];
    Object.assign(responses, noSessions, { '/api/key-chain': [accessKeyChain(365)] });

    await service.getCounters();

    expect(service.canReadKeyChains).toBe(true);
    // Creating key chains needs keys:manage.
    expect(service.canManageKeyChains).toBe(false);
    expect(requests).toContain('/api/key-chain');
    expect(requests).toContain('/api/key-chain/providers/health');
    expect(service.warnings).toEqual([]);
  });

  it('raises no access certificate warning for users who cannot read key chains', async () => {
    roles = ['sessions:read'];
    responses['/api/session/stats'] = {
      issuance: {
        total: 1,
        byStatus: statusCounts({ active: 1 }),
        failureCodes: [],
        lastCompletedAt: null,
      },
    };
    responses['/api/session'] = { items: [], total: 1, page: 1, pageSize: 5, totalPages: 1 };

    await service.getCounters();

    expect(requests).not.toContain('/api/key-chain');
    expect(requests).not.toContain('/api/key-chain/providers/health');
    expect(service.warnings).toEqual([]);
    expect(service.hasHealthSignals).toBe(true);
  });

  it('reports each failed request with a retry instead of showing it as empty', async () => {
    roles = ['sessions:read'];
    failures['/api/session/stats'] = 500;
    failures['/api/session'] = 503;

    await service.getCounters();

    expect(service.hasFailed('sessionStats')).toBe(true);
    expect(service.isLoaded('sessionStats')).toBe(false);
    expect(service.hasFailed('recentSessions')).toBe(true);
    // The activity builds on the session counts, so its failure is not reported twice.
    expect(service.hasFailed('activity')).toBe(true);
    expect(service.warnings).toEqual([
      { message: 'Could not load session counts.', retry: true },
      { message: 'Could not load recent sessions.', retry: true },
    ]);
    expect(service.hasHealthSignals).toBe(false);
  });

  it('gives one warning for all requests the backend did not answer', async () => {
    roles = ['sessions:read'];
    client.setConfig({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await service.getCounters();

    expect(service.warnings).toEqual([
      {
        message:
          'Could not load session counts and recent sessions: ' +
          'the backend could not be reached. Check the connection and try again.',
        retry: true,
      },
    ]);
  });

  it('puts the unreachable warning first, before the warnings of requests the backend answered', async () => {
    roles = ['sessions:read'];
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/api/session') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ statusCode: 403, message: 'Forbidden resource' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await service.getCounters();

    expect(service.warnings).toEqual([
      {
        message:
          'Could not load recent sessions: ' +
          'the backend could not be reached. Check the connection and try again.',
        retry: true,
      },
      { message: 'Could not load session counts: Forbidden resource', retry: false },
    ]);
  });

  it('keeps the warnings of requests the backend answered apart from the unreachable ones', async () => {
    roles = ['sessions:read'];
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/api/session/stats') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ statusCode: 500 }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await service.getCounters();

    expect(service.warnings).toEqual([
      {
        message:
          'Could not load session counts: ' +
          'the backend could not be reached. Check the connection and try again.',
        retry: true,
      },
      { message: 'Could not load recent sessions.', retry: true },
    ]);
  });

  it("gives the backend's reason and no retry when a retry cannot help", async () => {
    roles = ['sessions:read'];
    responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body =
          url.pathname === '/api/session/stats'
            ? { statusCode: 404, message: 'Cannot GET /api/session/stats' }
            : responses[url.pathname];
        return new Response(JSON.stringify(body), {
          status: url.pathname === '/api/session/stats' ? 404 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await service.getCounters();

    expect(service.warnings).toEqual([
      { message: 'Could not load session counts: Cannot GET /api/session/stats', retry: false },
    ]);
  });

  it('does not show a setup guide built from failed requests', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, noSessions);
    failures['/api/key-chain'] = 500;
    responses['/api/issuer/credentials'] = [];
    responses['/api/issuer/config'] = { id: 'config' };

    await service.getCounters();

    expect(service.showSetupGuide).toBe(false);
    expect(service.issueReadinessReason).toBe('Key chains could not be loaded');
    expect(messages()).toEqual(['Could not load key chains.']);
  });

  it('loads nothing for a caller with only registrar:manage', async () => {
    roles = ['registrar:manage'];

    await service.getCounters();

    expect(service.hasHealthSignals).toBe(false);
    expect(service.warnings).toEqual([]);
  });

  describe('registration certificates', () => {
    const part = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const seconds = (days: number) => Math.floor(now.getTime() / 1000) + days * 24 * 3600;
    /** An unsigned JWT expiring this many days after the fixed time of the tests. */
    const certificate = (days: number) =>
      `${part({ alg: 'ES256' })}.${part({ exp: seconds(days) })}.c2ln`;
    const notYetValid = `${part({ alg: 'ES256' })}.${part({ nbf: seconds(1), exp: seconds(60) })}.c2ln`;

    it('names each verification config whose certificate needs attention, with a link', async () => {
      roles = ['presentation:manage', 'registrar:manage'];
      responses['/api/trust-list'] = [{ id: 'list' }];
      responses['/api/verifier/config'] = [
        { id: 'fine', registration_cert: { jwt: certificate(60) } },
        { id: 'soon', description: 'Age check', registration_cert: { jwt: certificate(3) } },
        { id: 'old', registration_cert: { jwt: certificate(-1) } },
        { id: 'purpose', registration_cert: { purpose: [{ lang: 'en', content: 'Age' }] } },
        { id: 'broken', registration_cert: { jwt: 'not-a-jwt' } },
        { id: 'early', registration_cert: { jwt: notYetValid } },
        { id: 'none' },
      ];

      await service.getCounters();

      const warnings = service.warnings.filter((warning) =>
        warning.message.startsWith('Registration certificate')
      );
      // A purpose kept without JWT is no warning: requests still work.
      expect(warnings.map((warning) => warning.message)).toEqual([
        'Registration certificate of verification config "Age check" (soon): Expiring soon — 3 days remaining; request a new one.',
        'Registration certificate of verification config old: Expired — request a new one or remove it.',
        'Registration certificate of verification config broken: Not a valid JWT — request a new one or paste a valid JWT.',
        'Registration certificate of verification config early: Not yet valid — requests fail until its start time; check the date or request a new one.',
      ]);
      expect(warnings[0].action).toEqual({
        label: 'Open Security Tab',
        route: ['/presentation-config', 'soon'],
        fragment: 'security',
        ariaLabel: 'Open the Security tab of verification config "Age check" (soon)',
      });
    });

    it('does not warn users who can only read verification configs', async () => {
      roles = ['presentation:request'];
      responses['/api/verifier/config'] = [
        { id: 'old', registration_cert: { jwt: certificate(-1) } },
      ];

      await service.getCounters();

      expect(messages().some((message) => message.includes('Registration certificate'))).toBe(
        false
      );
    });

    it('warns about the issuer registration certificate with a link to its tab', async () => {
      roles = ['issuance:manage'];
      responses['/api/issuer/credentials'] = [];
      responses['/api/issuer/config'] = {
        id: 'config',
        registrationCertificate: { enabled: true, jwt: certificate(2) },
      };

      await service.getCounters();

      const warning = service.warnings.find((entry) =>
        entry.message.startsWith('Issuer registration certificate')
      );
      expect(warning).toEqual({
        message:
          'Issuer registration certificate: Expiring soon — 2 days remaining; request a new one.',
        action: {
          label: 'Open Registration Certificate',
          route: ['/issuance-config'],
          fragment: 'registration-certificate',
        },
      });
    });

    it('suggests the EUDI Hub for a missing issuer certificate only with registrar:manage', async () => {
      responses['/api/issuer/credentials'] = [];
      responses['/api/issuer/config'] = {
        id: 'config',
        registrationCertificate: { enabled: true },
      };
      const issuerWarning = () =>
        service.warnings.find((entry) => entry.message.startsWith('Issuer registration'))?.message;

      roles = ['issuance:manage'];
      await service.getCounters();
      expect(issuerWarning()).toBe(
        'Issuer registration certificate: No certificate — paste a JWT from a registrar.'
      );

      roles = ['issuance:manage', 'registrar:manage'];
      await service.getCounters();
      expect(issuerWarning()).toBe(
        'Issuer registration certificate: No certificate — request one from the EUDI Hub or paste a JWT.'
      );
    });

    it('does not warn about a turned-off or valid issuer registration certificate', async () => {
      roles = ['issuance:manage'];
      responses['/api/issuer/credentials'] = [];
      responses['/api/issuer/config'] = {
        id: 'config',
        registrationCertificate: { enabled: false },
      };
      await service.getCounters();
      expect(messages().some((message) => message.startsWith('Issuer registration'))).toBe(false);

      responses['/api/issuer/config'] = {
        id: 'config',
        registrationCertificate: { enabled: true, jwt: certificate(60) },
      };
      await service.getCounters();
      expect(messages().some((message) => message.startsWith('Issuer registration'))).toBe(false);
    });
  });

  it('links a missing trust list to the trust list form', async () => {
    roles = ['presentation:manage'];
    Object.assign(responses, noSessions);
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    responses['/api/trust-list'] = [];

    await service.getCounters();

    expect(service.warnings).toEqual([
      {
        message: 'No trust list configured. Presentation trust-chain validation may fail.',
        action: { label: 'Add Trust List', route: ['/trust-list/create'] },
      },
    ]);
  });

  it('shows no health signals to users whose roles have none', async () => {
    roles = ['clients:manage'];

    await service.getCounters();

    expect(service.hasHealthSignals).toBe(false);
    expect(requests).toEqual([]);
  });

  it('loads the session overview for sessions:read without offering actions', async () => {
    roles = ['sessions:read'];
    responses['/api/session/stats'] = {};
    responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };

    await service.getCounters();

    expect(service.canViewSessions).toBe(true);
    expect(service.canOfferIssuance).toBe(false);
    expect(requests).toContain('/api/session?pageSize=5&sortBy=updatedAt&sortOrder=desc');
    expect(requests.some((path) => path.startsWith('/api/key-chain'))).toBe(false);
    expect(requests.some((path) => path.startsWith('/api/issuer'))).toBe(false);
  });

  it('loads key chains and KMS health for keys:manage only', async () => {
    roles = ['keys:manage'];
    responses['/api/key-chain'] = [];

    await service.getCounters();

    expect(service.canManageKeyChains).toBe(true);
    expect([...requests].sort()).toEqual([
      '/api/key-chain',
      '/api/key-chain/access/default',
      '/api/key-chain/providers/health',
    ]);
  });

  it("checks only the tenant's default access key chain once one is set", async () => {
    roles = ['keys:manage'];
    responses['/api/key-chain'] = [accessKeyChain(365, 'valid'), accessKeyChain(-1, 'chosen')];
    responses['/api/key-chain/access/default'] = {
      defaultAccessKeyChainId: 'chosen',
      keyChainId: 'chosen',
    };

    await service.getCounters();

    expect(service.accessKeyChains).toBe(2);
    expect(service.accessKeyChainId).toBe('chosen');
    expect(service.hasUsableAccessCertificate).toBe(false);
    expect(service.accessCertificateStatus).toBe('expired');
  });

  it('checks every access key chain when the default cannot be loaded', async () => {
    roles = ['keys:manage'];
    responses['/api/key-chain'] = [accessKeyChain(-1, 'expired'), accessKeyChain(365, 'valid')];
    failures['/api/key-chain/access/default'] = 500;

    await service.getCounters();

    expect(service.hasUsableAccessCertificate).toBe(true);
    expect(service.accessKeyChainId).toBe('valid');
  });

  it('reports a missing certificate when the default access key chain is gone', async () => {
    roles = ['keys:manage'];
    responses['/api/key-chain'] = [accessKeyChain(365, 'valid')];
    responses['/api/key-chain/access/default'] = { defaultAccessKeyChainId: 'gone' };

    await service.getCounters();

    expect(service.accessCertificateStatus).toBe('missing');
    expect(service.defaultAccessKeyChainMissing).toBe(true);
    // The fix is choosing another default, not creating a key chain.
    expect(service.accessCertificateRoute).toEqual(['/keys']);
  });

  it('sends key chain managers without an access key chain to create one', async () => {
    roles = ['issuance:manage', 'keys:manage'];
    Object.assign(responses, noSessions);
    responses['/api/key-chain'] = [];
    responses['/api/issuer/credentials'] = [];
    responses['/api/issuer/config'] = { id: 'config' };

    await service.getCounters();

    expect(requests).toContain('/api/key-chain');
    // The setup guide shows the missing certificate; a warning would repeat it.
    expect(service.showSetupGuide).toBe(true);
    expect(service.warnings).toEqual([]);
    expect(service.accessCertificateRoute).toEqual(['/keys/create']);
    expect(service.verifyReadinessReason).toBe('Read-only: missing presentation:read role');
  });

  it('sends callers without keys:manage to the key list instead of the key wizard', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, noSessions);
    responses['/api/key-chain'] = [];

    await service.getCounters();

    // Creating the access key chain needs keys:manage, so there is no link.
    expect(service.accessCertificateRoute).toBeNull();
    expect(service.issueReadinessReason).toBe(
      'No key chain configured; creating one needs the keys:manage role'
    );
  });

  it('names the missing key chain to presentation managers', async () => {
    roles = ['presentation:manage', 'keys:manage'];
    responses['/api/key-chain'] = [];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    responses['/api/trust-list'] = [{ id: 'list' }];

    await service.getCounters();

    expect(service.verifyReadinessReason).toBe('No key chain configured');
  });

  it('links an expiring access certificate to the key chain that expires first', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, noSessions, issuanceSetUp, {
      '/api/key-chain': [accessKeyChain(400, 'healthy-later'), accessKeyChain(10, 'due')],
    });

    await service.getCounters();

    expect(service.warnings).toEqual([
      {
        message: 'Access certificate expires within 30 days. Plan renewal to avoid interruptions.',
        action: { label: 'Open Access Key Chain', route: ['/keys', 'due'] },
      },
    ]);
  });

  it.each([
    // An access key chain without a certificate comes first; the expired one needs the link.
    ['an expired certificate', [{ id: 'nocert', usageType: 'access' }, accessKeyChain(-1, 'due')]],
    ['no certificate', [{ id: 'due', usageType: 'access' }]],
  ])('sends the setup guide to the access key chain with %s', async (_, keyChains) => {
    roles = ['issuance:manage'];
    Object.assign(responses, noSessions, issuanceSetUp, { '/api/key-chain': keyChains });

    await service.getCounters();

    expect(service.showSetupGuide).toBe(true);
    expect(service.accessCertificateRoute).toEqual(['/keys', 'due']);
    expect(service.warnings).toEqual([]);
  });

  it('names a failed issuance request as the reason issuance is blocked', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, issuanceSetUp);
    delete responses['/api/issuer/credentials'];
    failures['/api/issuer/credentials'] = 500;

    await service.getCounters();

    expect(service.issueReadinessReason).toBe('Credential configs could not be loaded');
    expect(service.showSetupGuide).toBe(false);

    delete failures['/api/issuer/credentials'];
    responses['/api/issuer/credentials'] = [{ id: 'pid' }];
    delete responses['/api/issuer/config'];
    failures['/api/issuer/config'] = 500;
    await service.getCounters();

    expect(service.issueReadinessReason).toBe('Issuer settings could not be loaded');
  });

  it('names failed verification configs to presentation:request users', async () => {
    roles = ['presentation:request'];
    // presentation:request includes presentation:read, which reads the key chains.
    responses['/api/key-chain'] = [accessKeyChain(365)];
    failures['/api/verifier/config'] = 500;

    await service.getCounters();

    expect(service.isReadyToVerify).toBe(false);
    expect(service.verifyReadinessReason).toBe('Verification configs could not be loaded');
  });

  it('does not report a missing trust list when the trust lists failed to load', async () => {
    roles = ['presentation:manage'];
    Object.assign(responses, noSessions);
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [{ id: 'pid' }];
    failures['/api/trust-list'] = 500;

    await service.getCounters();

    expect(messages()).toEqual(['Could not load trust lists.']);
  });

  // New Issuance needs only issuance:offer, which includes issuance:read for its data.
  it('computes the issuance readiness of issuance:offer users like for managers', async () => {
    roles = ['issuance:offer'];
    Object.assign(responses, noSessions, issuanceSetUp);

    await service.getCounters();

    expect(requests).toContain('/api/issuer/credentials');
    expect(requests).toContain('/api/issuer/config');
    expect(service.isReadyToIssue).toBe(true);
    expect(service.issueReadinessReason).toBeNull();
    // Offering is not a setup the user completed, so the setup guide stays hidden.
    expect(service.isSetupComplete).toBe(false);
    expect(service.showSetupGuide).toBe(false);
  });

  it('names the missing role to presentation managers without issuance:offer', async () => {
    roles = ['presentation:manage'];
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [];
    responses['/api/trust-list'] = [];

    await service.getCounters();

    expect(service.isReadyToIssue).toBe(false);
    expect(service.issueReadinessReason).toBe('Read-only: missing issuance:offer role');
    expect(requests.some((path) => path.startsWith('/api/issuer'))).toBe(false);
  });

  it('tells issuance:offer users whom to ask for missing issuer settings', async () => {
    roles = ['issuance:offer'];
    Object.assign(responses, noSessions, issuanceSetUp);
    // The backend answers no issuer settings with an empty body.
    responses['/api/issuer/config'] = null;

    await service.getCounters();

    expect(service.issueReadinessReason).toBe(
      'No issuer settings; ask a user with issuance:manage to configure them'
    );
  });

  it('tells issuance:offer users whom to ask for a missing credential config', async () => {
    roles = ['issuance:offer'];
    Object.assign(responses, noSessions, issuanceSetUp, { '/api/issuer/credentials': [] });

    await service.getCounters();

    expect(service.issueReadinessReason).toBe(
      'No credential config; ask a user with issuance:manage to create one'
    );
  });

  it('lets presentation:request users start a presentation once a config exists', async () => {
    roles = ['presentation:request'];
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [{ id: 'pid' }];

    await service.getCounters();

    expect(service.presentationConfigs).toBe(1);
    expect(service.isReadyToVerify).toBe(true);
    expect(service.verifyReadinessReason).toBeNull();
    expect(requests).not.toContain('/api/trust-list');
  });

  it('names the missing verification config to presentation:request users', async () => {
    roles = ['presentation:request'];
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/verifier/config'] = [];

    await service.getCounters();

    expect(service.isReadyToVerify).toBe(false);
    expect(service.verifyReadinessReason).toBe(
      'No verification config; ask a user with presentation:manage to create one'
    );
  });

  it('keeps the setup guide while the issuance a manager owns is not set up', async () => {
    roles = ['issuance:manage', 'presentation:request'];
    responses['/api/key-chain'] = [accessKeyChain(365)];
    responses['/api/issuer/credentials'] = [];
    responses['/api/issuer/config'] = { id: 'config' };
    responses['/api/verifier/config'] = [{ id: 'pid' }];

    await service.getCounters();

    expect(service.isReadyToVerify).toBe(true);
    expect(service.isReadyToIssue).toBe(false);
    expect(service.isSetupComplete).toBe(false);
    expect(service.showSetupGuide).toBe(true);
  });

  it('keeps the previous values while refreshing, but not on a first load', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, issuanceSetUp);
    await service.getCounters();
    expect(service.credentialConfigs).toBe(1);

    let release: () => void = () => undefined;
    responses['/api/issuer/credentials'] = [{ id: 'pid' }, { id: 'mdl' }];
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = client.getConfig().fetch!;
    client.setConfig({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        await gate;
        return fetchImpl(input, init);
      },
    });

    const refresh = service.getCounters({ keepPrevious: true });
    expect(service.isLoading).toBe(true);
    expect(service.credentialConfigs).toBe(1);
    expect(service.isLoaded('credentials')).toBe(true);
    release();
    await refresh;
    expect(service.credentialConfigs).toBe(2);

    const firstLoad = service.getCounters();
    expect(service.isLoaded('credentials')).toBe(false);
    expect(service.hasLoaded).toBe(false);
    await firstLoad;
  });

  it('applies only the newest of two overlapping loads', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, issuanceSetUp);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = client.getConfig().fetch!;
    client.setConfig({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        await gate;
        return fetchImpl(input, init);
      },
    });
    const older = service.getCounters();

    client.setConfig({ fetch: fetchImpl });
    responses['/api/issuer/credentials'] = [{ id: 'pid' }, { id: 'mdl' }];
    await service.getCounters();
    expect(service.credentialConfigs).toBe(2);

    responses['/api/issuer/credentials'] = [];
    release();
    await older;

    expect(service.credentialConfigs).toBe(2);
    expect(service.isLoading).toBe(false);
  });

  it('does not count the key chains EUDIPLO creates itself', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, issuanceSetUp, {
      '/api/key-chain': [
        { id: 'enc', usageType: 'encrypt' },
        { id: 'authorization-server', usageType: 'authorizationServer' },
      ],
    });

    await service.getCounters();

    expect(service.totalKeyChains).toBe(0);
  });

  it('treats a response of an unexpected shape as failed and still loads the rest', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, issuanceSetUp, { '/api/key-chain': { unexpected: true } });

    await service.getCounters();

    expect(service.hasFailed('keyChains')).toBe(true);
    expect(service.isLoaded('credentials')).toBe(true);
    expect(service.isLoading).toBe(false);
  });

  it.each([
    ['anonymized sessions', 3_600, 'anonymize', 'day', 7, '7 days', false],
    ['two weeks', 14 * 86_400, 'full', 'day', 7, '7 days', false],
    ['three days', 3 * 86_400, 'full', 'day', 3, '3 days', true],
    ['two days', 2 * 86_400, 'full', 'day', 2, '2 days', true],
    ['just under two days', 2 * 86_400 - 1, 'full', 'hour', 24, '24 hours', true],
    ['a day', 86_400, 'full', 'hour', 24, '24 hours', true],
    ['two hours', 7_200, 'full', 'hour', 2, '2 hours', true],
    ['a minute', 60, 'full', 'hour', 1, 'hour', true],
  ] as const)(
    'fits the activity window to sessions kept for %s',
    (_, ttlSeconds, cleanupMode, unit, buckets, label, limitedByRetention) => {
      const window = activityWindow({ ttlSeconds, cleanupMode });

      expect(window).toMatchObject({ unit, label, limitedByRetention });
      expect(window.starts).toHaveLength(buckets);
      expect(window.starts.at(-1)).toEqual(
        unit === 'day' ? new Date(2026, 9, 11) : new Date(2026, 9, 11, 15)
      );
    }
  );

  describe('session activity', () => {
    /** createdFrom and createdTo of every stats request, in request order. */
    let ranges: [string | null, string | null][];
    let bucketBodies: Map<string, object>;
    let windowBody: object;
    let allTime: object;

    const counts = (
      type: 'issuance' | 'presentation',
      byStatus: Record<string, number>,
      failureCodes: object[] = []
    ) => ({
      [type]: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus: statusCounts(byStatus),
        failureCodes,
        lastCompletedAt: null,
      },
    });

    beforeEach(() => {
      roles = ['issuance:offer', 'presentation:request'];
      responses['/api/key-chain'] = [accessKeyChain(365)];
      responses['/api/verifier/config'] = [];
      responses['/api/session'] = { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 };
      ranges = [];
      bucketBodies = new Map();
      windowBody = {};
      allTime = { ...counts('presentation', { active: 2, fetched: 1 }), retention: twoWeeks };
      const fetchImpl = client.getConfig().fetch!;
      client.setConfig({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname !== '/api/session/stats') return fetchImpl(input, init);
          const from = url.searchParams.get('createdFrom');
          const to = url.searchParams.get('createdTo');
          ranges.push([from, to]);
          const body = !from ? allTime : to ? (bucketBodies.get(from) ?? {}) : windowBody;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });
    });

    it('asks for each day of the week, back to back, and the whole week once', async () => {
      await service.getCounters();

      const buckets = ranges.filter(([, to]) => to !== null);
      expect(buckets).toHaveLength(7);
      expect(buckets[0][0]).toBe(new Date(2026, 9, 5).toISOString());
      buckets.forEach(([, to], index) => {
        const next = buckets[index + 1]?.[0] ?? new Date(2026, 9, 12).toISOString();
        expect(new Date(to!).getTime()).toBe(new Date(next).getTime() - 1);
      });
      expect(ranges).toContainEqual([new Date(2026, 9, 5).toISOString(), null]);
      expect(service.activity?.label).toBe('7 days');
    });

    it('uses hours when sessions are deleted after a day', async () => {
      allTime = { ...allTime, retention: { ttlSeconds: 86_400, cleanupMode: 'full' } };

      await service.getCounters();

      const buckets = ranges.filter(([, to]) => to !== null);
      expect(buckets).toHaveLength(24);
      expect(buckets.at(-1)).toEqual([
        new Date(2026, 9, 11, 15).toISOString(),
        new Date(2026, 9, 11, 15, 59, 59, 999).toISOString(),
      ]);
      expect(service.activity).toMatchObject({ unit: 'hour', label: '24 hours' });
    });

    it('takes the KPIs from the whole window and the chart from the buckets', async () => {
      const today = new Date(2026, 9, 11).toISOString();
      bucketBodies.set(today, counts('presentation', { completed: 3, failed: 1, active: 1 }));
      windowBody = {
        ...counts('presentation', { completed: 6, failed: 3, expired: 1, active: 2 }, [
          { code: 'invalid_proof', count: 2 },
          { code: 'access_denied', count: 1 },
          { code: 'b_code', count: 1 },
          { code: 'c_code', count: 1 },
          { code: 'd_code', count: 1 },
        ]),
        ...counts('issuance', { failed: 1 }, [{ code: 'access_denied', count: 1 }]),
      };

      await service.getCounters();

      expect(service.sessionsInWindow).toBe(13);
      expect(service.failedInWindow).toBe(4);
      expect(service.finishedInWindow).toBe(11);
      expect(service.successRate).toBeCloseTo(6 / 11);
      // The same code of both types adds up; five codes at most.
      expect(service.topFailureCodes).toEqual([
        { code: 'access_denied', count: 2 },
        { code: 'invalid_proof', count: 2 },
        { code: 'b_code', count: 1 },
        { code: 'c_code', count: 1 },
        { code: 'd_code', count: 1 },
      ]);
      expect(service.sessionsInCurrentBucket).toBe(5);
      expect(service.activityBuckets.at(-1)).toMatchObject({
        total: 5,
        completed: 3,
        failed: 1,
        notCompleted: 1,
      });
      expect(service.activityBuckets.slice(0, 6).map((bucket) => bucket.total)).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
      // Pending sessions count over everything that is stored.
      expect(service.pendingSessions).toBe(3);
    });

    it('keeps the window for labels and links when a bucket request fails', async () => {
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

      await service.getCounters();

      expect(service.hasFailed('activity')).toBe(true);
      expect(service.isLoaded('window')).toBe(true);
      expect(service.activity?.label).toBe('7 days');
      expect(service.warnings.map((warning) => warning.message)).toEqual([
        'Could not load session activity.',
      ]);
    });

    it('reports no success rate while no session of the window finished', async () => {
      windowBody = counts('presentation', { active: 2 });

      await service.getCounters();

      expect(service.finishedInWindow).toBe(0);
      expect(service.successRate).toBeNull();
    });
  });

  it('warns about an unreachable KMS provider', async () => {
    roles = ['issuance:manage'];
    Object.assign(responses, noSessions, issuanceSetUp, {
      '/api/key-chain/providers/health': [
        { providerId: 'db', type: 'db', ok: true },
        { providerId: 'vault', type: 'vault', ok: false, error: 'connection refused' },
      ],
    });

    await service.getCounters();

    expect(service.unhealthyKmsProviders.map((provider) => provider.providerId)).toEqual(['vault']);
    expect(service.warnings).toEqual([
      {
        message: 'KMS provider vault is not reachable: connection refused',
        action: { label: 'Open KMS Providers', route: ['/kms'] },
      },
    ]);
  });
});
