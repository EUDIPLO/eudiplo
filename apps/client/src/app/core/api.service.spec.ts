import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientControllerGetClients } from '@eudiplo/sdk-core';
import { ApiRefusalService } from './api-refusal.service';
import { ApiService, defaultApiUrl } from './api.service';
import { OidcService } from './oidc.service';

/** Replaces `localStorage` with an in-memory store the test can inspect. */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  return store;
}

describe('defaultApiUrl', () => {
  it('prefers the runtime API_BASE_URL over the build-time default', () => {
    expect(defaultApiUrl('https://eudiplo.example.com', 'https://your-api-prod.com')).toBe(
      'https://eudiplo.example.com'
    );
  });

  it('falls back to the build-time default without a runtime value', () => {
    expect(defaultApiUrl(undefined, 'https://your-api-prod.com')).toBe('https://your-api-prod.com');
  });

  it('falls back to localhost when nothing is configured', () => {
    expect(defaultApiUrl()).toBe('http://localhost:3000');
  });
});

describe('ApiService and the instance it signs in to', () => {
  const oidcStub: { mode: 'local' | 'oidc'; apiUrl?: string } = { mode: 'local' };

  beforeEach(() => {
    stubLocalStorage();
    oidcStub.mode = 'local';
    oidcStub.apiUrl = undefined;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: OidcService, useValue: oidcStub },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('points the client at the backend of a restored OIDC session', () => {
    const service = TestBed.inject(ApiService);
    oidcStub.mode = 'oidc';
    oidcStub.apiUrl = 'https://eudiplo.example.com';

    service.syncWithOidcSession();

    expect(service.getBaseUrl()).toBe('https://eudiplo.example.com');
  });

  it('remembers the instance of a restored OIDC session as the one last signed in to', () => {
    const service = TestBed.inject(ApiService);
    oidcStub.mode = 'oidc';
    oidcStub.apiUrl = 'https://eudiplo.example.com';

    service.syncWithOidcSession();

    expect(service.lastSignedInInstance()).toBe('https://eudiplo.example.com');
  });

  it('keeps the instance it last signed in to after a logout', () => {
    const service = TestBed.inject(ApiService);
    service.rememberSignedInInstance('https://a.test');

    service.logout();

    expect(service.lastSignedInInstance()).toBe('https://a.test');
  });

  it('asks the instance for discovery without telling it the page address', async () => {
    const service = TestBed.inject(ApiService);
    const controller = TestBed.inject(HttpTestingController);

    const discovery = service.fetchDiscovery('https://other.test');
    const request = controller.expectOne(
      'https://other.test/.well-known/oauth-authorization-server'
    );
    request.flush({ issuer: 'https://other.test' });

    await expect(discovery).resolves.toEqual({ issuer: 'https://other.test' });
    expect(request.request.referrerPolicy).toBe('no-referrer');
  });

  it('keeps the current base URL when no OIDC session was restored', () => {
    const service = TestBed.inject(ApiService);
    const before = service.getBaseUrl();
    oidcStub.apiUrl = 'https://eudiplo.example.com';

    service.syncWithOidcSession();

    expect(service.getBaseUrl()).toBe(before);
    expect(service.lastSignedInInstance()).toBeUndefined();
  });
});

describe('ApiService token refresh', () => {
  const backend = 'http://backend.test';
  const tokenEndpoint = `${backend}/api/oauth2/token`;
  const oidcStub: { mode: 'local' | 'oidc' } = { mode: 'local' };
  const fetchMock = vi.fn<typeof fetch>();
  let store: Map<string, string>;

  /** A token response; tokens live 60 minutes, so the refresh runs after 55. */
  const tokenResponse = (accessToken: string) =>
    new Response(
      JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const oauthError = (status: number, error: string) => jsonError(status, { error });
  const jsonError = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  /** What EUDIPLO's token endpoint answers for unknown or deleted clients and wrong secrets. */
  const backendRejection = () =>
    jsonError(401, {
      statusCode: 401,
      message: 'Invalid client credentials',
      error: 'Unauthorized',
    });
  /** Answers every request with a fresh response; a response body can be read only once. */
  const answerAlways = (response: () => Response) =>
    fetchMock.mockImplementation(() => Promise.resolve(response()));
  const runScheduledRefresh = () => vi.advanceTimersByTimeAsync(55 * 60_000);
  const reload = () =>
    new ApiService(TestBed.inject(HttpClient), oidcStub as unknown as OidcService);
  const requestedClientIds = () =>
    fetchMock.mock.calls.map(
      ([, init]) =>
        atob(String(new Headers(init?.headers).get('Authorization')).slice('Basic '.length)).split(
          ':'
        )[0]
    );

  function storeSession(expiresInMs: number): void {
    store.set('access_token', 'stored');
    store.set('token_expiration', String(Date.now() + expiresInMs));
    store.set(
      'oauth_config',
      JSON.stringify({
        server: backend,
        clientId: 'client',
        baseUrl: backend,
        tokenEndpoint,
      })
    );
  }

  async function signIn(): Promise<ApiService> {
    const service = TestBed.inject(ApiService);
    fetchMock.mockResolvedValueOnce(tokenResponse('first'));
    await service.loginWithClientCredentials('client', 'secret', backend, backend, tokenEndpoint);
    await service.refreshAccessToken();
    return service;
  }

  /** Holds the next token request until the test resolves it. */
  function holdNextRequest(): (response: Response) => void {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    return (response) => resolve(response);
  }

  beforeEach(() => {
    oidcStub.mode = 'local';
    store = stubLocalStorage();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), { provide: OidcService, useValue: oidcStub }],
    });
  });

  afterEach(() => {
    delete (oidcStub as { logout?: unknown }).logout;
    delete (oidcStub as { clearStorage?: unknown }).clearStorage;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the session when the backend cannot be reached and saves the token once it is back', async () => {
    const service = await signIn();

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await runScheduledRefresh();

    // The current token is valid for five more minutes and the settings stay stored.
    expect(service.getAuthenticationStatus()).toBe(true);
    expect(service.isReconnecting()).toBe(true);
    expect(store.get('access_token')).toBe('first');
    expect(store.has('oauth_config')).toBe(true);

    fetchMock.mockResolvedValueOnce(tokenResponse('second'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.isReconnecting()).toBe(false);
    expect(store.get('access_token')).toBe('second');
    const reloaded = reload();
    expect(reloaded.getAuthenticationStatus()).toBe(true);
    expect(reloaded.accessToken).toBe('second');
  });

  it('retries with a growing delay through server errors and resumes after the token expired', async () => {
    const service = await signIn();

    answerAlways(() => oauthError(503, 'temporarily_unavailable'));
    await runScheduledRefresh();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Past the token's expiry the session is no longer usable, but it is not forgotten.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(service.getAuthenticationStatus()).toBe(false);
    expect(service.isReconnecting()).toBe(true);
    expect(service.hasKeptSession()).toBe(true);
    expect(store.has('oauth_config')).toBe(true);

    answerAlways(() => tokenResponse('second'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.hasKeptSession()).toBe(false);
    expect(service.getAuthenticationStatus()).toBe(true);
    expect(store.get('access_token')).toBe('second');
  });

  it.each([403, 404])(
    'keeps the session when the token endpoint answers %i, as a proxy may while the backend restarts',
    async (status) => {
      const service = await signIn();

      fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status }));
      await runScheduledRefresh();

      expect(service.isReconnecting()).toBe(true);
      fetchMock.mockResolvedValueOnce(tokenResponse('second'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.get('access_token')).toBe('second');
    }
  );

  it('renews through ensureAuthenticated, as SDK calls do, once the backend is back', async () => {
    const service = await signIn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(service.getAuthenticationStatus()).toBe(false);

    await expect(service.ensureAuthenticated()).resolves.toBe(false);
    expect(store.has('oauth_config')).toBe(true);

    answerAlways(() => tokenResponse('second'));
    await expect(service.ensureAuthenticated()).resolves.toBe(true);
    expect(store.get('access_token')).toBe('second');
  });

  it.each([
    ['400 invalid_client', () => oauthError(400, 'invalid_client')],
    ["EUDIPLO's 401", backendRejection],
  ])(
    'ends the session and stops sending the credentials when the token endpoint answers %s',
    async (_, rejection) => {
      const service = await signIn();
      // The waiting login page takes the rejection while sessionEnded$ emits.
      const ended = vi.fn(() => service.takeEndedSession());
      service.sessionEnded$.subscribe(ended);

      fetchMock.mockResolvedValueOnce(rejection());
      await runScheduledRefresh();

      expect(ended).toHaveBeenCalledOnce();
      expect(ended).toHaveReturnedWith({
        clientId: 'client',
        baseUrl: backend,
        reason: 'rejected',
      });
      // Reported once.
      expect(service.takeEndedSession()).toBeUndefined();
      expect(service.getAuthenticationStatus()).toBe(false);
      expect(service.isReconnecting()).toBe(false);
      expect(service.hasKeptSession()).toBe(false);
      expect(service.canRefreshToken()).toBe(false);
      expect([...store.keys()]).toEqual([]);
      // The token stays usable until it expires, and the menu still names the client.
      expect(service.accessToken).toBe('first');
      expect(service.getClientId()).toBe('client');
      await expect(service.ensureAuthenticated()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reload().getAuthenticationStatus()).toBe(false);
    }
  );

  it('ends a restored session, which has no secret, instead of retrying', async () => {
    storeSession(10 * 60_000);
    const service = TestBed.inject(ApiService);

    await expect(service.refreshAccessToken()).rejects.toThrow('not properly configured');

    expect(service.getAuthenticationStatus()).toBe(false);
    expect([...store.keys()]).toEqual([]);
    expect(service.isReconnecting()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not report a rejected first sign-in, which the login form reports itself', async () => {
    const service = TestBed.inject(ApiService);
    fetchMock.mockResolvedValueOnce(backendRejection());
    await service.loginWithClientCredentials('client', 'wrong', backend, backend, tokenEndpoint);

    await expect(service.refreshAccessToken()).rejects.toThrow();

    expect(service.takeEndedSession()).toBeUndefined();
    expect([...store.keys()]).toEqual([]);
  });

  it('keeps a rejection to report through the logout of the expired notice', async () => {
    const service = await signIn();
    fetchMock.mockResolvedValueOnce(backendRejection());
    await runScheduledRefresh();

    service.logout();

    expect(service.takeEndedSession()).toEqual({
      clientId: 'client',
      baseUrl: backend,
      reason: 'rejected',
    });
  });

  it('keeps the rejection as the reason when the expired notice logs out', async () => {
    const service = await signIn();
    fetchMock.mockResolvedValueOnce(backendRejection());
    await runScheduledRefresh();

    service.logoutExpired();

    expect(service.takeEndedSession()?.reason).toBe('rejected');
  });

  it('stops renewing the previous session when a new sign-in starts, even if discovery fails', async () => {
    const service = await signIn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(service.hasKeptSession()).toBe(true);
    const requests = fetchMock.mock.calls.length;
    vi.spyOn(service, 'fetchDiscovery').mockRejectedValue(new Error('Discovery failed'));

    await expect(service.loginWithClientCredentials('other', 'secret', backend)).rejects.toThrow(
      'Discovery failed'
    );
    answerAlways(() => tokenResponse('previous'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(service.isReconnecting()).toBe(false);
    expect(service.hasKeptSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it('does not keep or retry credentials whose first token request fails', async () => {
    const service = TestBed.inject(ApiService);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await service.loginWithClientCredentials('client', 'secret', backend, backend, tokenEndpoint);

    await expect(service.refreshAccessToken()).rejects.toThrow('Failed to fetch');

    expect([...store.keys()]).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never stores the client secret', async () => {
    const service = await signIn();
    await runScheduledRefresh();

    expect(service.canRefreshToken()).toBe(true);
    expect([...store.keys()].sort()).toEqual(['access_token', 'oauth_config', 'token_expiration']);
    expect([...store.values()].some((value) => value.includes('secret'))).toBe(false);
  });

  it('removes a client secret stored by an earlier version on startup', () => {
    store.set('oauth_client_secret', 'secret');

    const service = TestBed.inject(ApiService);

    expect(store.has('oauth_client_secret')).toBe(false);
    expect(service.canRefreshToken()).toBe(false);
  });

  it('keeps a restored session until its token expires, without renewing it', async () => {
    store.set('oauth_client_secret', 'secret');
    storeSession(10 * 60_000);

    const service = TestBed.inject(ApiService);

    expect(store.has('oauth_client_secret')).toBe(false);
    expect(service.getAuthenticationStatus()).toBe(true);
    expect(service.accessToken).toBe('stored');
    expect(service.getClientId()).toBe('client');
    expect(service.getBaseUrl()).toBe(backend);
    expect(service.canRefreshToken()).toBe(false);
    expect(service.hasKeptSession()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(service.getAuthenticationStatus()).toBe(false);
    expect(service.hasKeptSession()).toBe(false);
    await expect(service.ensureAuthenticated()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.hasEndedSession()).toBe(false);

    // The expired notice logs out and hands the client and instance, not the secret, to the login page.
    service.logoutExpired();

    expect(service.getClientId()).toBeUndefined();
    expect(service.hasEndedSession()).toBe(true);
    expect(service.takeEndedSession()).toEqual({
      clientId: 'client',
      baseUrl: backend,
      reason: 'expired',
    });
    expect(service.hasEndedSession()).toBe(false);
    expect([...store.keys()]).toEqual([]);
  });

  it('hands no ended session to the login page after a plain logout', async () => {
    const service = await signIn();
    service.logout();
    expect(service.hasEndedSession()).toBe(false);
  });

  it("ends an expired SSO session here only, keeping the provider's for signing in again", async () => {
    const service = await signIn();
    expect(service.getClientId()).toBe('client');
    oidcStub.mode = 'oidc';
    const logout = vi.fn();
    const clearStorage = vi.fn();
    Object.assign(oidcStub, { logout, clearStorage });

    service.logoutExpired();

    // A logout at the provider would leave the page and lose the in-app login page.
    expect(logout).not.toHaveBeenCalled();
    expect(clearStorage).toHaveBeenCalledOnce();
    expect(service.hasEndedSession()).toBe(false);
  });

  it('hands no ended session to the login page for an expired stored session without a client ID', () => {
    store.set('access_token', 'stored');
    store.set('token_expiration', String(Date.now() - 1_000));
    store.set('oauth_config', JSON.stringify({ server: backend, baseUrl: backend }));

    const service = TestBed.inject(ApiService);

    expect(service.hasEndedSession()).toBe(false);
    expect([...store.keys()]).toEqual([]);
  });

  it('forgets the ended session on a new sign-in', async () => {
    storeSession(-1_000);
    const service = TestBed.inject(ApiService);
    expect(service.hasEndedSession()).toBe(true);

    fetchMock.mockResolvedValueOnce(tokenResponse('first'));
    await service.loginWithClientCredentials('other', 'secret', backend, backend, tokenEndpoint);

    expect(service.takeEndedSession()).toBeUndefined();
  });

  describe('token renewed by another tab', () => {
    /** The event a browser sends to the other tabs after one stored a token; the listener reads only its key. */
    function announceStoredToken(): void {
      globalThis.dispatchEvent(Object.assign(new Event('storage'), { key: 'token_expiration' }));
    }

    /** Another tab of the same browser stores its new token; only other tabs get the event. */
    function storeFromOtherTab(
      token: string,
      expiresInMs: number,
      { clientId = 'client', baseUrl = backend } = {}
    ): void {
      store.set('access_token', token);
      store.set('token_expiration', String(Date.now() + expiresInMs));
      store.set(
        'oauth_config',
        JSON.stringify({ server: baseUrl, clientId, baseUrl, tokenEndpoint })
      );
      announceStoredToken();
    }

    it('is taken by a restored session, which cannot renew its own token', async () => {
      storeSession(2 * 60_000);
      const service = TestBed.inject(ApiService);
      const renewed = vi.fn();
      service.tokenRenewed$.subscribe(renewed);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(service.getAuthenticationStatus()).toBe(false);

      storeFromOtherTab('other-tab', 60 * 60_000);

      expect(service.accessToken).toBe('other-tab');
      expect(service.getAuthenticationStatus()).toBe(true);
      expect(renewed).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is not taken when it belongs to another client or backend, is older or has no expiry', async () => {
      storeSession(30 * 60_000);
      const service = TestBed.inject(ApiService);

      storeFromOtherTab('other-client', 60 * 60_000, { clientId: 'other' });
      storeFromOtherTab('other-backend', 60 * 60_000, { baseUrl: 'http://other.test' });
      storeFromOtherTab('older', 10 * 60_000);
      store.set('access_token', 'no-expiry');
      store.delete('token_expiration');
      announceStoredToken();

      expect(service.accessToken).toBe('stored');
    });

    it('is not taken by a tab that logged out', async () => {
      storeSession(30 * 60_000);
      const service = TestBed.inject(ApiService);
      const renewed = vi.fn();
      service.tokenRenewed$.subscribe(renewed);
      service.logout();

      storeFromOtherTab('other-tab', 60 * 60_000);

      expect(service.accessToken).toBe('');
      expect(service.getAuthenticationStatus()).toBe(false);
      expect(renewed).not.toHaveBeenCalled();
    });

    it('is not taken in SSO mode', async () => {
      storeSession(30 * 60_000);
      const service = TestBed.inject(ApiService);
      const renewed = vi.fn();
      service.tokenRenewed$.subscribe(renewed);
      oidcStub.mode = 'oidc';

      storeFromOtherTab('other-tab', 60 * 60_000);

      expect(renewed).not.toHaveBeenCalled();
      oidcStub.mode = 'local';
      expect(service.accessToken).toBe('stored');
    });

    it('is taken by a tab whose credentials were rejected, which then reports no rejection', async () => {
      const service = await signIn();
      fetchMock.mockResolvedValueOnce(oauthError(401, 'invalid_client'));
      await runScheduledRefresh();
      expect(service.areCredentialsRejected()).toBe(true);

      storeFromOtherTab('other-tab', 2 * 60 * 60_000);

      expect(service.accessToken).toBe('other-tab');
      expect(service.getAuthenticationStatus()).toBe(true);
      expect(service.areCredentialsRejected()).toBe(false);
      expect(service.takeEndedSession()).toBeUndefined();
    });

    it('is not taken by a tab that renews its own token', async () => {
      const service = await signIn();

      storeFromOtherTab('other-tab', 2 * 60 * 60_000);

      expect(service.accessToken).toBe('first');
    });

    it('is not stored again after another tab logged out, so a reload stays logged out', async () => {
      const service = await signIn();
      store.clear();

      fetchMock.mockResolvedValueOnce(tokenResponse('second'));
      await runScheduledRefresh();

      expect(service.accessToken).toBe('second');
      expect([...store.keys()]).toEqual([]);
    });

    it('is stored with the settings of the tab that renews it', async () => {
      const service = await signIn();
      store.set(
        'oauth_config',
        JSON.stringify({ server: backend, clientId: 'other', baseUrl: backend, tokenEndpoint })
      );

      fetchMock.mockResolvedValueOnce(tokenResponse('second'));
      await runScheduledRefresh();

      expect(service.accessToken).toBe('second');
      expect(store.get('access_token')).toBe('second');
      expect(JSON.parse(store.get('oauth_config') ?? '{}').clientId).toBe('client');
    });
  });

  it('forgets a stored session whose token expired, without a token request, and hands its client to the login page', async () => {
    store.set('oauth_client_secret', 'secret');
    storeSession(-1_000);

    const service = TestBed.inject(ApiService);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(service.getAuthenticationStatus()).toBe(false);
    expect(service.hasKeptSession()).toBe(false);
    expect(service.takeEndedSession()).toEqual({
      clientId: 'client',
      baseUrl: backend,
      reason: 'expired',
    });
    expect([...store.keys()]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in with new credentials while a refresh for the previous ones is still pending', async () => {
    const service = await signIn();
    const answerPrevious = holdNextRequest();
    void service.refreshAccessToken().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValueOnce(tokenResponse('other'));
    await service.loginWithClientCredentials(
      'other',
      'other-secret',
      backend,
      backend,
      tokenEndpoint
    );
    const login = service.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    // The previous credentials' answer arrives last.
    answerPrevious(tokenResponse('previous'));
    await login;
    await vi.advanceTimersByTimeAsync(0);

    expect(requestedClientIds()).toEqual(['client', 'client', 'other']);
    expect(service.accessToken).toBe('other');
    expect(store.get('access_token')).toBe('other');
    expect(JSON.parse(store.get('oauth_config') ?? '{}').clientId).toBe('other');
  });

  it('continues the session with a rotated secret of the signed-in client', async () => {
    const service = await signIn();
    fetchMock.mockResolvedValueOnce(tokenResponse('rotated'));

    await service.useRotatedSecret('new-secret');

    const [url, init] = fetchMock.mock.lastCall ?? [];
    expect(String(url)).toBe(tokenEndpoint);
    expect(atob(String(new Headers(init?.headers).get('Authorization')).slice(6))).toBe(
      'client:new-secret'
    );
    expect(service.accessToken).toBe('rotated');
    expect(service.getClientSecret()).toBe('new-secret');
    // Kept in memory only; the stored old secret is refused now.
    expect(store.has('oauth_client_secret')).toBe(false);

    // A reload keeps the renewed token until it expires, without renewing it.
    const reloaded = reload();
    expect(reloaded.accessToken).toBe('rotated');
    expect(reloaded.canRefreshToken()).toBe(false);
  });

  it('renews a reloaded session again with a rotated secret of its client', async () => {
    storeSession(10 * 60_000);
    store.set(
      'oauth_config',
      JSON.stringify({ server: backend, clientId: 'client', baseUrl: backend })
    );
    const service = TestBed.inject(ApiService);
    fetchMock.mockResolvedValueOnce(tokenResponse('rotated'));

    await service.useRotatedSecret('new-secret');

    // Settings stored without a token endpoint use the backend default.
    expect(String(fetchMock.mock.lastCall?.[0])).toBe(tokenEndpoint);
    expect(service.accessToken).toBe('rotated');
    expect(service.canRefreshToken()).toBe(true);
    expect(store.get('access_token')).toBe('rotated');
    expect([...store.values()].some((value) => value.includes('secret'))).toBe(false);
  });

  it('sends a rotated secret of a reloaded tab nowhere once another client signed in', async () => {
    storeSession(10 * 60_000);
    const service = TestBed.inject(ApiService);
    const stored = JSON.parse(store.get('oauth_config') ?? '{}');
    store.set('oauth_config', JSON.stringify({ ...stored, clientId: 'other' }));

    await expect(service.useRotatedSecret('new-secret')).rejects.toThrow('Please log in again');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.canRefreshToken()).toBe(false);
  });

  it('keeps a new sign-in when the previous credentials are rejected afterwards', async () => {
    const service = await signIn();
    const answerPrevious = holdNextRequest();
    void service.refreshAccessToken().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValueOnce(tokenResponse('other'));
    await service.loginWithClientCredentials(
      'other',
      'other-secret',
      backend,
      backend,
      tokenEndpoint
    );
    await service.refreshAccessToken();
    answerPrevious(backendRejection());
    await vi.advanceTimersByTimeAsync(0);

    expect(service.accessToken).toBe('other');
    expect(service.getAuthenticationStatus()).toBe(true);
    expect(service.getClientSecret()).toBe('other-secret');
    expect(store.get('access_token')).toBe('other');
    expect(JSON.parse(store.get('oauth_config') ?? '{}').clientId).toBe('other');
  });

  it('stays logged out when a refresh finishes after logout', async () => {
    const service = await signIn();
    const answerPending = holdNextRequest();
    const pending = service.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(0);

    const ended = vi.fn();
    service.sessionEnded$.subscribe(ended);
    service.logout();
    expect(ended).toHaveBeenCalledOnce();
    answerPending(tokenResponse('late'));
    await pending;

    expect(service.getAuthenticationStatus()).toBe(false);
    expect(service.hasKeptSession()).toBe(false);
    expect(service.accessToken).toBe('');
    expect([...store.keys()]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('ApiRefusalService', () => {
    /** Lets the handling of a refusal finish in the background. */
    const settle = () => vi.advanceTimersByTimeAsync(0);

    async function signedInWithRefusals() {
      const service = await signIn();
      return { service, refusals: TestBed.inject(ApiRefusalService) };
    }

    it('ends the access once when the backend refuses the token and the client is rejected', async () => {
      const { service, refusals } = await signedInWithRefusals();
      const revoked = vi.fn();
      refusals.accessRevoked$.subscribe(revoked);
      fetchMock.mockResolvedValueOnce(backendRejection());

      refusals.handleApiResponse(401, 'first');
      await settle();
      refusals.handleApiResponse(401, 'first');
      await settle();

      expect(refusals.isAccessRevoked()).toBe(true);
      expect(service.areCredentialsRejected()).toBe(true);
      expect(revoked).toHaveBeenCalledOnce();
      // Sign-in and one renewal; the second refusal sends no token request.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('forgets rejected credentials on a new sign-in and on logout', async () => {
      const { service, refusals } = await signedInWithRefusals();
      fetchMock.mockResolvedValueOnce(backendRejection());
      refusals.handleApiResponse(401, 'first');
      await settle();

      fetchMock.mockResolvedValueOnce(tokenResponse('other'));
      await service.loginWithClientCredentials('other', 'secret', backend, backend, tokenEndpoint);
      await service.refreshAccessToken();
      expect(service.areCredentialsRejected()).toBe(false);
      expect(refusals.isAccessRevoked()).toBe(false);

      fetchMock.mockResolvedValueOnce(backendRejection());
      await service.refreshAccessToken().catch(() => undefined);
      expect(service.areCredentialsRejected()).toBe(true);
      service.logout();
      expect(service.areCredentialsRejected()).toBe(false);
    });

    it('renews a refused token once and ends the access when the new one is refused too', async () => {
      const { service, refusals } = await signedInWithRefusals();
      fetchMock.mockResolvedValueOnce(tokenResponse('second'));

      refusals.handleApiResponse(401, 'first');
      await settle();
      expect(service.accessToken).toBe('second');
      expect(refusals.isAccessRevoked()).toBe(false);

      refusals.handleApiResponse(401, 'second');
      await settle();
      expect(refusals.isAccessRevoked()).toBe(true);
      expect(service.areCredentialsRejected()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ends the access of a session that cannot renew its token without a token request', async () => {
      storeSession(10 * 60_000);
      const refusals = TestBed.inject(ApiRefusalService);

      refusals.handleApiResponse(401, 'stored');
      await settle();

      expect(refusals.isAccessRevoked()).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a role check refusal of a restored session, which has no secret to renew', async () => {
      storeSession(10 * 60_000);
      const service = TestBed.inject(ApiService);
      const refusals = TestBed.inject(ApiRefusalService);
      const rolesRefused = vi.fn();
      refusals.rolesRefusedWithoutRenewal$.subscribe(rolesRefused);

      refusals.handleApiResponse(403, 'stored', { statusCode: 403, message: 'Forbidden resource' });
      await settle();

      expect(rolesRefused).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(refusals.isAccessRevoked()).toBe(false);
      expect(service.accessToken).toBe('stored');
    });

    it('does not report 403s that a new token would not change', async () => {
      storeSession(10 * 60_000);
      const refusals = TestBed.inject(ApiRefusalService);
      const rolesRefused = vi.fn();
      refusals.rolesRefusedWithoutRenewal$.subscribe(rolesRefused);

      // A reason of its own, no reason, and a refusal of a token that was replaced.
      refusals.handleApiResponse(403, 'stored', {
        statusCode: 403,
        message: 'This endpoint requires a tenant context. Use a tenant-bound account.',
      });
      refusals.handleApiResponse(403, 'stored');
      refusals.handleApiResponse(403, 'older', { statusCode: 403, message: 'Forbidden resource' });
      oidcStub.mode = 'oidc';
      refusals.handleApiResponse(403, 'stored', { statusCode: 403, message: 'Forbidden resource' });
      await settle();

      expect(rolesRefused).not.toHaveBeenCalled();
    });

    it('renews a session with its secret instead of reporting a role check refusal', async () => {
      const { refusals } = await signedInWithRefusals();
      const rolesRefused = vi.fn();
      refusals.rolesRefusedWithoutRenewal$.subscribe(rolesRefused);
      fetchMock.mockResolvedValueOnce(tokenResponse('next'));

      refusals.handleApiResponse(403, 'first', { statusCode: 403, message: 'Forbidden resource' });
      await settle();

      expect(rolesRefused).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves an expired token of a restored session to the expiry notice', async () => {
      storeSession(2 * 60_000);
      TestBed.inject(ApiService);
      const refusals = TestBed.inject(ApiRefusalService);
      const revoked = vi.fn();
      refusals.accessRevoked$.subscribe(revoked);
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      refusals.handleApiResponse(401, 'stored');
      await settle();

      expect(refusals.isAccessRevoked()).toBe(false);
      expect(revoked).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends one token request for refusals that arrive together', async () => {
      const { refusals } = await signedInWithRefusals();
      const revoked = vi.fn();
      refusals.accessRevoked$.subscribe(revoked);
      const answer = holdNextRequest();

      refusals.handleApiResponse(401, 'first');
      refusals.handleApiResponse(401, 'first');
      refusals.handleApiResponse(403, 'first');
      answer(backendRejection());
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(revoked).toHaveBeenCalledOnce();
    });

    it('keeps the session when the token endpoint cannot be reached after a refusal', async () => {
      const { service, refusals } = await signedInWithRefusals();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      refusals.handleApiResponse(401, 'first');
      await settle();

      expect(refusals.isAccessRevoked()).toBe(false);
      expect(service.isReconnecting()).toBe(true);
    });

    it('ignores other answers, refusals of a replaced token and OIDC sessions', async () => {
      const { refusals } = await signedInWithRefusals();

      for (const status of [200, 400, 404, 500]) refusals.handleApiResponse(status, 'first');
      refusals.handleApiResponse(401, 'older');
      refusals.handleApiResponse(403, 'older');
      oidcStub.mode = 'oidc';
      refusals.handleApiResponse(401, 'first');
      await settle();

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('renews the token after a 403 at most once a minute', async () => {
      const { service, refusals } = await signedInWithRefusals();
      const renewed = vi.fn();
      service.tokenRenewed$.subscribe(renewed);
      answerAlways(() => tokenResponse('next'));

      refusals.handleApiResponse(403, 'first');
      await settle();
      refusals.handleApiResponse(403, 'next');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(renewed).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(61_000);
      refusals.handleApiResponse(403, 'next');
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('watches the answers of SDK calls until it is destroyed', async () => {
      const { refusals } = await signedInWithRefusals();
      const refused = () =>
        clientControllerGetClients({
          fetch: () => Promise.resolve(new Response(null, { status: 401 })),
          throwOnError: false,
        });
      const handle = vi.spyOn(refusals, 'handleApiResponse').mockImplementation(() => undefined);

      await refused();
      expect(handle).toHaveBeenCalledWith(401, 'first');

      // A 403 is reported with its body, which tells a role check refusal from other reasons.
      const reason = { statusCode: 403, message: 'Forbidden resource' };
      await clientControllerGetClients({
        fetch: () => Promise.resolve(Response.json(reason, { status: 403 })),
        throwOnError: false,
      });
      await settle();
      expect(handle).toHaveBeenLastCalledWith(403, 'first', reason);
      // A body that is not JSON still reports the refusal, without a reason.
      await clientControllerGetClients({
        fetch: () => Promise.resolve(new Response('', { status: 403 })),
        throwOnError: false,
      });
      await settle();
      expect(handle).toHaveBeenLastCalledWith(403, 'first', undefined);
      handle.mockClear();

      refusals.ngOnDestroy();
      await refused();
      expect(handle).not.toHaveBeenCalled();
    });
  });
});
