import { HttpErrorResponse } from '@angular/common/http';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegistrarService } from '../../registrar/registrar.service';
import { JwtService } from '../../services/jwt.service';
import { KeyChainService } from '../key-chain.service';
import { KeyCreateWizardComponent } from './key-create-wizard.component';

describe('KeyCreateWizardComponent', () => {
  let fixture: ComponentFixture<KeyCreateWizardComponent>;
  let roles: string[];
  let getConfig: ReturnType<typeof vi.fn>;
  let snackBar: { open: ReturnType<typeof vi.fn> };

  async function create(granted: string[]): Promise<KeyCreateWizardComponent> {
    roles = granted;
    await TestBed.configureTestingModule({
      imports: [KeyCreateWizardComponent],
      providers: [
        provideRouter([]),
        {
          provide: KeyChainService,
          useValue: { getProviders: vi.fn().mockResolvedValue({ providers: [], default: 'db' }) },
        },
        { provide: RegistrarService, useValue: { getConfig } },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
          },
        },
      ],
    }).compileComponents();
    TestBed.overrideProvider(MatSnackBar, { useValue: snackBar });
    fixture = TestBed.createComponent(KeyCreateWizardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    getConfig = vi.fn().mockResolvedValue({ registrarUrl: 'https://registrar.example' });
    snackBar = { open: vi.fn().mockReturnValue({ onAction: () => of() }) };
  });

  it('reads the registrar configuration with registrar:manage', async () => {
    const component = await create(['keys:manage', 'registrar:manage']);

    expect(component.canUseRegistrar).toBe(true);
    expect(getConfig).toHaveBeenCalled();
  });

  it('keeps a caller without registrar:manage from registrar enrollment and says why', async () => {
    const component = await create(['keys:manage']);
    expect(component.canUseRegistrar).toBe(false);
    expect(getConfig).not.toHaveBeenCalled();

    component.accessSourceForm.get('accessSource')?.setValue('registrar');
    const next = vi.spyOn(component.stepper, 'next');
    component.onAccessSourceNext();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Enrolling through the registrar needs the registrar:manage role',
      'Close',
      expect.anything()
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('does not claim that the registrar credentials work', async () => {
    const component = await create(['keys:manage', 'registrar:manage']);
    component.usageForm.patchValue({ usage: 'access' });
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Registrar configured. Its credentials are checked when you enroll.');
    expect(text).not.toContain('Registrar credentials configured');
  });

  it('says that the registrar configuration could not be read, and retries', async () => {
    getConfig.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 500, error: { message: 'Internal server error' } })
    );
    const component = await create(['keys:manage', 'registrar:manage']);
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'registrar' });
    fixture.detectChanges();
    // Only the selected step can take focus.
    component.stepper.next();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain(
      'Could not check the registrar configuration: Internal server error'
    );
    expect(element.textContent).not.toContain('Registrar credentials not configured');

    const retry: HTMLButtonElement = element.querySelector('.registrar-retry button')!;
    expect(retry.closest('label')).toBeNull();
    retry.focus();
    expect(document.activeElement).toBe(retry);
    retry.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain('Registrar configured.');
    expect(element.querySelector('.registrar-retry')).toBeNull();
    expect((document.activeElement as HTMLInputElement).value).toBe('registrar');
  });

  it('keeps the user in the wizard while the key is created and enrolled', async () => {
    const component = await create(['keys:manage', 'registrar:manage']);
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'registrar' });
    component.isSubmitting = true;
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.disabled).toBe(
      true
    );
    const back = [...element.querySelectorAll<HTMLButtonElement>('button[matStepperPrevious]')];
    expect(back.at(-1)!.disabled).toBe(true);
    expect(component.stepper.steps.toArray().map((step) => step.editable)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('shows a refused enrollment next to Create & Enroll', async () => {
    const component = await create(['keys:manage', 'registrar:manage']);
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'registrar' });
    component.enrollmentError = {
      message: 'Refused. The new key was deleted.',
      offerRegistrar: true,
    };
    fixture.detectChanges();

    const alert: HTMLElement = fixture.nativeElement.querySelector('.enrollment-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Refused. The new key was deleted.');
    expect(alert.querySelector('a')?.getAttribute('href')).toBe('/registrar');

    component.enrollmentError = { message: 'Needs a role.', offerRegistrar: false };
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.enrollment-error a')).toBeNull();
  });
});

