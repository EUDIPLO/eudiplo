import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { IssuanceConfigShowComponent } from './issuance-config-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { IssuanceConfigService } from '../issuance-config.service';

describe('IssuanceConfigShowComponent', () => {
  let component: IssuanceConfigShowComponent;
  let fixture: ComponentFixture<IssuanceConfigShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IssuanceConfigShowComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(IssuanceConfigShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the effective default token lifetime per authorization server type', () => {
    component.config = {
      authorizationServers: [
        { type: 'built-in', id: 'issuer-built-in' },
        { type: 'chained', id: 'chained' },
        { type: 'oid4vp', id: 'vp', token: { lifetimeSeconds: 900 } },
      ],
    } as any;
    expect(component.authorizationServerRows.map((row) => row.tokenLifetime)).toEqual([
      300, 3600, 900,
    ]);
  });

  it('shows the status check mode that applies per authorization server', () => {
    component.config = {
      walletAttestationStatusCheckMode: 'strict',
      authorizationServers: [
        { type: 'built-in', id: 'issuer-built-in' },
        { type: 'chained', id: 'chained', walletAttestationStatusCheckMode: 'disabled' },
        { type: 'external', id: 'ext', issuer: 'https://as.example' },
      ],
    } as any;
    expect(component.authorizationServerRows.map((row) => row.statusCheck)).toEqual([
      'Issuer default: Strict',
      'Disabled',
      '-',
    ]);
  });
});

