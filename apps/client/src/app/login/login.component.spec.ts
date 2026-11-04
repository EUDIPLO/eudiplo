import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { OAuth2HttpError } from '@badgateway/oauth2-client';
import { Subject } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from 'vitest';

import { ApiService, type EndedSession } from '../core';
import { OidcService } from '../core/oidc.service';
import { expectAvailable, expectUnavailable } from '../common/unavailable-action.testing';
import { EnvironmentService } from '../services/environment.service';
import { LoginComponent } from './login.component';

describe('LoginComponent with a kept session', () => {
  const rejectedText =
    'The credentials of client-a were rejected, for example because the client was deleted or its secret changed. Log in again.';

  let api: {
    authenticated: boolean;
    kept: boolean;
    /** The session the service reports as expired or rejected, once. */
    ended?: EndedSession;
    tokenRenewed$: Subject<void>;
    sessionEnded$: Subject<void>;
    refreshAccessToken: Mock<() => Promise<void>>;
    loginWithClientCredentials: Mock<() => Promise<void>>;
    logout: Mock<() => void>;
    discovery: Record<string, string>;
    /** Answers discovery in place of `discovery`, for example never. */
    discoveryAnswer?: Promise<Record<string, string>>;
    /** Answers discovery for one instance URL, before `discoveryAnswer`. */
    discoveryAnswers?: Record<string, Promise<Record<string, string>>>;
    /** The instance URLs discovery was asked for, in order. */
    discoveryRequests: string[];
    /** The instance this browser last signed in to. */
    lastInstance?: string;
    rememberSignedInInstance: Mock<(url: string) => void>;
  };
  let queryParams: Record<string, string>;
  let snackBar: { open: Mock };
  let navigateByUrl: MockInstance<Router['navigateByUrl']>;
  /** The question before signing in at an instance the link chose; the user agrees unless a test says otherwise. */
  let confirm: Mock<(question: string) => boolean>;
  let fixture: ComponentFixture<LoginComponent>;

  const page = () => fixture.nativeElement as HTMLElement;
  const button = (label: string) =>
    [...page().querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  const input = (name: string) =>
    page().querySelector<HTMLInputElement>(`input[formcontrolname="${name}"]`);
  const snackTexts = () => snackBar.open.mock.calls.map((call) => call[0]);

  function render(): void {
    fixture = TestBed.createComponent(LoginComponent);
    fixture.detectChanges();
  }

  /** The real service forgets the credentials and emits sessionEnded$ when the token endpoint rejects them. */
  function rejectKeptCredentials(): void {
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'rejected' };
    api.sessionEnded$.next();
  }

  /** Signs in through the form as the given client, on the Client ID and Secret tab. */
  async function submitForm(clientId: string, apiUrl: string): Promise<void> {
    const component = fixture.componentInstance;
    component.selectedLoginMode = 'client';
    component.loginForm.setValue({ clientId, clientSecret: 'secret', apiUrl });
    await component.onSubmit();
  }

  beforeEach(() => {
    api = {
      authenticated: false,
      kept: true,
      tokenRenewed$: new Subject<void>(),
      sessionEnded$: new Subject<void>(),
      refreshAccessToken: vi.fn(() => Promise.resolve()),
      loginWithClientCredentials: vi.fn(() => Promise.resolve()),
      // Like the real service, logout forgets the credentials and says so.
      logout: vi.fn(() => api.sessionEnded$.next()),
      discovery: {},
      discoveryRequests: [],
      rememberSignedInInstance: vi.fn(),
    };
    queryParams = {};
    snackBar = { open: vi.fn() };
    confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideRouter([]),
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
        {
          provide: ApiService,
          useValue: {
            getAuthenticationStatus: () => api.authenticated,
            hasKeptSession: () => api.kept,
            takeEndedSession: () => {
              const session = api.ended;
              api.ended = undefined;
              return session;
            },
            getClientId: () => 'client-a',
            getBaseUrl: () => 'http://backend.test',
            tokenRenewed$: api.tokenRenewed$,
            sessionEnded$: api.sessionEnded$,
            refreshAccessToken: api.refreshAccessToken,
            loginWithClientCredentials: api.loginWithClientCredentials,
            logout: api.logout,
            lastSignedInInstance: () => api.lastInstance,
            rememberSignedInInstance: api.rememberSignedInInstance,
            fetchDiscovery: (url: string) => {
              api.discoveryRequests.push(url);
              return (
                api.discoveryAnswers?.[url] ?? api.discoveryAnswer ?? Promise.resolve(api.discovery)
              );
            },
          },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParams } } },
        {
          provide: EnvironmentService,
          useValue: {
            isDevelopment: () => false,
            getEnvironment: () => ({
              oidc: { clientId: '', clientSecret: '' },
              api: { baseUrl: '' },
            }),
          },
        },
        { provide: OidcService, useValue: {} },
      ],
    })
      // The component imports MatSnackBarModule, whose provider wins over a root provider.
      .overrideProvider(MatSnackBar, { useValue: snackBar });
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('waits for the kept session instead of asking for credentials', () => {
    render();

    expect(page().querySelector('output')?.textContent).toContain(
      'Resuming the session of client-a at http://backend.test'
    );
    expect(page().querySelector('form')).toBeNull();
  });

  it('renews the kept session at once, as nothing else may be due', () => {
    render();

    expect(api.refreshAccessToken).toHaveBeenCalledOnce();
  });

  it('shows the form when there is no kept session', () => {
    api.kept = false;
    render();

    expect(page().querySelector('form')).not.toBeNull();
    expect(page().querySelector('output')).toBeNull();
    expect(api.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('returns to the page the user came from once the session renews', () => {
    queryParams['returnUrl'] = '/issuance/offers?page=2';
    render();

    api.tokenRenewed$.next();

    expect(navigateByUrl).toHaveBeenCalledWith('/issuance/offers?page=2');
  });

  it.each(['https://evil.test/', '//evil.test/', '/login?returnUrl=/dashboard'])(
    'opens the dashboard instead of the return path %s',
    (returnUrl) => {
      queryParams['returnUrl'] = returnUrl;
      api.authenticated = true;
      render();

      expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
    }
  );

  it('shows the form, started from the kept session, when its credentials are rejected', async () => {
    render();

    rejectKeptCredentials();
    fixture.detectChanges();

    expect(page().querySelector('form')).not.toBeNull();
    expect(input('apiUrl')?.value).toBe('http://backend.test');
    // The client ID field sits on the second tab, which is not rendered yet.
    expect(fixture.componentInstance.loginForm.value.clientId).toBe('client-a');
    expect(snackTexts()).toEqual([rejectedText]);
    expect(navigateByUrl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(input('apiUrl')));
  });

  it('explains a rejection that happened before the page opened, starting from that session', () => {
    api.kept = false;
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'rejected' };
    render();

    expect(page().querySelector('form')).not.toBeNull();
    expect(snackTexts()).toEqual([rejectedText]);
    expect(input('apiUrl')?.value).toBe('http://backend.test');
    expect(fixture.componentInstance.loginForm.value.clientId).toBe('client-a');
  });

  it('says that the session expired, starting from that session', () => {
    api.kept = false;
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'expired' };
    render();

    expect(snackTexts()).toEqual(['The session of client-a expired. Log in again to continue.']);
    expect(snackBar.open.mock.calls[0][2]).toMatchObject({ panelClass: ['warning-snackbar'] });
    expect(input('apiUrl')?.value).toBe('http://backend.test');
    expect(fixture.componentInstance.loginForm.value.clientId).toBe('client-a');
    expect(fixture.componentInstance.loginForm.value.clientSecret).toBe('');
  });

  it('opens the client credentials tab with focus on the secret after an expiry, even where SSO is offered', async () => {
    api.kept = false;
    api.discovery = { issuer: 'http://backend.test', ui_client_id: 'ui' };
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'expired' };
    render();

    await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('oidc'));
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedLoginMode).toBe('client');
    expect(input('clientId')?.value).toBe('client-a');
    await vi.waitFor(() => expect(document.activeElement).toBe(input('clientSecret')));
  });

  it('keeps the SSO tab the user chose after an expiry when the instance is detected again', async () => {
    api.kept = false;
    api.discovery = { issuer: 'http://backend.test', ui_client_id: 'ui' };
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'expired' };
    render();
    const component = fixture.componentInstance;
    await vi.waitFor(() => expect(component.detectedMode).toBe('oidc'));

    component.onLoginTabChange(0);
    component.onApiUrlBlur();
    await vi.waitFor(() => expect(component.detectedMode).toBe('oidc'));

    expect(component.selectedLoginMode).toBe('sso');
  });

  it('opens the client credentials tab after a rejection where SSO is offered, without focusing the secret', async () => {
    api.kept = false;
    api.discovery = { issuer: 'http://backend.test', ui_client_id: 'ui' };
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'rejected' };
    render();

    await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('oidc'));
    fixture.detectChanges();
    await fixture.whenRenderingDone();

    expect(fixture.componentInstance.selectedLoginMode).toBe('client');
    expect(input('clientSecret')).not.toBeNull();
    expect(document.activeElement).not.toBe(input('clientSecret'));
  });

  it('opens the SSO tab after an expiry when the user moves to another instance that offers SSO', async () => {
    api.kept = false;
    api.discovery = { issuer: 'http://backend.test', ui_client_id: 'ui' };
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'expired' };
    render();
    const component = fixture.componentInstance;
    await vi.waitFor(() => expect(component.detectedMode).toBe('oidc'));
    expect(component.selectedLoginMode).toBe('client');

    component.loginForm.patchValue({ apiUrl: 'http://other.test' });
    component.detectedMode = null;
    component.onApiUrlBlur();
    await vi.waitFor(() => expect(component.detectedMode).toBe('oidc'));

    expect(component.selectedLoginMode).toBe('sso');
  });

  it('opens the SSO tab where SSO is offered when no session ended', async () => {
    api.kept = false;
    api.discovery = { issuer: 'http://backend.test', ui_client_id: 'ui' };
    queryParams['apiUrl'] = 'http://backend.test';
    render();

    await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('oidc'));
    expect(fixture.componentInstance.selectedLoginMode).toBe('sso');
  });

  it('returns to the page after an expiry only when the same client signs in again', async () => {
    api.kept = false;
    queryParams['returnUrl'] = '/settings/connection';
    api.ended = { clientId: 'client-a', baseUrl: 'http://backend.test', reason: 'expired' };
    render();

    await submitForm('client-a', 'http://backend.test');
    expect(navigateByUrl).toHaveBeenLastCalledWith('/settings/connection');

    await submitForm('client-a', 'http://other.test');
    expect(navigateByUrl).toHaveBeenLastCalledWith('/dashboard');
  });

  it('returns to the page after a rejection only when the same client signs in again', async () => {
    queryParams['returnUrl'] = '/settings/connection';
    render();
    rejectKeptCredentials();

    await submitForm('client-a', 'http://backend.test');
    expect(navigateByUrl).toHaveBeenLastCalledWith('/settings/connection');

    await submitForm('client-b', 'http://backend.test');
    expect(navigateByUrl).toHaveBeenLastCalledWith('/dashboard');
  });

  it('signs out of the kept session when the user wants other credentials', async () => {
    render();

    button('Sign out and use other credentials')?.click();
    fixture.detectChanges();

    expect(api.logout).toHaveBeenCalledOnce();
    expect(page().querySelector('form')).not.toBeNull();
    expect(snackTexts()).toEqual([]);
    await vi.waitFor(() => expect(document.activeElement).toBe(input('apiUrl')));
  });

  it('opens the dashboard after signing out of the kept session and signing in again', async () => {
    queryParams['returnUrl'] = '/settings/connection';
    render();
    button('Sign out and use other credentials')?.click();

    await submitForm('client-a', 'http://backend.test');

    expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });

  it('stays busy until the next page opens, as its guards wait for the roles', async () => {
    let opened: (value: boolean) => void = () => undefined;
    navigateByUrl.mockReturnValue(new Promise((resolve) => (opened = resolve)));
    render();
    button('Sign out and use other credentials')?.click();

    const submitted = submitForm('client-a', 'http://backend.test');
    await vi.waitFor(() => expect(navigateByUrl).toHaveBeenCalled());
    expect(fixture.componentInstance.isLoading).toBe(true);

    opened(true);
    await submitted;
    expect(fixture.componentInstance.isLoading).toBe(false);
  });

  it('does not report a failed navigation after a sign-in as a failed sign-in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    navigateByUrl.mockRejectedValue(new Error('Loading chunk failed'));
    render();
    button('Sign out and use other credentials')?.click();

    await submitForm('client-a', 'http://backend.test');

    expect(snackTexts()).toEqual(['Login successful!']);
    expect(fixture.componentInstance.isLoading).toBe(false);
  });

  it('stops waiting when the page is left', () => {
    render();

    fixture.destroy();
    api.tokenRenewed$.next();

    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('tries again on request and says when the backend still cannot be reached', async () => {
    let fail: (error: Error) => void = () => undefined;
    api.refreshAccessToken.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    render();

    button('Try again now')?.click();
    fixture.detectChanges();
    expect(button('Try again now')?.disabled).toBe(true);

    fail(new TypeError('Failed to fetch'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(button('Try again now')?.disabled).toBe(false);
    expect(snackTexts()).toEqual(['The backend still cannot be reached. This page keeps trying.']);
  });

  it('names the status when the token request fails with an HTTP error', async () => {
    render();
    api.refreshAccessToken.mockRejectedValue(
      new OAuth2HttpError('HTTP Error 503', null as never, new Response(null, { status: 503 }), {})
    );

    button('Try again now')?.click();
    await fixture.whenStable();

    expect(snackTexts()).toEqual([
      'The token request failed with status 503. This page keeps trying.',
    ]);
  });

  it('reports only the rejection when trying again ends the session', async () => {
    render();
    api.refreshAccessToken.mockImplementation(() => {
      rejectKeptCredentials();
      return Promise.reject(new Error('OAuth2 error Unauthorized.'));
    });

    button('Try again now')?.click();
    await fixture.whenStable();

    expect(snackTexts()).toEqual([rejectedText]);
  });

  it('signs in with credentials from the URL instead of waiting for the kept session', async () => {
    Object.assign(queryParams, {
      clientId: 'client-b',
      clientSecret: 'secret-b',
      apiUrl: 'http://other.test',
    });
    render();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(page().querySelector('output')).toBeNull();
    expect(api.loginWithClientCredentials).toHaveBeenCalledWith(
      'client-b',
      'secret-b',
      'http://other.test',
      undefined
    );
    expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });

  it('returns to the page from the link after signing in with the form', async () => {
    api.kept = false;
    queryParams['returnUrl'] = '/settings/connection';
    render();

    await submitForm('client-a', 'http://backend.test');

    expect(navigateByUrl).toHaveBeenCalledWith('/settings/connection');
  });

  describe('login button', () => {
    const loginButton = () => page().querySelector<HTMLButtonElement>('button[type="submit"]')!;

    beforeEach(() => {
      api.kept = false;
    });

    it('says on the SSO tab that the instance is missing and focuses it', async () => {
      render();
      const login = loginButton();
      expectAvailable(fixture, login);

      login.focus();
      login.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement).toBe(input('apiUrl'));
      });
      expect(snackTexts()).toEqual(['Check the highlighted fields.']);
      expect(page().querySelector('mat-error')?.textContent).toContain(
        'EUDIPLO Instance is required'
      );
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it('focuses the missing client ID on the Client ID and Secret tab', async () => {
      queryParams['apiUrl'] = 'http://backend.test';
      render();
      await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('local'));
      fixture.detectChanges();
      const login = loginButton();
      expectAvailable(fixture, login);

      login.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement).toBe(input('clientId'));
      });
      expect(snackTexts()).toEqual(['Check the highlighted fields.']);
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it('says while the instance is checked for SSO that the SSO login waits for it', async () => {
      queryParams['apiUrl'] = 'http://backend.test';
      api.discoveryAnswer = new Promise<Record<string, string>>(() => undefined);
      render();
      const login = loginButton();

      expectUnavailable(fixture, login, 'Checking whether this instance offers SSO…');
      login.click();
      await fixture.whenStable();

      expect(snackTexts()).toEqual([]);
    });

    it('checks an instance entered without leaving its field, then signs in with SSO', async () => {
      api.discovery = { issuer: 'http://idp.test', ui_client_id: 'ui' };
      const redirectToLogin = vi.fn(() => Promise.resolve());
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
      render();
      fixture.componentInstance.loginForm.patchValue({ apiUrl: 'http://backend.test' });
      fixture.detectChanges();
      expectAvailable(fixture, loginButton());

      // Enter in the instance field submits the form.
      await fixture.componentInstance.onSubmit();

      expect(redirectToLogin).toHaveBeenCalledWith({
        issuerUrl: 'http://idp.test',
        uiClientId: 'ui',
        apiUrl: 'http://backend.test',
      });
    });

    it('checks an instance entered without leaving its field and asks for its client', async () => {
      render();
      fixture.componentInstance.loginForm.patchValue({ apiUrl: 'http://backend.test' });

      await fixture.componentInstance.onSubmit();

      expect(fixture.componentInstance.selectedLoginMode).toBe('client');
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement).toBe(input('clientId'));
      });
      expect(snackTexts()).toEqual([
        'SSO is not available for this instance. Sign in with a client ID and secret.',
      ]);
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it('does not sign in with filled-in client credentials after a Login with SSO', async () => {
      render();
      fixture.componentInstance.loginForm.patchValue({
        apiUrl: 'http://backend.test',
        clientId: 'client-a',
        clientSecret: 'secret',
      });

      await fixture.componentInstance.onSubmit();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement).toBe(input('clientId'));
      });
      expect(snackTexts()).toEqual([
        'SSO is not available for this instance. Sign in with a client ID and secret.',
      ]);
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it('waits for the check that leaving the instance field started, then signs in once', async () => {
      let answer!: (discovery: Record<string, string>) => void;
      api.discoveryAnswer = new Promise((resolve) => (answer = resolve));
      const redirectToLogin = vi.fn(() => Promise.resolve());
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
      render();
      const component = fixture.componentInstance;
      component.loginForm.patchValue({ apiUrl: 'http://backend.test' });
      component.onApiUrlBlur();
      fixture.detectChanges();
      expectUnavailable(fixture, loginButton(), 'Checking whether this instance offers SSO…');

      const submitted = component.onSubmit();
      const again = component.onSubmit();
      answer({ issuer: 'http://idp.test', ui_client_id: 'ui' });
      await Promise.all([submitted, again]);

      expect(api.discoveryRequests).toEqual(['http://backend.test']);
      expect(redirectToLogin).toHaveBeenCalledOnce();
      expect(snackTexts()).toEqual([]);
    });

    /** A discovery answer the test gives when it chooses. */
    function laterAnswer() {
      let answer!: (discovery: Record<string, string>) => void;
      let fail!: (error: unknown) => void;
      const promise = new Promise<Record<string, string>>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
      return { promise, answer, fail };
    }

    it('ignores a late answer for the instance the field held before', async () => {
      const before = laterAnswer();
      const now = laterAnswer();
      api.discoveryAnswers = { 'http://old.test': before.promise, 'http://new.test': now.promise };
      const redirectToLogin = vi.fn(() => Promise.resolve());
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
      render();
      const component = fixture.componentInstance;
      component.loginForm.patchValue({ apiUrl: 'http://old.test' });
      component.onApiUrlBlur();
      component.loginForm.patchValue({ apiUrl: 'http://new.test' });

      const submitted = component.onSubmit();
      now.answer({});
      await vi.waitFor(() => expect(component.detectedMode).toBe('local'));
      before.answer({ issuer: 'http://idp.test', ui_client_id: 'ui' });
      await submitted;

      expect(component.detectedMode).toBe('local');
      expect(component.selectedLoginMode).toBe('client');
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('signs in with SSO at the instance the field holds when an earlier check fails late', async () => {
      const before = laterAnswer();
      const now = laterAnswer();
      api.discoveryAnswers = { 'http://old.test': before.promise, 'http://new.test': now.promise };
      const redirectToLogin = vi.fn(() => new Promise<void>(() => undefined));
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
      render();
      const component = fixture.componentInstance;
      component.loginForm.patchValue({ apiUrl: 'http://old.test' });
      component.onApiUrlBlur();
      component.loginForm.patchValue({ apiUrl: 'http://new.test' });

      void component.onSubmit();
      now.answer({ issuer: 'http://idp.test', ui_client_id: 'ui' });
      before.fail(new Error('offline'));
      await vi.waitFor(() => expect(redirectToLogin).toHaveBeenCalledOnce());
      fixture.detectChanges();

      expect(component.detectedMode).toBe('oidc');
      expect(redirectToLogin).toHaveBeenCalledWith({
        issuerUrl: 'http://idp.test',
        uiClientId: 'ui',
        apiUrl: 'http://new.test',
      });
      expectUnavailable(fixture, loginButton(), 'Redirecting to the identity provider…');
    });

    it('gives no reason while an instance URL that is not valid is checked', () => {
      api.discoveryAnswer = new Promise<Record<string, string>>(() => undefined);
      render();
      const component = fixture.componentInstance;
      component.loginForm.patchValue({ apiUrl: 'backend.test' });
      component.onApiUrlBlur();
      fixture.detectChanges();

      expect(component.detectedMode).toBe('loading');
      expectAvailable(fixture, loginButton());
    });

    it('checks an instance URL changed since its check before signing in with SSO', async () => {
      queryParams['apiUrl'] = 'http://sso.test';
      api.discovery = { issuer: 'http://idp.test', ui_client_id: 'ui' };
      const redirectToLogin = vi.fn(() => Promise.resolve());
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
      render();
      const component = fixture.componentInstance;
      await vi.waitFor(() => expect(component.detectedMode).toBe('oidc'));

      api.discovery = {};
      component.loginForm.patchValue({ apiUrl: 'http://plain.test/' });
      await component.onSubmit();

      expect(api.discoveryRequests).toEqual(['http://sso.test', 'http://plain.test']);
      expect(component.selectedLoginMode).toBe('client');
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('waits while it signs in: a second click signs in only once', async () => {
      queryParams['apiUrl'] = 'http://backend.test';
      api.loginWithClientCredentials.mockReturnValue(new Promise<void>(() => undefined));
      render();
      await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('local'));
      fixture.componentInstance.loginForm.patchValue({ clientId: 'client-a', clientSecret: 's' });
      fixture.detectChanges();
      const login = loginButton();

      login.click();
      fixture.detectChanges();
      login.click();
      fixture.detectChanges();

      expect(api.loginWithClientCredentials).toHaveBeenCalledOnce();
      expectUnavailable(fixture, login, 'Signing in…');
      expect(snackTexts()).toEqual([]);
    });
  });

  describe('an instance the link chose', () => {
    let redirectToLogin: Mock<() => Promise<void>>;

    beforeEach(() => {
      api.kept = false;
      redirectToLogin = vi.fn(() => Promise.resolve());
      Object.assign(TestBed.inject(OidcService), { redirectToLogin });
    });

    /** Opens the page from a link that chose `apiUrl`, which offers SSO. */
    async function openLink(apiUrl: string): Promise<void> {
      queryParams['apiUrl'] = apiUrl;
      api.discovery = { issuer: 'http://idp.test', ui_client_id: 'ui' };
      render();
      await vi.waitFor(() => expect(fixture.componentInstance.detectedMode).toBe('oidc'));
    }

    /** Builds the console as a development or production build with `baseUrl` in its environment. */
    function useBuild(development: boolean, baseUrl: string): void {
      Object.assign(TestBed.inject(EnvironmentService), {
        isDevelopment: () => development,
        getEnvironment: () => ({ oidc: { clientId: '', clientSecret: '' }, api: { baseUrl } }),
      });
    }

    it('asks before SSO sends the token to it, and says what to do when the user declines', async () => {
      confirm.mockReturnValue(false);
      await openLink('https://other.test/');

      await fixture.componentInstance.onSubmit();

      expect(confirm).toHaveBeenCalledWith(
        'The link you opened chose the EUDIPLO instance https://other.test. After you sign in, the console sends it your access token, which lets it act with your roles. Sign in only if you trust this instance.'
      );
      expect(redirectToLogin).not.toHaveBeenCalled();
      expect(fixture.componentInstance.isLoading).toBe(false);
      expect(snackTexts()).toEqual([
        'Not signed in at https://other.test. Enter the address of an EUDIPLO instance you trust.',
      ]);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement).toBe(input('apiUrl'));
      });
    });

    it('signs in with SSO after the user agrees', async () => {
      await openLink('https://other.test');

      await fixture.componentInstance.onSubmit();

      expect(confirm).toHaveBeenCalledOnce();
      expect(redirectToLogin).toHaveBeenCalledWith({
        issuerUrl: 'http://idp.test',
        uiClientId: 'ui',
        apiUrl: 'https://other.test',
      });
    });

    it('asks before sending a client secret to it', async () => {
      confirm.mockReturnValue(false);
      queryParams['apiUrl'] = 'https://other.test';
      render();

      await submitForm('client-a', 'https://other.test');

      expect(confirm.mock.calls[0][0]).toContain(
        'Signing in sends it the client secret you entered, which lets it act as this client.'
      );
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it('does not ask again when the user signs in again after agreeing', async () => {
      queryParams['apiUrl'] = 'https://other.test';
      api.refreshAccessToken.mockRejectedValueOnce(new Error('401'));
      render();

      await submitForm('client-a', 'https://other.test');
      expect(api.rememberSignedInInstance).not.toHaveBeenCalled();
      await submitForm('client-a', 'https://other.test');

      expect(confirm).toHaveBeenCalledOnce();
      expect(api.loginWithClientCredentials).toHaveBeenCalledTimes(2);
    });

    it('asks before a link signs in with its own credentials', async () => {
      confirm.mockReturnValue(false);
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://other.test',
      });
      render();
      await fixture.whenStable();

      expect(confirm).toHaveBeenCalledWith(
        'The link you opened chose the EUDIPLO instance https://other.test. It signs you in with the client the link names, and everything you do in the console goes to this instance. Sign in only if you trust this instance.'
      );
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it("drops the link's client when the user declines its instance", async () => {
      confirm.mockReturnValue(false);
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://other.test',
      });
      render();
      await fixture.whenStable();

      expect(fixture.componentInstance.loginForm.value).toEqual({
        apiUrl: 'https://other.test',
        clientId: '',
        clientSecret: '',
      });
      expect(snackTexts()).toEqual([
        'Not signed in at https://other.test. Enter the address of an EUDIPLO instance you trust.',
      ]);
    });

    it('keeps waiting for a kept session when the user declines the instance of a link', async () => {
      api.kept = true;
      confirm.mockReturnValue(false);
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://other.test',
      });
      render();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(page().querySelector('output')?.textContent).toContain(
        'Resuming the session of client-a'
      );
      expect(snackTexts()).toEqual([
        'Not signed in at https://other.test. The previous session continues.',
      ]);
      expect(api.loginWithClientCredentials).not.toHaveBeenCalled();
    });

    it("asks again before SSO after the user agreed to the link's own client", async () => {
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://other.test',
      });
      api.discovery = { issuer: 'http://idp.test', ui_client_id: 'ui' };
      api.refreshAccessToken.mockRejectedValueOnce(new Error('401'));
      render();
      await vi.waitFor(() => expect(fixture.componentInstance.selectedLoginMode).toBe('sso'));

      await fixture.componentInstance.onSubmit();

      expect(confirm.mock.calls.map(([question]) => question)).toEqual([
        expect.stringContaining('It signs you in with the client the link names'),
        expect.stringContaining('the console sends it your access token'),
      ]);
      expect(redirectToLogin).toHaveBeenCalledOnce();
    });

    it("does not remember an instance signed in to with the link's own client", async () => {
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://other.test',
      });
      render();
      await fixture.whenStable();

      expect(api.loginWithClientCredentials).toHaveBeenCalledOnce();
      expect(api.rememberSignedInInstance).not.toHaveBeenCalled();
    });

    it('remembers the instance it signed in to, so links to it do not ask', async () => {
      queryParams['apiUrl'] = 'https://other.test/';
      render();

      await submitForm('client-a', 'https://other.test/');

      expect(api.rememberSignedInInstance).toHaveBeenCalledWith('https://other.test');
    });

    it('does not ask for the instance this browser last signed in to', async () => {
      api.lastInstance = 'https://backend.test';
      Object.assign(queryParams, {
        clientId: 'client-b',
        clientSecret: 'secret-b',
        apiUrl: 'https://backend.test/',
      });
      render();
      await fixture.whenStable();

      expect(confirm).not.toHaveBeenCalled();
      expect(api.loginWithClientCredentials).toHaveBeenCalledWith(
        'client-b',
        'secret-b',
        'https://backend.test',
        undefined
      );
    });

    it('does not ask for the instance the deployment names', async () => {
      vi.stubGlobal('env', { apiUrl: 'https://backend.test/' });
      await openLink('https://backend.test');

      await fixture.componentInstance.onSubmit();

      expect(confirm).not.toHaveBeenCalled();
      expect(redirectToLogin).toHaveBeenCalledOnce();
    });

    it('does not ask in a development build for the instance of its environment', async () => {
      useBuild(true, 'http://localhost:3000');
      await openLink('http://localhost:3000');

      await fixture.componentInstance.onSubmit();

      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks in a production build for the placeholder of its environment', async () => {
      useBuild(false, 'https://your-api-prod.com');
      await openLink('https://your-api-prod.com');

      await fixture.componentInstance.onSubmit();

      expect(confirm).toHaveBeenCalledOnce();
    });

    it('does not ask for an instance the user entered instead', async () => {
      await openLink('https://other.test');
      fixture.componentInstance.loginForm.patchValue({ apiUrl: 'https://mine.test' });

      await fixture.componentInstance.onSubmit();

      expect(confirm).not.toHaveBeenCalled();
      expect(redirectToLogin).toHaveBeenCalledWith(
        expect.objectContaining({ apiUrl: 'https://mine.test' })
      );
    });
  });
});