describe('KeyCreateWizardComponent registrar enrollment', () => {
  let keyChainService: { create: ReturnType<typeof vi.fn> };
  let registrarService: { createAccessKeyChain: ReturnType<typeof vi.fn> };
  let router: { navigate: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  const authenticationFailed = new HttpErrorResponse({
    status: 400,
    error: {
      statusCode: 400,
      message:
        'Failed to authenticate with registrar: the OIDC provider answered with HTTP 401, invalid_grant',
    },
  });

  /** A wizard on the last step of a registrar enrollment. */
  function create(): KeyCreateWizardComponent {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      registrarService as never,
      {} as never,
      router as never,
      snackBar as never,
      { hasRole: () => true } as never
    );
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'registrar' });
    return component;
  }

  beforeEach(() => {
    keyChainService = { create: vi.fn() };
    registrarService = {
      createAccessKeyChain: vi
        .fn()
        .mockResolvedValue({ id: 'registrar-cert', certId: 'key-1', crt: 'PEM' }),
    };
    router = { navigate: vi.fn() };
    snackBar = { open: vi.fn().mockReturnValue({ onAction: () => of() }) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('creates and enrolls the key in one request and opens it', async () => {
    const component = create();
    component.configForm.patchValue({ description: '  Registrar key ', kmsProvider: 'vault' });

    await component.createKey();

    expect(keyChainService.create).not.toHaveBeenCalled();
    expect(registrarService.createAccessKeyChain).toHaveBeenCalledWith({
      description: 'Registrar key',
      kmsProvider: 'vault',
    });
    expect(router.navigate).toHaveBeenCalledWith(['/keys', 'key-1']);
  });

  it('says why next to Create & Enroll when the registrar authentication fails', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(authenticationFailed);
    const component = create();

    await component.createKey();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(snackBar.open).not.toHaveBeenCalled();
    expect(component.isSubmitting).toBe(false);
    expect(component.enrollmentError).toEqual({
      message:
        'Failed to authenticate with registrar: the OIDC provider answered with HTTP 401, invalid_grant. ' +
        'No key was kept. Check the registrar configuration and try again.',
      offerRegistrar: true,
    });
  });

  it('offers the registrar configuration when it is gone', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({
        status: 404,
        error: { statusCode: 404, message: 'No registrar configuration found for tenant t' },
      })
    );
    const component = create();

    await component.createKey();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.enrollmentError?.offerRegistrar).toBe(true);
  });

  it('names the missing role on 403', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({
        status: 403,
        error: { statusCode: 403, message: 'Forbidden resource' },
      })
    );
    const component = create();

    await component.createKey();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.enrollmentError).toEqual({
      message: 'Enrolling through the registrar needs the registrar:manage role. No key was kept.',
      offerRegistrar: false,
    });
  });

  it('clears the previous refusal when Create & Enroll is selected again', async () => {
    registrarService.createAccessKeyChain.mockRejectedValueOnce(authenticationFailed);
    const component = create();
    await component.createKey();
    expect(component.enrollmentError).not.toBeNull();

    await component.createKey();

    expect(component.enrollmentError).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/keys', 'key-1']);
  });

  it('clears the refusal when the certificate source changes', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(authenticationFailed);
    const component = create();
    await component.createKey();
    expect(component.enrollmentError).not.toBeNull();

    component.accessSourceForm.patchValue({ accessSource: 'selfSigned' });

    expect(component.enrollmentError).toBeNull();
  });

  it('reports a refusal in a snackbar and stays put when the user left the wizard', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(authenticationFailed);
    const component = create();
    const creating = component.createKey();
    component.ngOnDestroy();

    await creating;

    expect(component.enrollmentError).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(snackBar.open.mock.lastCall?.[0]).toContain('No key was kept.');
  });

  it('says how to recognize an enrolled or self-signed key when the backend did not answer', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })
    );
    const component = create();

    await component.createKey();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.enrollmentError).toEqual({
      message:
        'Failed to enroll certificate from registrar: the backend could not be reached. Check the connection and try again. ' +
        'EUDIPLO may still have created the key. If Keys lists a new access key, open it: ' +
        'a different Issuer than Subject in its Active Certificate means it is enrolled; ' +
        'the same Issuer as Subject means it is self-signed: select Enroll with Registrar ' +
        'on that certificate, or delete the key.',
      offerRegistrar: false,
      offerKeys: true,
    });
  });

  it.each([502, 503, 504])('treats a %s from a proxy as an unknown outcome', async (status) => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({ status, statusText: 'Gateway', error: 'Gateway' })
    );
    const component = create();

    await component.createKey();

    expect(component.enrollmentError?.message).toContain('EUDIPLO may still have created the key.');
    expect(component.enrollmentError?.offerKeys).toBe(true);
  });

  it('says no key was kept after a server error of EUDIPLO', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({
        status: 500,
        error: { statusCode: 500, message: 'Internal Server Error' },
      })
    );
    const component = create();

    await component.createKey();

    expect(component.enrollmentError).toEqual({
      message:
        'Failed to enroll certificate from registrar: Internal Server Error. No key was kept.',
      offerRegistrar: false,
    });
  });

  it('does not blame the registrar for another refusal, such as an unknown KMS provider', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({
        status: 400,
        error: { statusCode: 400, message: "Unknown KMS provider 'x'. Configured providers: db" },
      })
    );
    const component = create();

    await component.createKey();

    expect(component.enrollmentError).toEqual({
      message:
        "Failed to enroll certificate from registrar: Unknown KMS provider 'x'. Configured providers: db. No key was kept.",
      offerRegistrar: false,
    });
  });

  it('offers the key EUDIPLO could not delete', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({
        status: 500,
        error: {
          statusCode: 500,
          message:
            'Failed to create access certificate. The new access key chain key-1 could not be deleted; delete it.',
        },
      })
    );
    const component = create();

    await component.createKey();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.enrollmentError).toEqual({
      message:
        'Failed to create access certificate. The new access key chain key-1 could not be deleted; delete it. ' +
        'The new key has only its self-signed certificate: open it and ' +
        'select Enroll with Registrar on its Active Certificate, or delete it.',
      offerRegistrar: false,
      keptKeyId: 'key-1',
    });
  });

  it('reports an unknown outcome in a snackbar when the user left the wizard', async () => {
    registrarService.createAccessKeyChain.mockRejectedValue(
      new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })
    );
    const component = create();
    const creating = component.createKey();
    component.ngOnDestroy();

    await creating;

    expect(component.enrollmentError).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(snackBar.open.mock.lastCall?.[0]).toContain('If Keys lists a new access key');
  });

  it('sends the default description and KMS provider when none is chosen', async () => {
    const component = create();
    component.configForm.patchValue({ description: '', kmsProvider: '' });

    await component.createKey();

    const [body] = registrarService.createAccessKeyChain.mock.lastCall!;
    expect(body.description).toBeTruthy();
    expect(body.kmsProvider).toBe('db');
  });
});

