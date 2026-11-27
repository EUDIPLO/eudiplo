import { ApplicationRef, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { PresentationShowComponent } from './presentation-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { PresentationManagementService } from '../presentation-management.service';
import { JwtService } from '../../../services/jwt.service';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';

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

describe('PresentationShowComponent issuer trust', () => {
  const untrusted = { id: 'pid', format: 'dc+sd-jwt', meta: { vct_values: ['urn:x'] } };

  async function render(config: Record<string, unknown>): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [PresentationShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(PresentationShowComponent);
    fixture.componentInstance.config = { lifeTime: 300, ...config } as never;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('warns that the issuer is not validated, with the cookbook link, while untrusted issuers are accepted', async () => {
    const element = await render({
      id: 'open',
      allowUntrustedIssuers: true,
      dcql_query: { credentials: [untrusted] },
    });
    expect(element.textContent).toContain('Untrusted issuers accepted');
    const warning = element.querySelector('.untrusted-warning');
    expect(warning?.textContent).toContain("The issuer's authority is not validated.");
    expect(warning?.querySelector('a')?.getAttribute('href')).toBe(
      'https://docs.eudiplo.dev/cookbooks/trusted-issuers'
    );
    expect(element.textContent).toContain('Accepted from any issuer (issuer not validated)');
  });

  it('says every presentation is refused when a query has no issuer trust and the config does not opt in', async () => {
    const element = await render({
      id: 'stale',
      dcql_query: {
        credentials: [
          untrusted,
          { ...untrusted, id: 'mdl', trusted_authorities: [{ type: 'etsi_tl', values: [] }] },
        ],
      },
    });
    expect(element.textContent).not.toContain('Untrusted issuers accepted');
    const refused = element.querySelector('.untrusted-warning.refused');
    expect(refused?.textContent).toContain('Every presentation against this config is refused.');
    expect(refused?.textContent).toContain('pid, mdl have');
  });

  it('shows no warning when every query has issuer trust', async () => {
    const element = await render({
      id: 'trusted',
      dcql_query: {
        credentials: [
          {
            ...untrusted,
            trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'l' }] }],
          },
        ],
      },
    });
    expect(element.querySelector('.untrusted-warning')).toBeNull();
    expect(element.textContent).toContain('Refused');
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
      {} as never,
      TestBed.inject(Injector)
    );

    await component.loadPresentation();
    expect(component.loadError).toBe('Failed to load verification config: Not found');

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
      (fixture.nativeElement as HTMLElement).querySelectorAll('.details > div')
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

  it('shows the kept purpose and privacy policy and offers no reissue', async () => {
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
              registration_cert: {
                purpose: [{ lang: 'en', content: 'Checks that you are of age' }],
                privacy_policy: 'https://verifier.example/privacy',
              },
            }),
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

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Checks that you are of age');
    });
    expect(element.textContent).toContain('https://verifier.example/privacy');
    expect(element.textContent).toContain('No certificate');
    expect(
      [...element.querySelectorAll('button')].some((b) => b.textContent?.includes('Reissue'))
    ).toBe(false);
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
      { hasRole: (role: string) => roles.includes(role) } as never,
      {} as never
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

  it('opens the dialog with the kept purpose and privacy policy and reloads the configuration', async () => {
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
        jwt: 'a.b.c',
        purpose: [
          { lang: 'de', content: 'Alter' },
          { lang: 'en', content: 'Age' },
        ],
        privacy_policy: 'https://verifier.example/privacy',
      },
    } as never;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.requestFromEudiHub();

    expect(confirm.mock.lastCall?.[0]).toContain(
      'replaces the registration certificate of this verification config'
    );
    confirm.mockRestore();
    expect(open.mock.lastCall?.[1]).toMatchObject({
      disableClose: true,
      data: {
        kind: 'presentation',
        presentationConfigId: 'age-check',
        defaultName: 'Age check',
        purpose: [
          { lang: 'de', content: 'Alter' },
          { lang: 'en', content: 'Age' },
        ],
        privacyPolicy: 'https://verifier.example/privacy',
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

  it('shows the stored certificate as active with its expiry', () => {
    const { component } = create([]);
    const part = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const jwt = `${part({ alg: 'ES256' })}.${part({ iat: 1, exp })}.c2ln`;
    component.config = { id: 'age-check', registration_cert: { jwt } } as never;

    expect(component.registrationCertStatus).toBe('active');
    expect(component.registrationCertTimes?.expiresAt).toBe(exp);
  });

  it('opens the dialog without asking when the configuration holds no certificate', () => {
    const open = vi.fn().mockReturnValue({ afterClosed: () => of(undefined) });
    const { component } = create(['registrar:manage', 'presentation:manage'], open);
    component.config = {
      id: 'age-check',
      registration_cert: { purpose: [{ lang: 'en', content: 'Age' }] },
    } as never;
    const confirm = vi.spyOn(window, 'confirm');

    component.requestFromEudiHub();

    expect(confirm).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalled();
    expect(component.registrationCertStatus).toBe('missing');
    confirm.mockRestore();
  });
});

describe('PresentationShowComponent page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function render(
    getPresentationById: () => Promise<unknown>,
    {
      roles = ['presentation:manage'],
      deleteConfiguration = vi.fn(async () => undefined),
    }: { roles?: string[]; deleteConfiguration?: () => Promise<unknown> } = {}
  ) {
    const navigate = vi.fn(async () => true);
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
          useValue: { getPresentationById, deleteConfiguration },
        },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string) => roles.includes(role),
            canUseConfigPortability: () => false,
          },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(PresentationShowComponent);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
    fixture.detectChanges();
    return { fixture, page: fixture.nativeElement as HTMLElement, navigate };
  }

  it('shows the back link while the configuration loads', async () => {
    const { page } = await render(() => new Promise(() => undefined));

    const back = page.querySelector('a.back-link');
    expect(back?.getAttribute('aria-label')).toBe('Back to Verification Configs');
    expect(page.querySelector('mat-spinner')).not.toBeNull();
  });

  it('names the configuration in the header with its credentials and description', async () => {
    const { fixture, page } = await render(async () => ({
      id: 'age-check',
      description: 'Checks the age',
      dcql_query: { credentials: [{ id: 'pid' }] },
    }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('.hero h1')?.textContent?.trim()).toBe('age-check');
    });

    expect(page.querySelector('.hero-description')?.textContent).toContain('Checks the age');
    expect(
      [...page.querySelectorAll('.hero-meta .badge')].map((b) => b.textContent?.trim())
    ).toContain('1 credential');
  });

  it('deletes once after confirmation and returns to the list', async () => {
    let finish!: () => void;
    const deleteConfiguration = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { fixture, page, navigate } = await render(
      async () => ({ id: 'age-check', dcql_query: { credentials: [] } }),
      { deleteConfiguration }
    );
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    fixture.detectChanges();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const deleting = fixture.componentInstance.deletePresentation();
    fixture.detectChanges();
    expect(page.querySelector('button.delete-action')?.getAttribute('aria-disabled')).toBe('true');
    await fixture.componentInstance.deletePresentation();
    expect(deleteConfiguration).toHaveBeenCalledTimes(1);

    finish();
    await deleting;
    expect(navigate).toHaveBeenCalledWith(['../'], expect.anything());
    expect(fixture.componentInstance.deleting).toBe(false);
  });

  it('stays on the page and says why when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, navigate } = await render(
      async () => ({ id: 'age-check', dcql_query: { credentials: [] } }),
      { deleteConfiguration: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }) }
    );
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const snackBar = TestBed.inject(MatSnackBar) as unknown as { open: ReturnType<typeof vi.fn> };

    await fixture.componentInstance.deletePresentation();

    expect(navigate).not.toHaveBeenCalled();
    expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Failed to delete verification config: x');
    expect(fixture.componentInstance.deleting).toBe(false);
  });

  it('shows the registration certificate state in the header', async () => {
    const { fixture, page } = await render(async () => ({
      id: 'age-check',
      dcql_query: { credentials: [] },
      registration_cert: { purpose: [{ lang: 'en', content: 'Age' }] },
    }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('.hero')).not.toBeNull();
    });

    expect(
      [...page.querySelectorAll('.hero-meta .badge')].map((b) => b.textContent?.trim())
    ).toContain('Registration certificate: No certificate');
  });

  it('moves focus to the heading after a retry loads the configuration', async () => {
    const getPresentationById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 500, message: 'Unavailable' })
      .mockResolvedValue({ id: 'age-check', dcql_query: { credentials: [] } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, page } = await render(getPresentationById);
    const retry = await vi.waitFor(() => {
      fixture.detectChanges();
      const button = [...page.querySelectorAll<HTMLButtonElement>('app-load-error button')].find(
        (b) => b.textContent?.includes('Retry')
      );
      expect(button).toBeDefined();
      return button!;
    });
    expect(document.activeElement).not.toBe(page.querySelector('h1'));

    retry.focus();
    retry.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
      expect(page.querySelector('app-load-error')).toBeNull();
      expect(document.activeElement).toBe(page.querySelector('.hero h1'));
    });
  });

  it('offers New Verification only with presentation:request', async () => {
    const config = async () => ({ id: 'age-check', dcql_query: { credentials: [] } });
    const offer = (page: HTMLElement) =>
      [...page.querySelectorAll('.hero-actions a')].find((a) =>
        a.textContent?.includes('New Verification')
      );
    const manager = await render(config);
    await vi.waitFor(() => {
      manager.fixture.detectChanges();
      expect(manager.page.querySelector('.hero')).not.toBeNull();
    });
    expect(offer(manager.page)).toBeUndefined();

    TestBed.resetTestingModule();
    const requester = await render(config, {
      roles: ['presentation:manage', 'presentation:request'],
    });
    await vi.waitFor(() => {
      requester.fixture.detectChanges();
      expect(offer(requester.page)?.getAttribute('href')).toBe('/offer/presentation/age-check');
    });
  });

  it('deletes nothing without presentation:manage', async () => {
    const deleteConfiguration = vi.fn(async () => undefined);
    const { fixture } = await render(
      async () => ({ id: 'age-check', dcql_query: { credentials: [] } }),
      { roles: [], deleteConfiguration }
    );
    await vi.waitFor(() => expect(fixture.componentInstance.config).toBeTruthy());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await fixture.componentInstance.deletePresentation();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteConfiguration).not.toHaveBeenCalled();
  });
});
