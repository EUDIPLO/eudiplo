import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import { ApiRefusalService, ApiService } from '../core';
import { TokenExpiryService } from './token-expiry.service';

const revokedText =
  'Your API client no longer has access, for example because it was deleted or its secret changed. Log in with a client that has access; unsaved changes on this page will be lost.';

describe('TokenExpiryService', () => {
  let api: {
    accessToken: string;
    getAuthenticationStatus: () => boolean;
    getTokenTimeRemaining: () => number;
    canRefreshToken: () => boolean;
    isReconnecting: () => boolean;
    areCredentialsRejected: () => boolean;
    ensureAuthenticated: ReturnType<typeof vi.fn>;
    tokenRenewed$: Subject<void>;
    logout: ReturnType<typeof vi.fn>;
    logoutExpired: ReturnType<typeof vi.fn>;
    hasEndedSession: () => boolean;
    usesSso: () => boolean;
  };
  let refusals: { isAccessRevoked: () => boolean; accessRevoked$: Subject<void> };
  let router: { url: string; navigate: ReturnType<typeof vi.fn>; events: Subject<unknown> };
  let notices: {
    action: Subject<void>;
    dismissed: Subject<{ dismissedByAction: boolean } | void>;
    dismiss: () => void;
  }[];
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let service: TokenExpiryService;

  const texts = () => snackBar.open.mock.calls.map((call) => call[0]);

  beforeEach(() => {
    api = {
      accessToken: 'token-1',
      getAuthenticationStatus: () => true,
      getTokenTimeRemaining: () => 60 * 60_000,
      canRefreshToken: () => false,
      isReconnecting: () => false,
      areCredentialsRejected: () => false,
      ensureAuthenticated: vi.fn().mockResolvedValue(false),
      tokenRenewed$: new Subject<void>(),
      logout: vi.fn(),
      logoutExpired: vi.fn(),
      hasEndedSession: () => false,
      usesSso: () => false,
    };
    refusals = { isAccessRevoked: () => false, accessRevoked$: new Subject<void>() };
    router = { url: '/dashboard', navigate: vi.fn(), events: new Subject<unknown>() };
    notices = [];
    snackBar = {
      open: vi.fn(() => {
        const notice = {
          action: new Subject<void>(),
          dismissed: new Subject<{ dismissedByAction: boolean } | void>(),
          dismiss: () => notice.dismissed.next(),
        };
        notices.push(notice);
        return {
          onAction: () => notice.action,
          afterDismissed: () => notice.dismissed,
          dismiss: () => notice.dismiss(),
        };
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ApiRefusalService, useValue: refusals },
        { provide: Router, useValue: router },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
    service = TestBed.inject(TokenExpiryService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('warns once per token before a token without refresh expires', async () => {
    api.getTokenTimeRemaining = () => 4 * 60_000;

    await service.check();
    await service.check();
    api.accessToken = 'token-2';
    api.getTokenTimeRemaining = () => 90_000;
    await service.check();

    expect(texts()).toEqual([
      'Your session expires in 4 minutes. Save your work.',
      'Your session expires in 1 minute. Save your work.',
    ]);
  });

  it('checks every 30 seconds once started, and no longer after stop', async () => {
    vi.useFakeTimers();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snackBar.open).not.toHaveBeenCalled();

    api.getTokenTimeRemaining = () => 4 * 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(snackBar.open).toHaveBeenCalledOnce();

    service.stop();
    api.accessToken = 'token-2';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snackBar.open).toHaveBeenCalledOnce();
  });

  it('stays quiet while the token can be refreshed or is far from expiry', async () => {
    await service.check();
    api.getTokenTimeRemaining = () => 60_000;
    api.canRefreshToken = () => true;
    await service.check();

    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('renews a refreshable session instead of calling it expired', async () => {
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.ensureAuthenticated.mockResolvedValue(true);

    await service.check();

    expect(api.ensureAuthenticated).toHaveBeenCalledOnce();
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('offers to log in again once the session cannot be renewed', async () => {
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;

    await service.check();
    await service.check();
    notices[0].action.next();

    expect(texts()).toEqual([
      'Your session has expired. Log in again; unsaved changes on this page will be lost.',
    ]);
    expect(api.logoutExpired).toHaveBeenCalledOnce();
    expect(api.logout).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: undefined });
  });

  it('returns to the page after logging in again as the client of the expired session', async () => {
    router.url = '/issuance/config?tab=claims';
    api.getAuthenticationStatus = () => false;
    api.logoutExpired.mockImplementation(() => (api.hasEndedSession = () => true));

    await service.check();
    notices[0].action.next();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/issuance/config?tab=claims' },
    });
  });

  it('returns to the page after signing in again with SSO when the SSO session expired', async () => {
    router.url = '/issuance/config?tab=claims';
    api.getAuthenticationStatus = () => false;
    api.usesSso = () => true;

    await service.check();
    notices[0].action.next();

    expect(api.logoutExpired).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/issuance/config?tab=claims' },
    });
  });

  it('reports an unreachable backend without a logout while the kept session reconnects', async () => {
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.isReconnecting = () => true;

    await service.check();
    await service.check();
    const dismiss = vi.spyOn(notices[0], 'dismiss');
    api.ensureAuthenticated.mockResolvedValue(true);
    await service.check();

    expect(texts()).toEqual([
      'The backend cannot be reached. Your session resumes once it is back; stay on this page to keep unsaved changes.',
    ]);
    expect(snackBar.open.mock.calls[0][1]).toBeUndefined();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('switches to the expired notice when the credentials are rejected while reconnecting', async () => {
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.isReconnecting = () => true;
    await service.check();

    // A rejection drops the secret but keeps the token, which stays usable until it expires.
    api.isReconnecting = () => false;
    api.canRefreshToken = () => false;
    await service.check();

    expect(texts()).toEqual([
      'The backend cannot be reached. Your session resumes once it is back; stay on this page to keep unsaved changes.',
      'Your session has expired. Log in again; unsaved changes on this page will be lost.',
    ]);
  });

  it('closes the unreachable notice as soon as the session resumes', async () => {
    vi.useFakeTimers();
    let valid = false;
    api.getAuthenticationStatus = () => valid;
    api.canRefreshToken = () => true;
    api.isReconnecting = () => true;
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    const dismiss = vi.spyOn(notices[0], 'dismiss');

    valid = true;
    api.tokenRenewed$.next();
    await vi.advanceTimersByTimeAsync(0);

    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('closes the unreachable notice when the user goes to the login page', async () => {
    vi.useFakeTimers();
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.isReconnecting = () => true;
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    const dismiss = vi.spyOn(notices[0], 'dismiss');

    router.url = '/login';
    router.events.next(new NavigationEnd(1, '/login', '/login'));
    await vi.advanceTimersByTimeAsync(0);

    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('does not open a notice on the login page the user reached while renewing', async () => {
    let renew: (value: boolean) => void = () => undefined;
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.isReconnecting = () => true;
    api.ensureAuthenticated.mockReturnValue(new Promise<boolean>((resolve) => (renew = resolve)));

    const pending = service.check();
    router.url = '/login';
    renew(false);
    await pending;

    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('shows the expired notice again when another message replaced it', async () => {
    api.getAuthenticationStatus = () => false;

    await service.check();
    notices[0].dismissed.next();
    await service.check();

    expect(snackBar.open).toHaveBeenCalledTimes(2);
  });

  it('closes the expired notice once the session is valid again', async () => {
    let valid = false;
    api.getAuthenticationStatus = () => valid;
    await service.check();
    const dismiss = vi.spyOn(notices[0], 'dismiss');

    valid = true;
    await service.check();

    expect(snackBar.open).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('says nothing on the login page or without a token', async () => {
    api.getAuthenticationStatus = () => false;
    router.url = '/login';
    await service.check();
    router.url = '/dashboard';
    api.accessToken = '';
    await service.check();

    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('closes the expired notice on the login page', async () => {
    api.getAuthenticationStatus = () => false;
    await service.check();
    const dismiss = vi.spyOn(notices[0], 'dismiss');

    router.url = '/login';
    await service.check();

    expect(dismiss).toHaveBeenCalledOnce();
    expect(snackBar.open).toHaveBeenCalledOnce();
  });

  it('runs one check at a time', async () => {
    let renew: (value: boolean) => void = () => undefined;
    api.getAuthenticationStatus = () => false;
    api.canRefreshToken = () => true;
    api.ensureAuthenticated.mockReturnValue(new Promise<boolean>((resolve) => (renew = resolve)));

    const first = service.check();
    const second = service.check();
    renew(true);
    await Promise.all([first, second]);

    expect(api.ensureAuthenticated).toHaveBeenCalledOnce();
  });

  it('ends a session whose client lost its access at once, although its token is valid', async () => {
    service.start();
    // Let the first check finish.
    await new Promise((resolve) => setTimeout(resolve));
    expect(snackBar.open).not.toHaveBeenCalled();

    refusals.isAccessRevoked = () => true;
    refusals.accessRevoked$.next();
    await vi.waitFor(() => expect(texts()).toEqual([revokedText]));
    notices[0].action.next();

    expect(api.logout).toHaveBeenCalledOnce();
    expect(api.logoutExpired).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: undefined });
  });

  it('returns to the page after the revoked notice when the rejected client signs in again', async () => {
    router.url = '/issuance/offers';
    refusals.isAccessRevoked = () => true;
    // The token endpoint rejected the credentials before, so logout keeps the rejected session.
    api.hasEndedSession = () => true;

    await service.check();
    notices[0].action.next();

    expect(api.logout).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/issuance/offers' },
    });
  });

  it('does not bring the revoked notice back after its Log in action', async () => {
    refusals.isAccessRevoked = () => true;
    await service.check();

    notices[0].action.next();
    notices[0].dismissed.next({ dismissedByAction: true });
    await new Promise((resolve) => setTimeout(resolve));

    expect(texts()).toEqual([revokedText]);
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it('keeps the revoked notice through later checks', async () => {
    refusals.isAccessRevoked = () => true;
    await service.check();
    const dismiss = vi.spyOn(notices[0], 'dismiss');

    await service.check();

    expect(dismiss).not.toHaveBeenCalled();
    expect(texts()).toEqual([revokedText]);
  });

  it('brings the revoked notice back at once when another message replaced it', async () => {
    refusals.isAccessRevoked = () => true;
    await service.check();

    notices[0].dismissed.next();

    await vi.waitFor(() => expect(texts()).toEqual([revokedText, revokedText]));
  });

  it('names lost access instead of expiry when the credentials were rejected', async () => {
    api.getAuthenticationStatus = () => false;
    api.areCredentialsRejected = () => true;

    await service.check();

    expect(texts()).toEqual([revokedText]);
  });

  it('reports an ended OIDC session whose token was cleared', async () => {
    await service.check();
    api.accessToken = '';
    api.getAuthenticationStatus = () => false;

    await service.check();

    expect(texts()).toEqual([
      'Your session has expired. Log in again; unsaved changes on this page will be lost.',
    ]);
  });
});