describe('KeyCreateWizardComponent errors', () => {
  let keyChainService: { import: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  /** A wizard on the external access certificate step with this key and certificate. */
  function create(externalCertificate: string): KeyCreateWizardComponent {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'external' });
    component.configForm.patchValue({
      externalPrivateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      externalCertificate,
    });
    return component;
  }

  beforeEach(() => {
    keyChainService = { import: vi.fn() };
    snackBar = { open: vi.fn() };
  });

  it('says what is wrong with the external certificate', async () => {
    await create('').createKey();

    expect(keyChainService.import).not.toHaveBeenCalled();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to import key chain: At least one certificate is required.'
    );
  });

  it("shows the backend's reason when the import is rejected", async () => {
    keyChainService.import.mockRejectedValue({
      statusCode: 400,
      message: 'The certificate does not match the private key',
    });

    await create('-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----').createKey();

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to import key chain: The certificate does not match the private key'
    );
  });
});

describe('KeyCreateWizardComponent imports', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };
  const key = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----';
  const certificate = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----';
  let keyChainService: { import: ReturnType<typeof vi.fn> };

  function create(): KeyCreateWizardComponent {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
    component.configForm.patchValue({ externalPrivateKey: key, externalCertificate: certificate });
    return component;
  }

  /** A wizard on the External CA Chain step of an attestation key. */
  function externalCaChain(): KeyCreateWizardComponent {
    const component = create();
    component.usageForm.patchValue({ usage: 'attestation' });
    component.caSourceForm.patchValue({ keyChainType: 'externalCaChain' });
    component.configForm.patchValue({ rotationIntervalDays: 45, certValidityDays: 200 });
    return component;
  }

  beforeEach(() => {
    keyChainService = { import: vi.fn().mockResolvedValue({ id: 'imported' }) };
    snackBar = { open: vi.fn() };
  });

  it('imports an External CA Chain as an internal chain with rotation', async () => {
    await externalCaChain().createKey();

    expect(keyChainService.import).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPem: key,
        usageType: 'attestation',
        type: 'internalChain',
        crt: [certificate],
        rotationPolicy: { enabled: true, intervalDays: 45, certValidityDays: 200 },
      })
    );
    expect(snackBar.open.mock.lastCall?.[0]).toBe('CA imported and signing key created.');
  });

  it('imports an External CA Chain as an internal chain without rotation', async () => {
    const component = externalCaChain();
    component.configForm.patchValue({ rotationEnabled: false });

    await component.createKey();

    expect(keyChainService.import).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'internalChain',
        rotationPolicy: { enabled: false, intervalDays: undefined, certValidityDays: 200 },
      })
    );
    expect(component.getSummary()).toContainEqual({ label: 'Rotation', value: 'Off' });
  });

  it('lets an invalid interval not block the form while rotation is off', () => {
    const component = externalCaChain();
    component.configForm.patchValue({ rotationIntervalDays: 0 });
    expect(component.configForm.valid).toBe(false);

    component.configForm.patchValue({ rotationEnabled: false });
    expect(component.configForm.valid).toBe(true);

    component.configForm.patchValue({ rotationEnabled: true });
    expect(component.configForm.valid).toBe(false);
  });

  it('imports a status list External CA Chain as an internal chain with rotation', async () => {
    const component = externalCaChain();
    component.usageForm.patchValue({ usage: 'statusList' });

    await component.createKey();

    expect(keyChainService.import).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'statusList',
        type: 'internalChain',
        rotationPolicy: { enabled: true, intervalDays: 45, certValidityDays: 200 },
      })
    );
  });

  it('imports an External Certificate as a standalone key chain', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'external' });

    await component.createKey();

    const [dto] = keyChainService.import.mock.lastCall!;
    expect(dto).toMatchObject({ usageType: 'access', type: 'standalone', crt: [certificate] });
    expect(dto.rotationPolicy).toBeUndefined();
    expect(snackBar.open.mock.lastCall?.[0]).toBe('Key and certificate imported.');
  });

  it('imports an externally issued status list certificate as a standalone key chain', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'statusList' });
    component.caSourceForm.patchValue({ keyChainType: 'standalone' });
    component.configForm.patchValue({ useExternalCertificate: true });

    await component.createKey();

    expect(keyChainService.import).toHaveBeenCalledWith(
      expect.objectContaining({ usageType: 'statusList', type: 'standalone' })
    );
  });
});

