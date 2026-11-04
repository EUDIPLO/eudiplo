import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRefusalService, ApiService } from '../core';
import { respondWithCaller } from '../guards/role-guard.testing';
import { JwtService } from './jwt.service';
import { RoleChangeService } from './role-change.service';

interface RouteStub {
  data: { role?: string | string[] };
  firstChild: RouteStub | null;
}

/** A router state whose routes, from the root down, carry these `data.role` values. */
function routeWithRoles(...roles: (string | string[] | undefined)[]): RouteStub {
  const [first, ...rest] = roles;
  return {
    data: first ? { role: first } : {},
    firstChild: rest.length ? routeWithRoles(...rest) : null,
  };
}

describe('RoleChangeService', () => {
  let api: {
    accessToken: string;
    tokenRenewed$: Subject<void>;
    sessionEnded$: Subject<void>;
    getClientId: () => string;
  };
  /** The caller the backend returns from now on. */
  let caller: { subject: string; roles: string[] };
  let callerRequests: number;
  let tokens: number;
  let rolesRefused: Subject<void>;
  let router: {
    url: string;
    navigate: ReturnType<typeof vi.fn>;
    routerState: { snapshot: { root: RouteStub } };
  };
  let action: Subject<void>;
  /** The `afterDismissed` of each opened snack bar, in order. */
  let dismissals: Subject<{ dismissedByAction: boolean }>[];
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let service: RoleChangeService;

  const texts = () => snackBar.open.mock.calls.map((call) => call[0]);

  /** Signs in as `client` with `roles` and starts the service. */
  async function signIn(roles: string[], client = 'shop'): Promise<void> {
    api.accessToken = `token-${++tokens}`;
    caller = { subject: client, roles };
    await TestBed.inject(JwtService).loadCaller();
    service.start();
  }

  /** Lets the service's own caller request and comparison finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  /** A new token of `client` arrives, for example after a refresh. */
  async function renew(roles: string[], client = 'shop'): Promise<void> {
    api.accessToken = `token-${++tokens}`;
    caller = { subject: client, roles };
    api.tokenRenewed$.next();
    await settle();
  }

  beforeEach(() => {
    api = {
      accessToken: '',
      tokenRenewed$: new Subject<void>(),
      sessionEnded$: new Subject<void>(),
      // The client that signed in last, as its caller's subject.
      getClientId: () => caller.subject,
    };
    tokens = 0;
    callerRequests = 0;
    respondWithCaller(() => {
      callerRequests++;
      return caller;
    });
    rolesRefused = new Subject<void>();
    router = {
      url: '/dashboard',
      navigate: vi.fn(),
      routerState: { snapshot: { root: routeWithRoles() } },
    };
    action = new Subject<void>();
    dismissals = [];
    snackBar = {
      open: vi.fn(() => {
        const dismissed = new Subject<{ dismissedByAction: boolean }>();
        dismissals.push(dismissed);
        return { onAction: () => action, afterDismissed: () => dismissed };
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        {
          provide: ApiRefusalService,
          useValue: { rolesRefusedWithoutRenewal$: rolesRefused.asObservable() },
        },
        { provide: Router, useValue: router },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
    service = TestBed.inject(RoleChangeService);
  });

  afterEach(() => service.stop());

  it('names the lost roles while the page does not need them', async () => {
    router.routerState.snapshot.root = routeWithRoles(undefined, 'presentation:manage');
    await signIn(['presentation:manage', 'issuance:manage', 'clients:manage']);

    await renew(['presentation:manage']);

    expect(texts()).toEqual([
      'Your API client no longer has the roles issuance:manage, clients:manage; the pages that need them are hidden.',
    ]);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('offers to leave a page that needs a lost role, and leaves only on request', async () => {
    router.routerState.snapshot.root = routeWithRoles(undefined, 'issuance:manage');
    await signIn(['presentation:manage', 'issuance:manage']);

    await renew(['presentation:manage']);

    expect(texts()).toEqual([
      'Your API client no longer has the role issuance:manage, which this page needs. Copy unsaved changes before you leave it.',
    ]);
    expect(snackBar.open.mock.calls[0][1]).toBe('Leave page');
    expect(snackBar.open.mock.calls[0][2]).toMatchObject({ duration: 0 });
    expect(router.navigate).not.toHaveBeenCalled();

    action.next();
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });

  it('stays quiet on a page that needs any of several roles while one is left', async () => {
    router.routerState.snapshot.root = routeWithRoles(['issuance:manage', 'presentation:manage']);
    await signIn(['presentation:manage', 'issuance:manage']);

    await renew(['presentation:manage']);

    expect(snackBar.open.mock.calls[0][1]).toBe('OK');
  });

  it('compares each new token with the one before', async () => {
    await signIn(['presentation:manage', 'issuance:manage']);

    await renew(['presentation:manage', 'issuance:manage']);
    await renew(['presentation:manage']);
    await renew(['presentation:manage']);

    expect(snackBar.open).toHaveBeenCalledOnce();
  });

  it('says nothing for another client, on the login page, after logout or after stop', async () => {
    await signIn(['presentation:manage', 'issuance:manage']);

    await renew(['presentation:manage'], 'other');
    router.url = '/login';
    await renew([], 'other');
    router.url = '/dashboard';
    api.accessToken = '';
    api.sessionEnded$.next();
    await renew(['issuance:manage'], 'other');
    const requestsBeforeStop = callerRequests;
    service.stop();
    await renew([], 'other');

    expect(snackBar.open).not.toHaveBeenCalled();
    expect(callerRequests).toBe(requestsBeforeStop);
  });

  it('says nothing when the same client signs in again with fewer roles after a logout', async () => {
    await signIn(['presentation:manage', 'issuance:manage']);

    api.accessToken = '';
    api.sessionEnded$.next();
    await renew(['presentation:manage']);

    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('loads the caller of each renewed token itself', async () => {
    await signIn(['presentation:manage']);

    await renew(['presentation:manage']);
    await renew(['presentation:manage']);

    expect(callerRequests).toBe(3);
  });

  describe('without a secret to renew the token', () => {
    it('loads the roles again when the role check refuses a request, and names the lost one', async () => {
      router.routerState.snapshot.root = routeWithRoles(undefined, 'issuance:manage');
      await signIn(['presentation:manage', 'issuance:manage']);

      caller = { subject: 'shop', roles: ['presentation:manage'] };
      rolesRefused.next();
      await settle();

      expect(callerRequests).toBe(2);
      expect(texts()).toEqual([
        'Your API client no longer has the role issuance:manage, which this page needs. Copy unsaved changes before you leave it.',
      ]);
      expect(TestBed.inject(JwtService).hasRole('issuance:manage')).toBe(false);
    });

    it('names the lost role in a reloaded tab, whose caller the guards loaded after the start', async () => {
      router.routerState.snapshot.root = routeWithRoles(undefined, 'issuance:manage');
      api.accessToken = `token-${++tokens}`;
      caller = { subject: 'shop', roles: ['presentation:manage', 'issuance:manage'] };
      service.start();
      await TestBed.inject(JwtService).loadCaller();

      caller = { subject: 'shop', roles: ['presentation:manage'] };
      rolesRefused.next();
      await settle();

      expect(texts()).toEqual([
        'Your API client no longer has the role issuance:manage, which this page needs. Copy unsaved changes before you leave it.',
      ]);
    });

    it('brings the notice back when the page is refused again, as its own error may have replaced it', async () => {
      router.routerState.snapshot.root = routeWithRoles(undefined, 'issuance:manage');
      await signIn(['presentation:manage', 'issuance:manage']);
      caller = { subject: 'shop', roles: ['presentation:manage'] };

      rolesRefused.next();
      await settle();
      rolesRefused.next();
      await settle();

      expect(texts()).toEqual([
        'Your API client no longer has the role issuance:manage, which this page needs. Copy unsaved changes before you leave it.',
        'Your API client lacks a role this page needs. Copy unsaved changes before you leave it.',
      ]);
      expect(snackBar.open.mock.calls[1][1]).toBe('Leave page');
    });

    it('stays quiet when the roles did not change, as a new login would not change them', async () => {
      router.routerState.snapshot.root = routeWithRoles(undefined, 'issuance:manage');
      await signIn(['issuance:manage']);

      rolesRefused.next();
      await settle();

      expect(callerRequests).toBe(2);
      expect(snackBar.open).not.toHaveBeenCalled();
    });

    it('does not load the roles again on the login page or after stop', async () => {
      await signIn(['issuance:manage']);

      router.url = '/login';
      rolesRefused.next();
      router.url = '/dashboard';
      service.stop();
      rolesRefused.next();
      await settle();

      expect(callerRequests).toBe(1);
    });
  });
});
