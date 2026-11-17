import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { PresentationShowComponent } from './presentation-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { PresentationManagementService } from '../presentation-management.service';
import { expectAvailable, expectUnavailable } from '../../../common/unavailable-action.testing';

describe('PresentationShowComponent', () => {
  let component: PresentationShowComponent;
  let fixture: ComponentFixture<PresentationShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(PresentationShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('PresentationShowComponent loading', () => {
  it('says why the configuration could not be loaded instead of a blank page, and retries', async () => {
    const getPresentationById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found' })
      .mockResolvedValueOnce({ id: 'age-check' });
    const component = new PresentationShowComponent(
      { getPresentationById } as never,
      { snapshot: { paramMap: { get: () => 'age-check' } } } as never,
      { open: vi.fn() } as never,
      { navigate: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await component.loadPresentation();
    expect(component.loadError).toBe('Failed to load presentation configuration: Not found');

    await component.loadPresentation();
    expect(component.loadError).toBe('');
    expect(component.config?.id).toBe('age-check');
  });
});

describe('PresentationShowComponent download', () => {
  it('downloads the configuration document', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const component = new PresentationShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { downloadWithFeedback } as never,
      {} as never,
      {} as never
    );
    component.config = { id: 'age-check' } as never;

    await component.downloadConfig();

    expect(downloadWithFeedback).toHaveBeenCalledWith('PresentationConfig', 'age-check');
  });

  it('disables the button while the document is being downloaded', async () => {
    const button = await renderDownloadButton(PresentationShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'age-check' }) } },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            getPresentationById: async () => ({ id: 'age-check', dcql_query: { credentials: [] } }),
          },
        },
      ],
      loaded: (component) => !!component.config,
      downloading: ['PresentationConfig', 'age-check'],
    });

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another resource is being downloaded', async () => {
    const button = await renderDownloadButton(PresentationShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'age-check' }) } },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            getPresentationById: async () => ({ id: 'age-check', dcql_query: { credentials: [] } }),
          },
        },
      ],
      loaded: (component) => !!component.config,
      downloading: ['PresentationConfig', 'other'],
    });

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('PresentationShowComponent allowed origins', () => {
  async function render(allowedOrigins: string[] | null): Promise<string> {
    TestBed.configureTestingModule({
      imports: [PresentationShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'age-check' }) } },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            getPresentationById: async () => ({
              id: 'age-check',
              dcql_query: { credentials: [] },
              allowedOrigins,
            }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(PresentationShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    fixture.detectChanges();
    const items = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('mat-list-item')
    ) as HTMLElement[];
    const item = items.find((element) =>
      element.textContent?.includes('Allowed origins (Digital Credentials API)')
    );
    return item?.textContent ?? '';
  }

  it('lists the allowed origins', async () => {
    const text = await render(['https://shop.example', 'https://app.example']);
    expect(text).toContain('https://shop.example, https://app.example');
  });

  it('says the origins are not restricted without a list', async () => {
    expect(await render(null)).toContain('Not restricted');
  });
});

describe('PresentationShowComponent registration certificate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps Reissue now focusable while it runs: a second click sends one request', async () => {
    const reissueRequest = vi.fn().mockReturnValue(new Promise(() => undefined));
    TestBed.configureTestingModule({
      imports: [PresentationShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'age-check' }) } },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            getPresentationById: async () => ({
              id: 'age-check',
              dcql_query: { credentials: [] },
              registration_cert: { jwt: 'ey.registration.cert' },
            }),
            reissueRegistrationCertificate: reissueRequest,
          },
        },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(PresentationShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Security'))!
      .click();
    fixture.detectChanges();
    const reissue = await vi.waitFor(() => {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Reissue now')
      );
      expect(button).toBeDefined();
      return button!;
    });
    expectAvailable(fixture, reissue);

    reissue.click();
    fixture.detectChanges();
    reissue.click();
    fixture.detectChanges();

    expect(reissueRequest).toHaveBeenCalledExactlyOnceWith('age-check');
    expectUnavailable(fixture, reissue, 'Reissuing the registration certificate…');
  });
});

describe('PresentationShowComponent EUDI Hub', () => {
  function create(roles: string[], open = vi.fn()) {
    const getPresentationById = vi.fn().mockResolvedValue({ id: 'age-check' });
    const snackBar = { open: vi.fn() };
    const component = new PresentationShowComponent(
      { getPresentationById } as never,
      { snapshot: { paramMap: { get: () => 'age-check' } } } as never,
      snackBar as never,
      {} as never,
      {} as never,
      { open } as never,
      { hasRole: (role: string) => roles.includes(role) } as never
    );
    return { component, getPresentationById, snackBar, open };
  }

  it('offers the request only with registrar:manage and presentation:manage', () => {
    expect(
      create(['registrar:manage', 'presentation:manage']).component.canRequestFromEudiHub
    ).toBe(true);
    expect(create(['registrar:manage']).component.canRequestFromEudiHub).toBe(false);
    expect(create(['presentation:manage']).component.canRequestFromEudiHub).toBe(false);
  });

  it('opens the dialog for the configuration with its English purpose and reloads it', async () => {
    const open = vi.fn().mockReturnValue({
      afterClosed: () => of({ id: 'rc-1', environment: 'sandbox' }),
    });
    const { component, getPresentationById, snackBar } = create(
      ['registrar:manage', 'presentation:manage'],
      open
    );
    component.config = {
      id: 'age-check',
      description: 'Age check',
      registration_cert: {
        body: {
          purpose: [
            { lang: 'de', content: 'Alter' },
            { lang: 'en', content: 'Age' },
          ],
        },
      },
    } as never;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.requestFromEudiHub();

    expect(confirm.mock.lastCall?.[0]).toContain(
      'takes precedence over the current registration certificate settings'
    );
    confirm.mockRestore();
    expect(open.mock.lastCall?.[1]).toMatchObject({
      disableClose: true,
      data: {
        kind: 'presentation',
        presentationConfigId: 'age-check',
        defaultName: 'Age check',
        purposeEn: 'Age',
      },
    });
    await vi.waitFor(() => expect(getPresentationById).toHaveBeenCalledWith('age-check'));
    expect(snackBar.open.mock.lastCall?.[0]).toContain('EUDI Hub (sandbox)');
  });

  it('does not open the dialog when replacing the certificate is declined', () => {
    const open = vi.fn();
    const { component } = create(['registrar:manage', 'presentation:manage'], open);
    component.config = { id: 'age-check', registration_cert: { jwt: 'a.b.c' } } as never;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    component.requestFromEudiHub();

    expect(open).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows an imported certificate as active before it was cached, not as pending', () => {
    const { component } = create([]);
    const part = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const jwt = `${part({ alg: 'ES256' })}.${part({ iat: 1, exp })}.c2ln`;
    component.config = { id: 'age-check', registration_cert: { jwt } } as never;

    expect(component.registrationCertStatus).toBe('active');
    expect(component.registrationCertSource).toBe('imported');
    expect(component.registrationCertCache?.expiresAt).toBe(exp);
  });
});