describe('KeyCreateWizardComponent certificate from a CSR', () => {
  let keyChainService: { create: ReturnType<typeof vi.fn>; import: ReturnType<typeof vi.fn> };
  let router: { navigate: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  function create(): KeyCreateWizardComponent {
    return new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      router as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
  }

  beforeEach(() => {
    keyChainService = {
      create: vi.fn().mockResolvedValue({ id: 'created' }),
      import: vi.fn(),
    };
    router = { navigate: vi.fn() };
    snackBar = { open: vi.fn() };
  });

  it('creates an access key without key material and opens its page for the CSR', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'external' });
    component.configForm.patchValue({ externalCertificateSource: 'csr' });

    expect(component.importsExternalKey).toBe(false);
    expect(component.externalCertificateFormValid).toBe(true);
    await component.createKey();

    expect(keyChainService.import).not.toHaveBeenCalled();
    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'access',
        type: 'standalone',
        rotationPolicy: expect.objectContaining({ enabled: false }),
      })
    );
    expect(router.navigate).toHaveBeenCalledWith(['/keys', 'created'], {
      queryParams: { certificate: 'request' },
    });
    expect(snackBar.open.mock.lastCall?.[0]).toContain('Create its CSR on this page');
    expect(component.getSummary()).toContainEqual({
      label: 'Type',
      value: 'Standalone (Certificate requested with a CSR)',
    });
  });

  it('creates an attestation key for a CSR when the external certificate option is checked', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'attestation' });
    component.caSourceForm.patchValue({ keyChainType: 'standalone' });
    component.configForm.patchValue({
      useExternalCertificate: true,
      externalCertificateSource: 'csr',
    });

    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({ usageType: 'attestation', type: 'standalone' })
    );
  });

  it('always imports the CA key of an External CA Chain', () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'attestation' });
    component.caSourceForm.patchValue({ keyChainType: 'externalCaChain' });
    component.configForm.patchValue({ externalCertificateSource: 'csr' });

    expect(component.requestsCertificate).toBe(false);
    expect(component.importsExternalKey).toBe(true);
    expect(component.externalCertificateFormValid).toBe(false);
  });
});

