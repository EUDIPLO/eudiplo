import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderDownloadButton } from '../../config-portability/config-document.testing';
import { keyChainDeleteQuestion } from '../key-chain-delete-question';
import { KeyChainService } from '../key-chain.service';
import { KeyManagementShowComponent } from './key-management-show.component';

describe('KeyManagementShowComponent', () => {
  let component: KeyManagementShowComponent;
  let fixture: ComponentFixture<KeyManagementShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyManagementShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyManagementShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  function shownWith(overrides: Partial<KeyChainResponseDto>): string {
    component.keyChain = {
      id: 'key',
      type: 'standalone',
      usageType: 'attestation',
      kmsProvider: 'db',
      rotationPolicy: { enabled: false },
      activePublicKey: { kty: 'EC', crv: 'P-384' },
      ...overrides,
    } as KeyChainResponseDto;
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    return fixture.nativeElement.textContent;
  }

  it('names the signing algorithm and curve', () => {
    expect(shownWith({ alg: 'ES384' })).toContain('ES384 (ECDSA P-384)');
  });

  it('leaves the signing algorithm out for keys on other curves', () => {
    expect(shownWith({ alg: undefined })).not.toContain('Signing Algorithm');
  });

  const certificate = {
    subject: 'CN=self',
    issuer: 'CN=self',
    pem: '-----BEGIN CERTIFICATE-----',
    notAfter: '2099-01-01T00:00:00Z',
  };

  it('shows a federation key as its public key and says its certificate is unused', () => {
    const text = shownWith({
      usageType: 'federation',
      activePublicKey: { kty: 'EC', crv: 'P-256', kid: 'fed-kid', x: 'x-coordinate' },
      activeCertificate: certificate,
    } as Partial<KeyChainResponseDto>);
    expect(text).toContain('Public Key');
    expect(text).toContain('fed-kid');
    expect(text).toContain('x-coordinate');
    expect(text).toContain('Copy Public Key (JWK)');
    expect(text).toContain('OpenID Federation does not use it');
    expect(text).not.toContain('Active Certificate');
    expect(text).not.toContain('Copy PEM');
  });

  it('shows the previous public key of a rotated federation key without its certificate', () => {
    const text = shownWith({
      usageType: 'federation',
      activePublicKey: { kty: 'EC', crv: 'P-256', kid: 'new-kid' },
      previousPublicKey: { kty: 'EC', crv: 'P-256', kid: 'old-kid' },
      previousCertificate: certificate,
    } as Partial<KeyChainResponseDto>);
    expect(text).toContain('Previous Public Key (Grace Period)');
    expect(text).toContain('old-kid');
    expect(text).not.toContain('Previous Certificate');
  });

  it('keeps the certificate card for other keys', () => {
    const text = shownWith({ activeCertificate: certificate } as Partial<KeyChainResponseDto>);
    expect(text).toContain('Active Certificate');
    expect(text).not.toContain('OpenID Federation does not use it');
  });
});

describe('KeyManagementShowComponent configuration download', () => {
  const keyChain = { id: 'key', usageType: 'attestation' } as KeyChainResponseDto;
  let configDocuments: {
    canDownload: ReturnType<typeof vi.fn>;
    downloadWithFeedback: ReturnType<typeof vi.fn>;
  };
  let dialog: { open: ReturnType<typeof vi.fn> };

  function create(): KeyManagementShowComponent {
    const component = new KeyManagementShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dialog as never,
      {} as never,
      {} as never,
      configDocuments as never
    );
    component.keyChain = keyChain;
    return component;
  }

  beforeEach(() => {
    configDocuments = {
      canDownload: vi.fn().mockReturnValue(true),
      downloadWithFeedback: vi.fn().mockResolvedValue(undefined),
    };
    dialog = { open: vi.fn() };
  });

  it('asks the configuration document service whether key chains may be downloaded', () => {
    configDocuments.canDownload.mockReturnValue(false);

    expect(create().canDownloadConfig).toBe(false);
    expect(configDocuments.canDownload).toHaveBeenCalledWith('KeyChain');
  });

  it('downloads the configuration document of the key chain', async () => {
    await create().downloadConfig();

    expect(configDocuments.downloadWithFeedback).toHaveBeenCalledWith('KeyChain', 'key');
  });

  it('shows the public key chain as JSON without downloading the document', () => {
    create().viewAsJson();

    expect(configDocuments.downloadWithFeedback).not.toHaveBeenCalled();
    expect(dialog.open.mock.lastCall?.[1].data.jsonData).toBe(keyChain);
  });
});

