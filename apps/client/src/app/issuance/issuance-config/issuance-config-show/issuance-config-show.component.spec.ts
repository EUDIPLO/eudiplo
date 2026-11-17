import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';

import { IssuanceConfigShowComponent } from './issuance-config-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { IssuanceConfigService } from '../issuance-config.service';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import { expectAvailable, expectUnavailable } from '../../../common/unavailable-action.testing';

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

  it('shows how a generated registration certificate is renewed', () => {
    const renewalFor = (renewal?: string) => {
      component.config = {
        registrationCertificate: { enabled: true, mode: 'generate', renewal },
      } as any;
      return component.registrationCertificateRenewalLabel;
    };
    expect(renewalFor()).toBe('When credential configs or issuer settings change');
    expect(renewalFor('onMetadataRequest')).toBe('On the next metadata request');
    expect(renewalFor('manual')).toBe('Only with Regenerate now');
  });

  it('treats a registration certificate without a mode as generated', () => {
    component.config = { registrationCertificate: { enabled: true } } as any;
    expect(component.registrationCertificateGenerated).toBe(true);
    component.config = { registrationCertificate: { enabled: true, mode: 'import' } } as any;
    expect(component.registrationCertificateGenerated).toBe(false);
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

describe('IssuanceConfigShowComponent registration certificate', () => {
  it('keeps Regenerate now focusable while it runs: a second click sends one request', async () => {
    const reissueRegistrationCertificate = vi.fn().mockReturnValue(new Promise(() => undefined));
    TestBed.configureTestingModule({
      imports: [IssuanceConfigShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: IssuanceConfigService,
          useValue: {
            getConfig: async () => ({
              registrationCertificate: { enabled: true, mode: 'generate' },
            }),
            reissueRegistrationCertificate,
          },
        },
        {
          provide: ConfigDocumentService,
          useValue: { canDownload: () => false, isDownloading: () => false },
        },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(IssuanceConfigShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Registration Certificate'))!
      .click();
    fixture.detectChanges();
    const regenerate = await vi.waitFor(() => {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Regenerate now')
      );
      expect(button).toBeDefined();
      return button!;
    });
    expectAvailable(fixture, regenerate);

    regenerate.click();
    fixture.detectChanges();
    regenerate.click();
    fixture.detectChanges();

    expect(reissueRegistrationCertificate).toHaveBeenCalledOnce();
    expectUnavailable(fixture, regenerate, 'Regenerating the registration certificate…');
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

  it('shows the imported certificate, not an earlier generated one, in import mode', () => {
    const { component } = create([]);
    const imported = jwt({ iat: 1_800_000_000, exp: 1_900_000_000 });
    component.config = {
      registrationCertificate: { enabled: true, mode: 'import', jwt: imported },
      registrationCertificateCache: { jwt: 'old.generated.jwt', expiresAt: 1 },
    } as never;

    expect(component.registrationCertificateJwt).toBe(imported);
    expect(component.registrationCertificateCache).toEqual({
      jwt: imported,
      issuedAt: 1_800_000_000,
      expiresAt: 1_900_000_000,
    });
  });

  it('says that generation and renewal stop before replacing a generated certificate', () => {
    const open = vi.fn();
    const { component } = create(['registrar:manage', 'issuance:manage'], open);
    component.config = { registrationCertificate: { enabled: true, mode: 'generate' } } as never;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    component.requestFromEudiHub();

    expect(confirm.mock.lastCall?.[0]).toContain('no longer generates or renews it');
    expect(open).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps an imported JWT that cannot be decoded without times', () => {
    const { component } = create([]);
    component.config = {
      registrationCertificate: { enabled: true, mode: 'import', jwt: 'x.y.z' },
    } as never;

    expect(component.registrationCertificateCache).toEqual({ jwt: 'x.y.z' });
  });

  it('asks before replacing an imported certificate', () => {
    const open = vi.fn();
    const { component } = create(['registrar:manage', 'issuance:manage'], open);
    component.config = { registrationCertificate: { enabled: true, mode: 'import' } } as never;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    component.requestFromEudiHub();

    expect(confirm.mock.lastCall?.[0]).toContain('replaces the imported issuer registration');
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