describe('KeyCreateWizardComponent internal chains', () => {
  let keyChainService: { create: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  function create(): KeyCreateWizardComponent {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
    component.usageForm.patchValue({ usage: 'attestation' });
    component.caSourceForm.patchValue({ keyChainType: 'internalChain' });
    return component;
  }

  beforeEach(() => {
    keyChainService = { create: vi.fn().mockResolvedValue({ id: 'created' }) };
    snackBar = { open: vi.fn().mockReturnValue({ onAction: () => of() }) };
  });

  it('names the creation when the backend refuses it', async () => {
    keyChainService.create.mockRejectedValue({ statusCode: 400, message: 'Unknown KMS provider' });

    await create().createKey();

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to create key chain: Unknown KMS provider'
    );
  });

  it('creates a federation entity key as a standalone key chain', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'federation' });

    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'federation',
        type: 'standalone',
        description: 'OpenID Federation Entity Key',
      })
    );
  });

  it('creates an access token key as a standalone key chain without certificate options', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'accessToken' });
    component.configForm.patchValue({ useExternalCertificate: true });

    expect(component.isExternalCertificate).toBe(false);
    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'accessToken',
        type: 'standalone',
        description: 'Access Token Signing Key',
      })
    );
  });

  it('creates an internal chain with rotation by default', async () => {
    await create().createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'internalChain',
        rotationPolicy: { enabled: true, intervalDays: 30, certValidityDays: 365 },
      })
    );
  });

  it('creates an internal chain without rotation', async () => {
    const component = create();
    component.configForm.patchValue({ rotationEnabled: false });

    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'internalChain',
        rotationPolicy: { enabled: false, intervalDays: undefined, certValidityDays: 365 },
      })
    );
  });

  it('offers to create the status list key next, with its usage preselected', async () => {
    const router = { navigate: vi.fn() };
    snackBar.open.mockReturnValue({ onAction: () => of(undefined) });
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      router as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
    component.usageForm.patchValue({ usage: 'attestation' });

    await component.createKey();

    expect(router.navigate).toHaveBeenCalledWith(['/keys/create'], {
      queryParams: { usage: 'statusList' },
    });
  });

  it('offers the key chain type only for attestation and status list keys', () => {
    const component = create();
    const offered = (
      ['attestation', 'statusList', 'access', 'accessToken', 'trustList', 'federation'] as const
    ).filter((usage) => {
      component.usageForm.patchValue({ usage });
      return component.showKeyChainTypeStep;
    });

    expect(offered).toEqual(['attestation', 'statusList']);
  });

  it('starts a status list key on Create Key Chain with rotation', () => {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      {} as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { hasRole: () => false } as never
    );
    component.usageForm.patchValue({ usage: 'statusList' });

    expect(component.selectedKeyChainType).toBe('internalChain');
    expect(component.rotationEnabled).toBe(true);
  });

  it('creates a status list key as an internal chain with rotation by default', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'statusList' });
    component.configForm.patchValue({ rotationIntervalDays: 20 });

    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'statusList',
        type: 'internalChain',
        description: 'Status List Signing Key',
        rotationPolicy: { enabled: true, intervalDays: 20, certValidityDays: 365 },
      })
    );
    expect(component.getSummary()).toContainEqual({
      label: 'Rotation Interval',
      value: '20 days',
    });
  });

  it('creates a standalone status list key without rotation', async () => {
    const component = create();
    component.usageForm.patchValue({ usage: 'statusList' });
    component.caSourceForm.patchValue({ keyChainType: 'standalone' });

    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageType: 'statusList',
        type: 'standalone',
        rotationPolicy: expect.objectContaining({ enabled: false }),
      })
    );
  });

  it('blocks the form while the certificate validity is empty', () => {
    const component = create();
    component.configForm.patchValue({ certValidityDays: null });

    expect(component.configForm.valid).toBe(false);
  });

  it('lets hidden rotation fields not block a standalone key', () => {
    const component = create();
    component.configForm.patchValue({ certValidityDays: null, rotationIntervalDays: 0 });
    expect(component.configForm.valid).toBe(false);

    component.caSourceForm.patchValue({ keyChainType: 'standalone' });
    expect(component.configForm.valid).toBe(true);

    component.caSourceForm.patchValue({ keyChainType: 'internalChain' });
    expect(component.configForm.valid).toBe(false);
  });
});