describe('KeyManagementShowComponent download button', () => {
  it('is disabled while the document of the key chain is being downloaded', async () => {
    const keyChain = {
      id: 'key',
      type: 'standalone',
      usageType: 'attestation',
      kmsProvider: 'db',
      rotationPolicy: { enabled: false },
    } as KeyChainResponseDto;

    const button = await renderDownloadButton(KeyManagementShowComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'key' })) } },
        { provide: KeyChainService, useValue: { getById: async () => keyChain } },
      ],
      loaded: (component) => !!component.keyChain,
      downloading: ['KeyChain', 'key'],
      label: 'Download configuration (includes the private key)',
    });

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another resource is being downloaded', async () => {
    const keyChain = {
      id: 'key',
      type: 'standalone',
      usageType: 'attestation',
      kmsProvider: 'db',
      rotationPolicy: { enabled: false },
    } as KeyChainResponseDto;

    const button = await renderDownloadButton(KeyManagementShowComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'key' })) } },
        { provide: KeyChainService, useValue: { getById: async () => keyChain } },
      ],
      loaded: (component) => !!component.keyChain,
      downloading: ['KeyChain', 'other'],
      label: 'Download configuration (includes the private key)',
    });

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('KeyManagementShowComponent loading', () => {
  it('shows why the key chain could not be loaded instead of loading forever, and retries', async () => {
    const getById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404, message: 'Key chain not found' })
      .mockResolvedValueOnce({ id: 'key', usageType: 'attestation' });
    const component = new KeyManagementShowComponent(
      { getById } as never,
      { paramMap: of(convertToParamMap({ id: 'key' })) } as never,
      { open: vi.fn() } as never,
      {} as never,
      {} as never,
      { hasRole: () => true } as never,
      { getConfig: vi.fn().mockResolvedValue(null) } as never,
      {} as never
    );

    component.ngOnInit();
    await vi.waitFor(() => expect(component.loadError).not.toBe(''));

    expect(component.loadError).toBe('Failed to load key chain: Key chain not found');
    expect(component.keyChain).toBeUndefined();

    component.retryLoad();
    await vi.waitFor(() => expect(component.keyChain?.id).toBe('key'));
    expect(component.loadError).toBe('');
    component.ngOnDestroy();
  });
});

describe('KeyManagementShowComponent type description', () => {
  function describeKey(keyChain: Partial<KeyChainResponseDto>): string {
    const component = new KeyManagementShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    component.keyChain = { rotationPolicy: { enabled: false }, ...keyChain } as KeyChainResponseDto;
    return component.getTypeDescription();
  }

  it('calls a standalone key self-signed when its certificate names itself as issuer', () => {
    expect(
      describeKey({
        type: 'standalone',
        activeCertificate: { subject: 'CN=Tenant', issuer: 'CN=Tenant' },
      } as Partial<KeyChainResponseDto>)
    ).toBe('This is a self-signed standalone key.');
  });

  it('describes a federation key by its published JWK, not its self-signed certificate', () => {
    const description = describeKey({
      type: 'standalone',
      usageType: 'federation',
      activeCertificate: { subject: 'CN=Tenant', issuer: 'CN=Tenant' },
    } as Partial<KeyChainResponseDto>);

    expect(description).toContain('published as a JWK');
    expect(description).not.toContain('self-signed');
  });

  it('names a standalone key without an active certificate neither way', () => {
    expect(describeKey({ type: 'standalone' })).toBe('This is a standalone key.');
  });

  it('does not call a standalone key with a registrar or imported certificate self-signed', () => {
    const description = describeKey({
      type: 'standalone',
      activeCertificate: { subject: 'CN=Tenant', issuer: 'CN=Registrar CA' },
    } as Partial<KeyChainResponseDto>);

    expect(description).not.toContain('self-signed');
    expect(description).toContain('Issuer');
  });
});