describe('IssuanceConfigShowComponent page', () => {
  async function render(getConfig: ReturnType<typeof vi.fn>) {
    await TestBed.configureTestingModule({
      imports: [IssuanceConfigShowComponent],
      providers: [provideRouter([]), { provide: IssuanceConfigService, useValue: { getConfig } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(IssuanceConfigShowComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the settings under an h1 with Edit and the guided setup', async () => {
    const fixture = await render(
      vi.fn().mockResolvedValue({ display: [{ name: 'Example Issuer', locale: 'en' }] })
    );
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    expect(page.querySelector('h1')?.textContent?.trim()).toBe('Issuer Settings');
    expect(page.querySelector('.hero-meta')?.textContent).toContain('Example Issuer');
    expect(page.querySelector('.hero-meta')?.textContent).toContain('0 authorization servers');
    const actions = [...page.querySelectorAll('.hero-actions a, .hero-actions button')].map(
      (action) => action.textContent?.trim()
    );
    expect(actions).toEqual(
      expect.arrayContaining(['edit Edit', 'Use guided setup', 'Create a credential config'])
    );
  });

  it('shows a spinner while loading and the reason with Retry when loading fails', async () => {
    let fail: (error: unknown) => void = () => undefined;
    const fixture = await render(
      vi.fn(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          })
      )
    );
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('mat-spinner')?.getAttribute('aria-label')).toBe(
      'Loading issuer settings'
    );

    fail({ statusCode: 403, message: 'Forbidden resource' });
    await vi.waitFor(() => expect(fixture.componentInstance.loadError).not.toBe(''));
    fixture.detectChanges();
    expect(page.querySelector('app-load-error')?.textContent).toContain('Forbidden resource');
    expect(page.querySelector('mat-spinner')).toBeNull();
  });
});

describe('IssuanceConfigShowComponent loading', () => {
  it('says why the issuer settings could not be loaded instead of a blank page', async () => {
    const component = new IssuanceConfigShowComponent(
      {
        getConfig: vi.fn().mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' }),
      } as never,
      { open: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never
    );

    component.loadConfig();

    await vi.waitFor(() =>
      expect(component.loadError).toBe('Failed to load issuer settings: Forbidden resource')
    );
  });
});

describe('IssuanceConfigShowComponent download', () => {
  it('downloads the configuration document', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const component = new IssuanceConfigShowComponent(
      {} as never,
      {} as never,
      { downloadWithFeedback } as never,
      {} as never,
      {} as never
    );
    component.config = {} as never;

    await component.downloadConfig();

    expect(downloadWithFeedback).toHaveBeenCalledWith('IssuanceConfig', 'issuance');
  });

  it('disables the button while the document is being downloaded', async () => {
    const button = await renderDownloadButton(IssuanceConfigShowComponent, {
      providers: [{ provide: IssuanceConfigService, useValue: { getConfig: async () => ({}) } }],
      loaded: (component) => !!component.config,
      downloading: ['IssuanceConfig', 'issuance'],
    });

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another resource is being downloaded', async () => {
    const button = await renderDownloadButton(IssuanceConfigShowComponent, {
      providers: [{ provide: IssuanceConfigService, useValue: { getConfig: async () => ({}) } }],
      loaded: (component) => !!component.config,
      downloading: ['IssuanceConfig', 'other'],
    });

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('IssuanceConfigShowComponent copy', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  const create = (open: ReturnType<typeof vi.fn>) =>
    new IssuanceConfigShowComponent(
      {} as never,
      { open } as never,
      {} as never,
      {} as never,
      {} as never
    );

  it('confirms the copied registration certificate JWT', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.fn();

    await create(open).copyRegistrationCertificateJwt('ey.jwt');

    expect(writeText).toHaveBeenCalledWith('ey.jwt');
    expect(open).toHaveBeenCalledWith(
      'Registration certificate JWT copied to clipboard',
      'Close',
      expect.anything()
    );
  });

  it('says how to copy the JWT by hand when nothing was copied', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const open = vi.fn();

    await create(open).copyRegistrationCertificateJwt('ey.jwt');

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'Could not copy the registration certificate JWT. Select it below and copy it by hand.',
      'Close',
      expect.objectContaining({ duration: expect.any(Number) })
    );
  });
});

describe('IssuanceConfigShowComponent EUDI Hub', () => {
  /** An unsigned JWT with this payload. */
  const jwt = (payload: Record<string, unknown>) =>
    `${btoa(JSON.stringify({ alg: 'ES256' }))}.${btoa(JSON.stringify(payload))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')}.c2ln`;

  function create(roles: string[], open = vi.fn()) {
    const getConfig = vi.fn().mockResolvedValue({});
    const component = new IssuanceConfigShowComponent(
      { getConfig } as never,
      { open: vi.fn() } as never,
      {} as never,
      { open } as never,
      { hasRole: (role: string) => roles.includes(role) } as never
    );
    return { component, getConfig, open };
  }

  it('offers the request only with registrar:manage and issuance:manage', () => {
    expect(create(['registrar:manage', 'issuance:manage']).component.canRequestFromEudiHub).toBe(
      true
    );
    expect(create(['issuance:manage']).component.canRequestFromEudiHub).toBe(false);
  });

  it('opens the issuer dialog and reloads the settings after it closes', async () => {
    const open = vi.fn().mockReturnValue({ afterClosed: () => of(undefined) });
    const { component, getConfig } = create(['registrar:manage', 'issuance:manage'], open);

    component.requestFromEudiHub();

    expect(open.mock.lastCall?.[1]).toMatchObject({
      disableClose: true,
      data: { kind: 'issuer' },
    });
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalled());
  });

  it('shows the stored certificate with its issue and expiry times', () => {
    const { component } = create([]);
    const imported = jwt({ iat: 1_800_000_000, exp: 1_900_000_000 });
    component.config = {
      registrationCertificate: { enabled: true, jwt: imported },
    } as never;

    expect(component.registrationCertificateJwt).toBe(imported);
    expect(component.registrationCertificateCache).toEqual({
      jwt: imported,
      issuedAt: 1_800_000_000,
      expiresAt: 1_900_000_000,
    });
    expect(component.registrationCertificateStatus).toBe('active');
  });

  it('says what the issuer certificate status means and what to do next', () => {
    const { component } = create([]);
    component.config = { registrationCertificate: { enabled: true } } as never;
    expect(component.registrationCertificateStatusText).toBe(
      'No certificate — request one from the EUDI Hub or paste a JWT'
    );
    component.config = { registrationCertificate: { enabled: true, jwt: 'x.y.z' } } as never;
    expect(component.registrationCertificateStatus).toBe('invalid');
    expect(component.registrationCertificateStatusText).toContain('Not a valid JWT');
    component.config = {
      registrationCertificate: { enabled: true, jwt: jwt({ exp: 1 }) },
    } as never;
    expect(component.registrationCertificateStatusText).toBe(
      'Expired — request a new one or remove it'
    );
    component.config = { registrationCertificate: { enabled: false } } as never;
    expect(component.registrationCertificateStatusText).toBe('Turned off');
  });

  it('opens the Registration Certificate tab for #registration-certificate', () => {
    const component = new IssuanceConfigShowComponent(
      { getConfig: vi.fn().mockResolvedValue({}) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { snapshot: { fragment: 'registration-certificate' } } as never
    );
    component.ngOnInit();
    expect(component.selectedTab).toBe(IssuanceConfigShowComponent.REGISTRATION_CERTIFICATE_TAB);
  });

  it('colours the certificate status badge by how usable the certificate is', () => {
    const { component } = create([]);
    component.config = { registrationCertificate: { enabled: false } } as never;
    expect(component.registrationCertificateBadgeClass).toBe('');
    component.config = {
      registrationCertificate: { enabled: true, jwt: jwt({ exp: 4_000_000_000 }) },
    } as never;
    expect(component.registrationCertificateBadgeClass).toBe('status-active');
    component.config = {
      registrationCertificate: { enabled: true, jwt: jwt({ nbf: 4_000_000_000 }) },
    } as never;
    expect(component.registrationCertificateBadgeClass).toBe('status-warning');
    component.config = { registrationCertificate: { enabled: true } } as never;
    expect(component.registrationCertificateBadgeClass).toBe('status-danger');
  });

  it.each([
    ['expiring', { exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 }, 'status-warning'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }, 'status-danger'],
  ])('colours an %s certificate status badge', (status, payload, badge) => {
    const { component } = create([]);
    component.config = {
      registrationCertificate: { enabled: true, jwt: jwt(payload) },
    } as never;

    expect(component.registrationCertificateStatus).toBe(status);
    expect(component.registrationCertificateBadgeClass).toBe(badge);
  });

  it('colours an undecodable certificate as invalid', () => {
    const { component } = create([]);
    component.config = {
      registrationCertificate: { enabled: true, jwt: 'not-a-jwt' },
    } as never;

    expect(component.registrationCertificateStatus).toBe('invalid');
    expect(component.registrationCertificateBadgeClass).toBe('status-danger');
  });

  it('reports an enabled registration certificate without JWT as missing', () => {
    const { component } = create([]);
    component.config = { registrationCertificate: { enabled: true } } as never;

    expect(component.registrationCertificateStatus).toBe('missing');
  });

  it('keeps an imported JWT that cannot be decoded without times', () => {
    const { component } = create([]);
    component.config = {
      registrationCertificate: { enabled: true, jwt: 'x.y.z' },
    } as never;

    expect(component.registrationCertificateCache).toEqual({ jwt: 'x.y.z' });
  });

  it('asks before replacing a stored certificate', () => {
    const open = vi.fn();
    const { component } = create(['registrar:manage', 'issuance:manage'], open);
    component.config = { registrationCertificate: { enabled: true, jwt: 'x.y.z' } } as never;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    component.requestFromEudiHub();

    expect(confirm.mock.lastCall?.[0]).toContain('replaces the issuer registration certificate');
    confirm.mockRestore();
  });

  it('opens the dialog without asking when no registration certificate is enabled', () => {
    const open = vi.fn().mockReturnValue({ afterClosed: () => of(undefined) });
    const { component } = create(['registrar:manage', 'issuance:manage'], open);
    component.config = { registrationCertificate: { enabled: false } } as never;
    const confirm = vi.spyOn(window, 'confirm');

    component.requestFromEudiHub();

    expect(confirm).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalled();
    confirm.mockRestore();
  });
});