describe('KeyCreateWizardComponent signing algorithm', () => {
  let keyChainService: { create: ReturnType<typeof vi.fn>; getProviders: ReturnType<typeof vi.fn> };

  const providers = [
    {
      name: 'db',
      type: 'db',
      capabilities: {
        canCreate: true,
        canImport: true,
        canDelete: true,
        supportedAlgs: ['ES256', 'ES384', 'ES512'],
        defaultAlg: 'ES256',
      },
    },
    {
      name: 'hsm',
      type: 'pkcs11',
      capabilities: {
        canCreate: true,
        canImport: false,
        canDelete: true,
        supportedAlgs: ['ES384'],
        defaultAlg: 'ES384',
      },
    },
  ];

  async function create(): Promise<KeyCreateWizardComponent> {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      keyChainService as never,
      {} as never,
      { snapshot: { queryParamMap: new Map() } } as never,
      { navigate: vi.fn() } as never,
      { open: vi.fn().mockReturnValue({ onAction: () => of() }) } as never,
      { hasRole: () => false } as never
    );
    await component.loadKmsProviders();
    component.usageForm.patchValue({ usage: 'attestation' });
    component.caSourceForm.patchValue({ keyChainType: 'internalChain' });
    return component;
  }

  beforeEach(() => {
    keyChainService = {
      create: vi.fn().mockResolvedValue({ id: 'created' }),
      getProviders: vi.fn().mockResolvedValue({ providers, default: 'db' }),
    };
  });

  it("offers the provider's algorithms and preselects its default", async () => {
    const component = await create();

    expect(component.algorithmOptions.map((o) => o.value)).toEqual(['ES256', 'ES384', 'ES512']);
    expect(component.configForm.value.alg).toBe('ES256');

    component.configForm.patchValue({ kmsProvider: 'hsm' });
    expect(component.algorithmOptions.map((o) => o.value)).toEqual(['ES384']);
    expect(component.configForm.value.alg).toBe('ES384');
  });

  it('sends the chosen algorithm and names it in the summary', async () => {
    const component = await create();
    component.configForm.patchValue({ alg: 'ES512' });

    expect(component.getSummary()).toContainEqual({
      label: 'Algorithm',
      value: 'ES512 (ECDSA P-521)',
    });
    await component.createKey();

    expect(keyChainService.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internalChain', alg: 'ES512' })
    );
  });

  it('keeps the chosen algorithm when the new provider offers it', async () => {
    const component = await create();
    component.configForm.patchValue({ alg: 'ES384' });

    component.configForm.patchValue({ kmsProvider: 'hsm' });
    expect(component.configForm.value.alg).toBe('ES384');

    component.configForm.patchValue({ alg: 'ES384', kmsProvider: 'db' });
    expect(component.configForm.value.alg).toBe('ES384');
  });

  it('names the provider default for a registrar enrollment', async () => {
    const component = await create();
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'registrar' });
    component.configForm.patchValue({ kmsProvider: 'hsm' });

    expect(component.showAlgorithm).toBe(false);
    expect(component.getSummary()).toContainEqual({
      label: 'Algorithm',
      value: 'ES384 (ECDSA P-384) (provider default)',
    });
  });

  it('does not ask for an algorithm when the key is imported', async () => {
    const component = await create();
    component.caSourceForm.patchValue({ keyChainType: 'externalCaChain' });

    expect(component.showAlgorithm).toBe(false);
  });

  it('asks for an algorithm when EUDIPLO creates the key for a CSR', async () => {
    const component = await create();
    component.usageForm.patchValue({ usage: 'access' });
    component.accessSourceForm.patchValue({ accessSource: 'external' });

    expect(component.showAlgorithm).toBe(false);
    component.configForm.patchValue({ externalCertificateSource: 'csr' });
    expect(component.showAlgorithm).toBe(true);
  });
});

describe('KeyCreateWizardComponent usage from the link', () => {
  function openedWith(usage: string | null): KeyCreateWizardComponent {
    const component = new KeyCreateWizardComponent(
      new FormBuilder(),
      { getProviders: vi.fn().mockResolvedValue({ providers: [], default: 'db' }) } as never,
      {} as never,
      { snapshot: { queryParamMap: new Map(usage ? [['usage', usage]] : []) } } as never,
      { navigate: vi.fn() } as never,
      { open: vi.fn() } as never,
      { hasRole: () => false } as never
    );
    component.ngOnInit();
    return component;
  }

  it('preselects the usage a link names', () => {
    expect(openedWith('federation').selectedUsage).toBe('federation');
  });

  it('leaves the usage open for an unknown or missing value', () => {
    expect(openedWith('bogus').selectedUsage).toBeNull();
    expect(openedWith(null).selectedUsage).toBeNull();
  });
});