describe('KeyManagementShowComponent registrar enrollment', () => {
  const selfSigned = { subject: 'CN=Tenant', issuer: 'CN=Tenant', pem: '' };
  const registrarIssued = { subject: 'CN=Tenant', issuer: 'CN=Registrar CA', pem: '' };
  let keyChainService: { getById: ReturnType<typeof vi.fn> };
  let registrarService: {
    getConfig: ReturnType<typeof vi.fn>;
    createAccessCertificate: ReturnType<typeof vi.fn>;
  };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let snackBarAction: Subject<void>;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let roles: string[];

  function keyChain(overrides: Record<string, unknown> = {}): KeyChainResponseDto {
    return {
      id: 'access-key',
      type: 'standalone',
      usageType: 'access',
      rotationPolicy: { enabled: false },
      activeCertificate: selfSigned,
      ...overrides,
    } as unknown as KeyChainResponseDto;
  }

  async function create(key = keyChain()): Promise<KeyManagementShowComponent> {
    keyChainService.getById.mockResolvedValue(key);
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      { paramMap: of(convertToParamMap({ id: key.id })) } as never,
      snackBar as never,
      router as never,
      {} as never,
      { hasRole: (role: string) => roles.includes(role) } as never,
      registrarService as never,
      {} as never
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.keyChain).toBeDefined());
    if (roles.includes('registrar:manage')) {
      await vi.waitFor(() => expect(component.registrarConfig).not.toBe('checking'));
    }
    return component;
  }

  beforeEach(() => {
    keyChainService = { getById: vi.fn() };
    registrarService = {
      getConfig: vi.fn().mockResolvedValue({ registrarUrl: 'https://registrar.example' }),
      createAccessCertificate: vi.fn().mockResolvedValue({}),
    };
    snackBarAction = new Subject<void>();
    snackBar = { open: vi.fn(() => ({ onAction: () => snackBarAction })) };
    router = { navigate: vi.fn() };
    roles = ['registrar:manage'];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it('offers the enrollment for a standalone access key when a registrar is configured', async () => {
    expect((await create()).canEnrollWithRegistrar).toBe(true);
  });

  it('does not offer it without the registrar:manage role or read the configuration', async () => {
    roles = ['keys:manage'];
    const component = await create();

    expect(registrarService.getConfig).not.toHaveBeenCalled();
    expect(component.canEnrollWithRegistrar).toBe(false);
  });

  it('links to the registrar configuration instead when there is none', async () => {
    registrarService.getConfig.mockResolvedValue(null);
    const component = await create();

    expect(component.canEnrollWithRegistrar).toBe(false);
    expect(component.needsRegistrarConfig).toBe(true);
  });

  it('keeps the page shown while it reloads the enrolled key', async () => {
    const component = await create();
    let resolveReload!: (key: KeyChainResponseDto) => void;
    keyChainService.getById.mockReturnValue(new Promise((resolve) => (resolveReload = resolve)));

    const enrolling = component.enrollWithRegistrar();
    await vi.waitFor(() => expect(keyChainService.getById).toHaveBeenCalledTimes(2));
    expect(component.keyChain).toBeDefined();
    resolveReload(keyChain({ activeCertificate: registrarIssued }));
    await enrolling;

    expect(component.keyChain?.activeCertificate?.issuer).toBe('CN=Registrar CA');
  });

  it('offers it when the registrar configuration could not be read', async () => {
    registrarService.getConfig.mockRejectedValue({ status: 500 });
    const component = await create();

    expect(component.registrarConfig).toBe('unknown');
    expect(component.canEnrollWithRegistrar).toBe(true);
  });

  it.each([
    ['an internal chain', { type: 'internalChain' }],
    ['an attestation key', { usageType: 'attestation' }],
  ])('does not offer it for %s', async (_, overrides) => {
    expect((await create(keyChain(overrides))).canEnrollWithRegistrar).toBe(false);
  });

  it('enrolls a self-signed key without asking and reloads it', async () => {
    const component = await create();
    keyChainService.getById.mockResolvedValue(keyChain({ activeCertificate: registrarIssued }));

    await component.enrollWithRegistrar();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(registrarService.createAccessCertificate).toHaveBeenCalledWith('access-key');
    expect(snackBar.open.mock.lastCall?.[0]).toBe('Access certificate enrolled via registrar');
    expect(component.keyChain?.activeCertificate?.issuer).toBe('CN=Registrar CA');
    expect(component.isEnrolling).toBe(false);
  });

  it('asks before replacing a certificate issued by someone else', async () => {
    const component = await create(keyChain({ activeCertificate: registrarIssued }));
    vi.mocked(window.confirm).mockReturnValue(false);

    await component.enrollWithRegistrar();

    expect(vi.mocked(window.confirm).mock.lastCall?.[0]).toContain('CN=Registrar CA');
    expect(registrarService.createAccessCertificate).not.toHaveBeenCalled();
  });

  it('replaces a certificate issued by someone else once confirmed', async () => {
    const component = await create(keyChain({ activeCertificate: registrarIssued }));

    await component.enrollWithRegistrar();

    expect(window.confirm).toHaveBeenCalled();
    expect(registrarService.createAccessCertificate).toHaveBeenCalledWith('access-key');
  });

  it('keeps showing another key the user opened during the enrollment', async () => {
    const paramMap = new BehaviorSubject(convertToParamMap({ id: 'access-key' }));
    keyChainService.getById.mockImplementation((...args: unknown[]) =>
      Promise.resolve(keyChain({ id: args[0] }))
    );
    let finishEnrollment!: () => void;
    registrarService.createAccessCertificate.mockReturnValue(
      new Promise<void>((resolve) => (finishEnrollment = resolve))
    );
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      { paramMap } as never,
      snackBar as never,
      router as never,
      {} as never,
      { hasRole: (role: string) => roles.includes(role) } as never,
      registrarService as never,
      {} as never
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.keyChain?.id).toBe('access-key'));
    await vi.waitFor(() => expect(component.registrarConfig).toBe('configured'));

    const enrolling = component.enrollWithRegistrar();
    paramMap.next(convertToParamMap({ id: 'other-key' }));
    await vi.waitFor(() => expect(component.keyChain?.id).toBe('other-key'));
    expect(component.isEnrolling).toBe(false);
    finishEnrollment();
    await enrolling;

    expect(component.keyChain?.id).toBe('other-key');
    expect(component.isEnrolling).toBe(false);
    component.ngOnDestroy();
  });

  it('warns before enrolling a rotating key', async () => {
    const component = await create(
      keyChain({ rotationPolicy: { enabled: true, intervalDays: 30 } })
    );
    vi.mocked(window.confirm).mockReturnValue(false);

    await component.enrollWithRegistrar();

    expect(vi.mocked(window.confirm).mock.lastCall?.[0]).toContain('rotates automatically');
    expect(registrarService.createAccessCertificate).not.toHaveBeenCalled();
  });

  it('sends one request when the action is selected twice', async () => {
    const component = await create();
    let finishEnrollment!: () => void;
    registrarService.createAccessCertificate.mockReturnValue(
      new Promise<void>((resolve) => (finishEnrollment = resolve))
    );

    const first = component.enrollWithRegistrar();
    expect(component.isEnrolling).toBe(true);
    await component.enrollWithRegistrar();
    finishEnrollment();
    await first;

    expect(registrarService.createAccessCertificate).toHaveBeenCalledTimes(1);
    expect(component.isEnrolling).toBe(false);
  });

  it('keeps the key shown when its reload after the enrollment fails', async () => {
    const component = await create();
    keyChainService.getById.mockRejectedValue({
      statusCode: 500,
      message: 'Internal server error',
    });

    await component.enrollWithRegistrar();

    expect(component.keyChain?.id).toBe('access-key');
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to reload key chain: Internal server error'
    );
  });

  it('offers neither the action nor the link while the configuration is read', async () => {
    registrarService.getConfig.mockReturnValue(new Promise(() => undefined));
    keyChainService.getById.mockResolvedValue(keyChain());
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      { paramMap: of(convertToParamMap({ id: 'access-key' })) } as never,
      snackBar as never,
      router as never,
      {} as never,
      { hasRole: (role: string) => roles.includes(role) } as never,
      registrarService as never,
      {} as never
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.keyChain).toBeDefined());

    expect(component.canEnrollWithRegistrar).toBe(false);
    expect(component.needsRegistrarConfig).toBe(false);
  });

  it("shows the backend's reason for a refusal and links to the registrar page", async () => {
    const component = await create();
    keyChainService.getById.mockClear();
    registrarService.createAccessCertificate.mockRejectedValue({
      status: 400,
      error: { message: 'Failed to authenticate with registrar' },
    });

    await component.enrollWithRegistrar();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('Failed to authenticate with registrar');
    expect(snackBar.open.mock.lastCall?.[1]).toBe('Go to Registrar');
    snackBarAction.next();
    expect(router.navigate).toHaveBeenCalledWith(['/registrar']);
    // A refused request stored nothing.
    expect(keyChainService.getById).not.toHaveBeenCalled();
  });

  it('reloads the key after a failure that may have stored the certificate', async () => {
    const component = await create();
    keyChainService.getById.mockClear();
    registrarService.createAccessCertificate.mockRejectedValue({ status: 0 });

    await component.enrollWithRegistrar();

    expect(snackBar.open.mock.lastCall?.[0]).toContain('the backend could not be reached');
    expect(keyChainService.getById).toHaveBeenCalledWith('access-key');
  });

  it('does not link to the registrar page when the role is missing', async () => {
    const component = await create();
    registrarService.createAccessCertificate.mockRejectedValue({ status: 403 });

    await component.enrollWithRegistrar();

    expect(snackBar.open.mock.lastCall?.[1]).toBe('Close');
  });
});

