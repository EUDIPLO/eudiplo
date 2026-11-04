import type { MatSnackBar } from '@angular/material/snack-bar';
import type { Router } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiService } from '../core';
import { type Caller, JwtService } from './jwt.service';

describe('JwtService', () => {
  let api: {
    accessToken: string;
    clientId?: string;
    getClientId: () => string | undefined;
    sessionEnded$: Subject<void>;
  };
  /** What `GET /api/auth/me` answers; each request takes the next entry, a number is an error status. */
  let callers: (Caller | number)[];
  let requests: string[];
  let snackBar: { open: ReturnType<typeof vi.fn> };
  /** Clicks the action of the last snack bar. */
  let retry: Subject<void>;
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };
  let service: JwtService;

  const answer = (next: Caller | number) =>
    typeof next === 'number'
      ? new Response(JSON.stringify({ statusCode: next, message: 'Service Unavailable' }), {
          status: next,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

  beforeEach(() => {
    api = {
      accessToken: '',
      clientId: 'shop',
      getClientId: () => api.clientId,
      sessionEnded$: new Subject(),
    };
    callers = [];
    requests = [];
    retry = new Subject();
    snackBar = { open: vi.fn(() => ({ onAction: () => retry })) };
    router = { navigateByUrl: vi.fn(async () => true) };
    client.setConfig({
      fetch: async (request: RequestInfo | URL) => {
        requests.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
        return answer(callers.shift() ?? 500);
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new JwtService(
      api as unknown as ApiService,
      snackBar as unknown as MatSnackBar,
      router as unknown as Router
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('has no roles and no tenant before the caller is loaded', () => {
    expect(service.getRoles()).toEqual([]);
    expect(service.getTenantId()).toBeNull();
    expect(service.hasRole('clients:manage')).toBe(false);
  });

  it("takes the roles and the tenant from the backend's caller", async () => {
    api.accessToken = 'token-a';
    callers = [{ subject: 'alice', tenantId: 'acme', roles: ['issuance:offer', 'users:manage'] }];

    await service.loadCaller();

    expect(requests).toEqual(['/api/auth/me']);
    expect(service.getRoles()).toEqual(['issuance:offer', 'users:manage']);
    expect(service.grantableRoles()).toEqual(['issuance:offer', 'users:manage']);
    expect(service.hasRole('users:manage')).toBe(true);
    expect(service.getTenantId()).toBe('acme');
    expect(service.hasTenantContext()).toBe(true);
  });

  it('loads the caller once per token, and again on request', async () => {
    api.accessToken = 'token-a';
    callers = [
      { subject: 'alice', tenantId: null, roles: ['tenants:manage'] },
      { subject: 'alice', tenantId: null, roles: [] },
    ];

    await Promise.all([service.loadCaller(), service.loadCaller()]);
    await service.loadCaller();
    expect(requests).toHaveLength(1);
    expect(service.getRoles()).toEqual(['tenants:manage']);

    await service.loadCaller({ reload: true });
    expect(requests).toHaveLength(2);
    expect(service.getRoles()).toEqual([]);
  });

  it('keeps the previous caller of the session when loading fails, and retries with the next call', async () => {
    api.accessToken = 'token-a';
    callers = [{ subject: 'shop', tenantId: 'acme', roles: ['issuance:offer'] }, 503];
    await service.loadCaller();

    api.accessToken = 'token-b';
    await service.loadCaller();
    expect(service.getRoles()).toEqual(['issuance:offer']);
    expect(snackBar.open).not.toHaveBeenCalled();

    callers = [{ subject: 'shop', tenantId: 'acme', roles: [] }];
    await service.loadCaller();
    expect(service.getRoles()).toEqual([]);
    expect(requests).toHaveLength(3);
  });

  it("forgets the caller when the session ends, so the next client never gets the previous client's roles", async () => {
    api.accessToken = 'token-a';
    callers = [{ subject: 'shop', tenantId: 'acme', roles: ['tenant:admin'] }, 503];
    await service.loadCaller();

    api.accessToken = '';
    api.sessionEnded$.next();
    api.accessToken = 'token-b';
    await service.loadCaller();

    expect(service.getCaller()).toBeUndefined();
    expect(service.getRoles()).toEqual([]);
    expect(service.getTenantId()).toBeNull();
  });

  it('keeps no stand-in caller when another client signs in without a logout', async () => {
    api.accessToken = 'token-a';
    callers = [{ subject: 'shop', tenantId: 'acme', roles: ['tenant:admin'] }, 503];
    await service.loadCaller();

    api.clientId = 'other';
    api.accessToken = 'token-b';
    expect(service.getCaller()).toBeUndefined();
    await service.loadCaller();

    expect(service.getRoles()).toEqual([]);
    expect(service.getTenantId()).toBeNull();
    expect(snackBar.open).toHaveBeenCalledOnce();
  });

  it('says why the roles are missing when the first caller cannot be loaded, until a retry opens the page', async () => {
    api.accessToken = 'token-a';
    callers = [503, { subject: 'shop', tenantId: 'acme', roles: ['issuance:offer'] }];

    await service.loadCaller({ url: '/issuance/offer' });

    expect(snackBar.open).toHaveBeenCalledOnce();
    expect(snackBar.open.mock.calls[0].slice(0, 2)).toEqual([
      'Could not load your roles: Service Unavailable.',
      'Retry',
    ]);
    expect(snackBar.open.mock.calls[0][2]).toMatchObject({ duration: 0 });

    retry.next();
    await vi.waitFor(() => expect(router.navigateByUrl).toHaveBeenCalledWith('/issuance/offer'));
    expect(service.getRoles()).toEqual(['issuance:offer']);
  });

  it('names a backend without the endpoint', async () => {
    api.accessToken = 'token-a';
    callers = [404];

    await service.loadCaller();

    expect(snackBar.open.mock.calls[0][0]).toBe(
      'Could not load your roles: the backend does not offer GET /api/auth/me. Run the Web Client with a backend of the same release.'
    );
  });

  it('stops waiting for the backend after 10 seconds', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    // Like fetch, which never settles here: it rejects with the reason of an aborted signal.
    client.setConfig({
      fetch: (request: RequestInfo | URL) =>
        new Promise<Response>((_, reject) => {
          const { signal } = request as Request;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    api.accessToken = 'token-a';

    const loading = service.loadCaller();
    deadline.abort(new DOMException('signal timed out', 'TimeoutError'));
    await loading;

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(snackBar.open.mock.calls[0][0]).toBe(
      'Could not load your roles: the backend did not answer within 10 seconds.'
    );
  });

  it('keeps the caller of the newer token when the answer for an older one arrives late', async () => {
    const pending: { path: string; release: () => void }[] = [];
    const answers: Record<string, Caller> = {
      'Bearer token-a': { subject: 'shop', tenantId: 'acme', roles: ['issuance:manage'] },
      'Bearer token-b': { subject: 'shop', tenantId: 'acme', roles: ['issuance:offer'] },
    };
    client.setConfig({
      auth: () => api.accessToken,
      fetch: (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          const auth = (request as Request).headers.get('Authorization') ?? '';
          pending.push({ path: auth, release: () => resolve(answer(answers[auth])) });
        }),
    });

    api.accessToken = 'token-a';
    const first = service.loadCaller();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    api.accessToken = 'token-b';
    const second = service.loadCaller();
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending[1].release();
    await second;
    pending[0].release();
    await first;

    expect(service.getRoles()).toEqual(['issuance:offer']);
    await service.loadCaller();
    expect(pending).toHaveLength(2);
    client.setConfig({ auth: undefined });
  });

  it('has no caller without an access token, for example after a logout', async () => {
    api.accessToken = 'token-a';
    callers = [{ subject: 'shop', tenantId: 'acme', roles: ['issuance:offer'] }];
    await service.loadCaller();

    api.accessToken = '';

    expect(service.getCaller()).toBeUndefined();
    expect(service.getRoles()).toEqual([]);
    expect(service.getTenantId()).toBeNull();
  });
});
