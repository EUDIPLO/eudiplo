import { afterEach, describe, expect, it, vi } from 'vitest';
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
      { downloadWithFeedback } as never
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
    new IssuanceConfigShowComponent({} as never, { open } as never, {} as never);

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