describe('KeyManagementShowComponent delete', () => {
  const keyChain = {
    id: 'signing',
    description: 'PID signing',
    usageType: 'attestation',
  } as KeyChainResponseDto;
  let keyChainService: { delete: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let router: { navigate: ReturnType<typeof vi.fn> };

  function create(): KeyManagementShowComponent {
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      {} as never,
      snackBar as never,
      router as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    component.keyChain = keyChain;
    return component;
  }

  beforeEach(() => {
    keyChainService = { delete: vi.fn().mockResolvedValue(undefined) };
    snackBar = { open: vi.fn() };
    router = { navigate: vi.fn() };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the shared question, deletes and goes back to the list', async () => {
    await create().deleteKey();

    expect(window.confirm).toHaveBeenCalledWith(keyChainDeleteQuestion('signing', 'PID signing'));
    expect(keyChainService.delete).toHaveBeenCalledWith('signing');
    expect(router.navigate).toHaveBeenCalled();
  });

  it('says that a federation key may stop the entity from being trusted', async () => {
    const component = create();
    component.keyChain = { ...keyChain, usageType: 'federation' } as KeyChainResponseDto;
    vi.mocked(window.confirm).mockReturnValue(false);

    await component.deleteKey();

    expect(vi.mocked(window.confirm).mock.lastCall?.[0]).toContain(
      'no longer trusted until your trust anchor lists the public key'
    );
    expect(keyChainService.delete).not.toHaveBeenCalled();
  });

  it('shows the configurations the backend names when it refuses the delete', async () => {
    const message =
      'Key chain "signing" is still used by the issuance configuration and 1 credential config ("pid").' +
      ' Remove these references before deleting the key chain.';
    keyChainService.delete.mockRejectedValue({
      statusCode: 409,
      code: 'KEY_CHAIN_IN_USE',
      message,
      references: [{ kind: 'IssuanceConfig' }, { kind: 'CredentialConfig', id: 'pid' }],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = create();

    await component.deleteKey();

    expect(snackBar.open).toHaveBeenCalledWith(
      `Failed to delete key chain: ${message}`,
      'Close',
      expect.anything()
    );
    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.deleting).toBe(false);
  });

  it('sends one request when Delete is selected twice', async () => {
    let finish!: () => void;
    keyChainService.delete.mockReturnValue(new Promise<void>((done) => (finish = done)));
    const component = create();

    const first = component.deleteKey();
    await component.deleteKey();
    finish();
    await first;

    expect(keyChainService.delete).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the question is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);

    await create().deleteKey();

    expect(keyChainService.delete).not.toHaveBeenCalled();
  });
});

describe('KeyManagementShowComponent default access key chain', () => {
  function keyChain(usageType = 'access'): KeyChainResponseDto {
    return {
      id: 'access-key',
      description: 'Registrar',
      type: 'standalone',
      usageType,
      rotationPolicy: { enabled: false },
    } as unknown as KeyChainResponseDto;
  }

  async function create(
    key: KeyChainResponseDto,
    keyChainService: Record<string, ReturnType<typeof vi.fn>>,
    snackBar = { open: vi.fn() }
  ): Promise<KeyManagementShowComponent> {
    keyChainService['getById'] = vi.fn().mockResolvedValue(key);
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      { paramMap: of(convertToParamMap({ id: key.id })) } as never,
      snackBar as never,
      { navigate: vi.fn() } as never,
      {} as never,
      { hasRole: () => false } as never,
      {} as never,
      {} as never
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.keyChain).toBeDefined());
    return component;
  }

  afterEach(() => vi.restoreAllMocks());

  it('marks the key chain picked by rule and makes it the default', async () => {
    const snackBar = { open: vi.fn() };
    const setDefaultAccess = vi
      .fn()
      .mockResolvedValue({ defaultAccessKeyChainId: 'access-key', keyChainId: 'access-key' });
    const component = await create(
      keyChain(),
      {
        getDefaultAccess: vi.fn().mockResolvedValue({ keyChainId: 'access-key' }),
        setDefaultAccess,
      },
      snackBar
    );
    await vi.waitFor(() => expect(component.defaultAccess).toBeDefined());

    expect(component.defaultChip?.label).toBe('Default by rule');
    expect(component.defaultToggleLabel).toBe(
      'Use key chain Registrar as default access key chain'
    );

    await component.toggleDefaultAccess();

    expect(setDefaultAccess).toHaveBeenCalledWith('access-key');
    expect(component.defaultChip?.label).toBe('Default');
    expect(component.isDefaultAccess).toBe(true);
    expect(snackBar.open).toHaveBeenCalledWith('Default access key chain set', 'Dismiss', {
      duration: 3000,
    });
  });

  it('removes the configured default with null', async () => {
    const setDefaultAccess = vi.fn().mockResolvedValue({ keyChainId: 'other' });
    const component = await create(keyChain(), {
      getDefaultAccess: vi
        .fn()
        .mockResolvedValue({ defaultAccessKeyChainId: 'access-key', keyChainId: 'access-key' }),
      setDefaultAccess,
    });
    await vi.waitFor(() => expect(component.defaultAccess).toBeDefined());

    await component.toggleDefaultAccess();

    expect(setDefaultAccess).toHaveBeenCalledWith(null);
    expect(component.defaultChip).toBeUndefined();
  });

  it('refuses to delete the configured default without asking', async () => {
    const snackBar = { open: vi.fn() };
    const remove = vi.fn();
    const component = await create(
      keyChain(),
      {
        getDefaultAccess: vi
          .fn()
          .mockResolvedValue({ defaultAccessKeyChainId: 'access-key', keyChainId: 'access-key' }),
        delete: remove,
      },
      snackBar
    );
    await vi.waitFor(() => expect(component.defaultAccess).toBeDefined());
    const confirm = vi.spyOn(window, 'confirm');

    await component.deleteKey();

    expect(confirm).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(snackBar.open).toHaveBeenCalledWith(
      expect.stringContaining("This is the tenant's default access key chain"),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not read the default for other usage types', async () => {
    const getDefaultAccess = vi.fn();
    const component = await create(keyChain('attestation'), { getDefaultAccess });

    expect(getDefaultAccess).not.toHaveBeenCalled();
    expect(component.defaultAccess).toBeUndefined();
  });

  it('shows the key chain without default controls when the default cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getDefaultAccess = vi.fn().mockRejectedValue({ statusCode: 500 });
    const component = await create(keyChain(), { getDefaultAccess });
    await vi.waitFor(() => expect(getDefaultAccess).toHaveBeenCalled());

    expect(component.loadError).toBe('');
    expect(component.defaultAccess).toBeUndefined();
  });
});

