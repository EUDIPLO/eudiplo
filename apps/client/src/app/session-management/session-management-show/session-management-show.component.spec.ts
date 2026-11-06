import { HttpErrorResponse } from '@angular/common/http';
import { Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import type { Session } from '@eudiplo/sdk-core';
import { JwtService } from '../../services/jwt.service';
import { CredentialStatusCardComponent } from '../credential-status/credential-status-card.component';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionManagementShowComponent } from './session-management-show.component';
import { SessionManagementService } from '../session-management.service';
import { expectUnavailable, tooltipOf } from '../../common/unavailable-action.testing';

describe('SessionManagementShowComponent', () => {
  let component: SessionManagementShowComponent;
  let fixture: ComponentFixture<SessionManagementShowComponent>;
  let roles: string[];

  const issuance = {
    id: 'issuance-1',
    status: 'active',
    consumed: false,
    credentialPayload: { credentialConfigurationIds: ['pid'] },
  } as unknown as Session;
  const presentation = {
    id: 'presentation-1',
    status: 'active',
    consumed: false,
    requestId: 'age-check',
  } as unknown as Session;

  beforeEach(async () => {
    roles = [];
    await TestBed.configureTestingModule({
      imports: [SessionManagementShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionManagementShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => component.stopPolling());

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows sessions:read the credential status but no cancel, recreate or status change', () => {
    roles = ['sessions:read'];
    component.session = issuance;

    expect(component.canReadCredentialStatus()).toBe(true);
    expect(component.canChangeCredentialStatus()).toBe(false);
    expect(component.canCancel()).toBe(false);
    expect(component.canRecreateOffer()).toBe(false);
    expect(component.canSeeOffer()).toBe(false);
  });

  it('cancels and recreates only the sessions of the caller side', () => {
    roles = ['issuance:offer', 'sessions:read'];

    component.session = issuance;
    expect(component.canCancel()).toBe(true);
    expect(component.canRecreateOffer()).toBe(true);

    component.session = presentation;
    expect(component.canCancel()).toBe(false);
    expect(component.canRecreateOffer()).toBe(false);
    expect(component.canSeeOffer()).toBe(false);
    expect(component.canReadCredentialStatus()).toBe(false);
  });

  describe('Cancel Offer', () => {
    let cancelSession: ReturnType<typeof vi.spyOn>;
    let getSession: ReturnType<typeof vi.spyOn>;
    let openDialog: ReturnType<typeof vi.spyOn>;

    function renderCancel(): HTMLButtonElement {
      roles = ['issuance:offer'];
      component.session = {
        ...issuance,
        createdAt: '2026-10-11T10:00:00.000Z',
        updatedAt: '2026-10-11T10:00:00.000Z',
        notifications: [],
      } as unknown as Session;
      fixture.detectChanges();
      return [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent?.includes('Cancel Offer'))!;
    }

    beforeEach(() => {
      const sessions = TestBed.inject(SessionManagementService);
      cancelSession = vi.spyOn(sessions, 'cancelSession');
      getSession = vi.spyOn(sessions, 'getSession');
      vi.spyOn(sessions, 'getSessionLogs').mockResolvedValue([] as never);
      vi.spyOn(sessions, 'getCredentialStatus').mockResolvedValue([]);
      openDialog = vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({
        afterClosed: () => of({ reason: 'sent to the wrong person' }),
      } as never);
    });

    afterEach(() => vi.restoreAllMocks());

    it('stays focusable while the offer is cancelled: a second click sends one request', async () => {
      cancelSession.mockReturnValue(new Promise(() => undefined));
      const cancel = renderCancel();
      expect(tooltipOf(fixture, cancel)).toBe(
        'Cancel this offer, so a wallet can no longer use it'
      );

      cancel.click();
      fixture.detectChanges();
      cancel.click();
      fixture.detectChanges();

      expect(openDialog).toHaveBeenCalledOnce();
      expect(cancelSession).toHaveBeenCalledOnce();
      expectUnavailable(fixture, cancel, 'Cancelling this offer…');
    });

    it('says the same for Cancel Request on a presentation session', async () => {
      cancelSession.mockReturnValue(new Promise(() => undefined));
      roles = ['presentation:request'];
      component.session = {
        ...presentation,
        createdAt: '2026-10-11T10:00:00.000Z',
        updatedAt: '2026-10-11T10:00:00.000Z',
      } as unknown as Session;
      fixture.detectChanges();
      const cancel = [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent?.includes('Cancel Request'))!;
      expect(tooltipOf(fixture, cancel)).toBe(
        'Cancel this request, so a wallet can no longer answer it'
      );

      cancel.click();
      fixture.detectChanges();

      expect(cancelSession).toHaveBeenCalledOnce();
      expectUnavailable(fixture, cancel, 'Cancelling this request…');
    });

    it('moves the focus to the heading once the cancelled offer no longer offers Cancel', async () => {
      cancelSession.mockResolvedValue(undefined);
      getSession.mockResolvedValue({ ...component.session, status: 'cancelled' } as never);
      const cancel = renderCancel();
      cancel.focus();

      cancel.click();
      await vi.waitFor(() => expect(component.cancelling).toBe(false));
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).not.toContain('Cancel Offer');
      await vi.waitFor(() =>
        expect(document.activeElement?.textContent?.trim()).toBe('Issuance Session')
      );
    });
  });

  it('counts the manage roles toward a side, like the backend', () => {
    roles = ['presentation:request', 'issuance:manage'];
    component.session = issuance;
    expect(component.canSeeOffer()).toBe(true);
    expect(component.canCancel()).toBe(true);
    // Recreating opens the offer page, which needs issuance:offer.
    expect(component.canRecreateOffer()).toBe(false);

    // issuance:manage counts only together with a role that cancels sessions.
    roles = ['sessions:read', 'issuance:manage'];
    expect(component.canSeeOffer()).toBe(false);
    expect(component.canCancel()).toBe(false);
  });

  it.each([
    [['issuance:manage'], true],
    [['issuance:offer'], false],
  ])('passes %j on to the credential status card as canChange: %s', (granted, allowed) => {
    roles = granted;
    component.session = {
      ...issuance,
      status: 'completed',
      createdAt: '2026-10-11T10:00:00.000Z',
      updatedAt: '2026-10-11T10:00:00.000Z',
      notifications: [],
    } as unknown as Session;
    fixture.detectChanges();

    const card = fixture.debugElement.query(By.directive(CredentialStatusCardComponent));
    expect(card.componentInstance.canChange).toBe(allowed);
  });

  it('shows why a presentation failed, with its failure code, instead of the request link', () => {
    roles = ['presentation:request'];
    component.session = {
      ...presentation,
      status: 'failed',
      requestUrl: 'openid4vp://?request_uri=x',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      errorReason: 'Wallet error: invalid_request: MissingRequiredRegistrationCertificate',
      failureCode: 'invalid_request',
      outcome: {
        result: 'failed',
        source: 'wallet',
        error: 'invalid_request',
        message: 'Wallet error: invalid_request: MissingRequiredRegistrationCertificate',
        description: 'MissingRequiredRegistrationCertificate',
      },
    } as unknown as Session;
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.result-card');
    expect(card.classList).toContain('result-error');
    expect(card.querySelector('.result-title')?.textContent).toContain(
      'The wallet rejected the request'
    );
    expect(card.querySelector('.result-message')?.textContent?.trim()).toBe(
      'The wallet says: MissingRequiredRegistrationCertificate'
    );
    expect(card.querySelector('.result-hint')).not.toBeNull();
    expect(card.querySelector('.result-code code')?.textContent).toBe('invalid_request');
    expect(fixture.nativeElement.querySelector('.qr-card')).toBeNull();
  });

  it('shows the reason the operator gave for a cancelled request', () => {
    component.session = {
      ...presentation,
      status: 'cancelled',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      cancelReason: 'Sent to the wrong person',
    } as unknown as Session;
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.result-card');
    const messages = [...card.querySelectorAll('.result-message')].map((item) =>
      item.textContent?.trim()
    );
    expect(messages).toEqual([
      'It was cancelled before a wallet answered the request.',
      'Reason: Sent to the wrong person',
    ]);
  });

  it('lists the result of each credential and links to sessions with the same failure', () => {
    component.session = {
      ...presentation,
      status: 'failed',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      failureCode: 'signature_invalid',
      outcome: {
        result: 'failed',
        error: 'signature_invalid',
        message: 'A credential could not be verified',
        credentials: [
          { id: 'pid', format: 'dc+sd-jwt', verified: true, trust: { matchedIssuer: 'PID CA' } },
          { id: 'mdl', verified: false, error: 'signature_invalid', message: 'Bad signature' },
        ],
      },
    } as unknown as Session;
    fixture.detectChanges();

    const rows: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.result-credential')
    );
    expect(rows.map((row) => row.classList.contains('verified'))).toEqual([true, false]);
    expect(rows[1].textContent).toContain('Bad signature');
    expect(rows[1].textContent).toContain('signature_invalid');
    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('.result-code-link');
    expect(link.getAttribute('href')).toContain('status=failed&failureCode=signature_invalid');
  });

  it.each([
    ['active', true],
    ['failed', false],
  ])('shows the role hint for a %s session without the offer role: %s', (status, shown) => {
    roles = ['sessions:read'];
    component.session = {
      ...presentation,
      status,
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
    } as unknown as Session;
    fixture.detectChanges();

    expect(!!fixture.nativeElement.querySelector('.role-hint')).toBe(shown);
  });

  it('shows the QR code of a pending request to its side, and nothing of a result', async () => {
    roles = ['presentation:request'];
    component.session = {
      ...presentation,
      requestUrl: 'openid4vp://?request_uri=x',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
    } as unknown as Session;
    await component.generateQRCode('openid4vp://?request_uri=x');
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.qr-card');
    expect(card.querySelector('img.qr-image')).not.toBeNull();
    expect(card.textContent).toContain('openid4vp://?request_uri=x');
    expect(fixture.nativeElement.querySelector('.result-card')).toBeNull();
  });

  it('shows the claims of a completed presentation with the trusted issuer', () => {
    roles = ['sessions:read'];
    component.session = {
      ...presentation,
      status: 'completed',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      credentials: [
        {
          id: 'membership',
          values: [{ vct: 'urn:example:membership', name: 'Max', cnf: { jwk: {} } }],
        },
      ],
      outcome: {
        result: 'success',
        source: 'verifier',
        credentials: [{ id: 'membership', verified: true, trust: { matchedIssuer: 'Club CA' } }],
      },
    } as unknown as Session;
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.presented-card');
    expect(card.querySelector('.presented-title')?.textContent).toContain('urn:example:membership');
    expect(card.querySelector('.presented-meta')?.textContent).toContain('Trusted issuer: Club CA');
    const rows = Array.from(card.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent?.trim())
    );
    expect(rows).toEqual([['name', 'Max']]);
    // A verified presentation lists no per-credential failures.
    expect(fixture.nativeElement.querySelector('.result-credentials')).toBeNull();
  });

  it('labels an OpenID4VP mdoc with the docType from the outcome', () => {
    component.session = {
      ...presentation,
      status: 'completed',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      credentials: [{ id: 'mdl', values: [{ 'org.iso.18013.5.1': { age_over_18: true } }] }],
      outcome: {
        result: 'success',
        source: 'verifier',
        credentials: [{ id: 'mdl', verified: true, docType: 'org.iso.18013.5.1.mDL' }],
      },
    } as unknown as Session;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.presented-type')?.textContent).toContain(
      'org.iso.18013.5.1.mDL'
    );
  });

  it('shows the warnings of a verified presentation', () => {
    component.session = {
      ...presentation,
      status: 'completed',
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
      outcome: {
        result: 'success',
        source: 'verifier',
        credentials: [
          {
            id: 'pid',
            format: 'dc+sd-jwt',
            verified: true,
            warnings: [{ code: 'status_stale', message: 'Stale status list' }],
          },
        ],
      },
    } as unknown as Session;
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelector('.result-credential');
    expect(row.textContent).toContain('dc+sd-jwt');
    expect(row.querySelector('.result-warning')?.textContent).toContain('Stale status list');
  });

  it.each([[['issuance:offer']], [['sessions:read']]])(
    'tells %j that a fetched issuance was issued and waits for the confirmation',
    (granted) => {
      roles = granted;
      component.session = {
        ...issuance,
        status: 'fetched',
        createdAt: '2026-10-16T07:04:22.000Z',
        updatedAt: '2026-10-16T07:04:29.000Z',
        notifications: [],
      } as unknown as Session;
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.waiting-card').textContent).toContain(
        'The credentials were issued. Waiting for the wallet to confirm them.'
      );
      expect(fixture.nativeElement.querySelector('.qr-card')).toBeNull();
      expect(fixture.nativeElement.querySelector('.role-hint')).toBeNull();
      expect(fixture.nativeElement.querySelector('.result-card')).toBeNull();
    }
  );

  it('lists each credential configuration of an issuance with its own copy button', () => {
    component.session = {
      ...issuance,
      credentialPayload: { credentialConfigurationIds: ['pid', 'mdl'] },
      createdAt: '2026-10-16T07:04:22.000Z',
      updatedAt: '2026-10-16T07:04:29.000Z',
      notifications: [],
    } as unknown as Session;
    fixture.detectChanges();

    const labels = Array.from(fixture.nativeElement.querySelectorAll('[aria-label]'))
      .map((el) => (el as HTMLElement).getAttribute('aria-label'))
      .filter((label) => label?.startsWith('Copy configuration ID'));
    expect(labels).toEqual(['Copy configuration ID pid', 'Copy configuration ID mdl']);
  });

  it.each([
    [['issuance:offer'], false],
    [['issuance:manage'], true],
    [['credentials:status', 'sessions:read'], true],
  ])('lets %j change credential status: %s', (granted, allowed) => {
    roles = granted;
    component.session = issuance;

    expect(component.canReadCredentialStatus()).toBe(true);
    expect(component.canChangeCredentialStatus()).toBe(allowed);
  });
});

describe('SessionManagementShowComponent errors', () => {
  const base64url = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const requestObject = `${base64url({ alg: 'ES256' })}.${base64url({
    response_uri: 'http://localhost/response',
  })}.signature`;

  let sessionService: {
    cancelSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
  };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let httpClient: { post: ReturnType<typeof vi.fn> };
  let credentialsGet: ReturnType<typeof vi.fn>;

  function create(session: Partial<Session>): SessionManagementShowComponent {
    const component = new SessionManagementShowComponent(
      sessionService as never,
      { snapshot: { params: { id: 'session' } } } as never,
      snackBar as never,
      { navigate: vi.fn() } as never,
      httpClient as never,
      { getConfig: () => Promise.resolve(), isEnabled: () => false } as never,
      { open: () => ({ afterClosed: () => of({ reason: 'test' }) }) } as never,
      // The caller may change the session, so cancel and the offer are offered.
      { hasRole: () => true } as never,
      TestBed.inject(Injector)
    );
    component.session = { id: 'session', status: 'active', ...session } as Session;
    return component;
  }

  beforeEach(() => {
    sessionService = {
      cancelSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'session', status: 'active' }),
    };
    snackBar = { open: vi.fn() };
    httpClient = { post: vi.fn() };
    credentialsGet = vi.fn();
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: credentialsGet },
    });
    vi.stubGlobal('DigitalCredential', class {});
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'credentials');
    vi.unstubAllGlobals();
  });

  it.each([
    ['active', true],
    ['failed', false],
  ])('starts polling when an %s session opens: %s', async (status, polling) => {
    sessionService.getSession.mockResolvedValue({ id: 'session', status });
    const component = create({});

    await component.ngOnInit();

    expect(component.isPolling()).toBe(polling);
    component.stopPolling();
  });

  it('stops polling a finished session even when its status did not change', async () => {
    sessionService.getSession.mockResolvedValue({ id: 'session', status: 'failed' });
    const component = create({ status: 'failed' });
    component.startPolling('session');

    await component.fetchSessionStatus('session');

    expect(component.isPolling()).toBe(false);
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it("shows the backend's reason when cancelling fails for another reason than a conflict", async () => {
    sessionService.cancelSession.mockRejectedValue({
      statusCode: 404,
      message: 'Session not found',
    });

    create({}).cancelSession();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'The session could not be cancelled: Session not found',
        'Close',
        expect.anything()
      )
    );
  });

  it('keeps the conflict text for a 409 and names the failure when the error says nothing', async () => {
    sessionService.cancelSession
      .mockRejectedValueOnce({ statusCode: 409, message: 'Session is not pending' })
      .mockRejectedValueOnce({});

    create({}).cancelSession();
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'The session could not be cancelled, it is no longer pending',
        'Close',
        expect.anything()
      )
    );
    create({}).cancelSession();
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'The session could not be cancelled',
        'Close',
        expect.anything()
      )
    );
  });

  it('does not take an error of the Digital Credentials API for a network failure', async () => {
    credentialsGet.mockRejectedValue(new TypeError('Malformed request'));

    await create({ requestObject }).getDcApiCall();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('DC API error: Malformed request');
    expect(sessionService.getSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      { statusCode: 400, timestamp: '2026-10-11T12:00:00.000Z', path: '/presentations/s/oid4vp' },
      'The verifier rejected the presentation; the session result shows why.',
    ],
    [
      {
        redirect_uri:
          'https://rp.example/done?error=invalid_request&error_description=Credential%20revoked',
      },
      'The verifier rejected the presentation: Credential revoked',
    ],
  ])(
    'says the verifier rejected the response with body %j and reloads the session',
    async (body, text) => {
      credentialsGet.mockResolvedValue({
        protocol: 'openid4vp-v1-signed',
        data: { response: 'x' },
      });
      httpClient.post.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 400, error: body }))
      );

      await create({ requestObject }).getDcApiCall();

      expect(snackBar.open).toHaveBeenCalledWith(text, 'Close', expect.anything());
      expect(sessionService.getSession).toHaveBeenCalledWith('session');
    }
  );

  it("shows the verifier's reason when it rejects the wallet's response", async () => {
    credentialsGet.mockResolvedValue({ protocol: 'openid4vp-v1-signed', data: { response: 'x' } });
    httpClient.post.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { statusCode: 400, message: 'Invalid presentation' },
          })
      )
    );

    await create({ requestObject }).getDcApiCall();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('DC API error: Invalid presentation');
  });

  it("keeps the wallet's own error", async () => {
    credentialsGet.mockResolvedValue({
      data: { error: 'access_denied', error_description: 'User declined' },
    });

    await create({ requestObject }).getDcApiCall();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('DC API error: access_denied: User declined');
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});