describe('KeyManagementShowComponent certificate request', () => {
  function create(keyChain: Partial<KeyChainResponseDto>): KeyManagementShowComponent {
    const component = new KeyManagementShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { hasRole: () => false } as never,
      {} as never,
      {} as never
    );
    component.keyChain = keyChain as KeyChainResponseDto;
    return component;
  }

  it('offers an external CA certificate for a standalone signing key', () => {
    expect(create({ type: 'standalone', usageType: 'access' }).offersCertificateRequest).toBe(true);
  });

  it.each([
    { type: 'internalChain', usageType: 'attestation' },
    { type: 'standalone', usageType: 'encrypt' },
    { type: 'standalone', usageType: 'federation' },
  ] as Partial<KeyChainResponseDto>[])('does not offer it for %o', (keyChain) => {
    expect(create(keyChain).offersCertificateRequest).toBe(false);
  });

  it('drops ?certificate=request once the certificate is stored', () => {
    const navigate = vi.fn().mockResolvedValue(true);
    const route = { snapshot: { queryParamMap: convertToParamMap({ certificate: 'request' }) } };
    const component = new KeyManagementShowComponent(
      {} as never,
      route as never,
      {} as never,
      { navigate } as never,
      {} as never,
      { hasRole: () => false } as never,
      {} as never,
      {} as never
    );

    component.onCertificateSaved();

    expect(navigate).toHaveBeenCalledWith([], {
      relativeTo: route,
      queryParams: { certificate: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  });
});
