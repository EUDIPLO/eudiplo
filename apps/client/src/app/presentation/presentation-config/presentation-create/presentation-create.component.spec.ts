import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '@eudiplo/sdk-core';
import { PresentationCreateComponent } from './presentation-create.component';
import { PresentationManagementService } from '../presentation-management.service';
import { RegistrarService } from '../../../registrar/registrar.service';
import { EditorComponent } from '../../../utils/editor/editor.component';
import { ThemeService } from '../../../services/theme.service';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';

const query = {
  credentials: [
    {
      id: 'pid',
      format: 'dc+sd-jwt',
      meta: { vct_values: ['urn:pid'] },
      claims: [{ path: ['given_name'] }],
    },
  ],
};

describe('Presentation configuration flow', () => {
  let component: PresentationCreateComponent;
  let fixture: ComponentFixture<PresentationCreateComponent>;
  let service: {
    createConfiguration: ReturnType<typeof vi.fn>;
    getPresentationById: ReturnType<typeof vi.fn>;
  };
  let route: { snapshot: { params: Record<string, string>; url: { path: string }[] } };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(client, 'get').mockResolvedValue({ data: [] } as any);
    vi.spyOn(client, 'patch').mockResolvedValue({ data: {} } as any);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    service = {
      createConfiguration: vi.fn().mockResolvedValue({ id: 'test' }),
      getPresentationById: vi.fn(),
    };
    route = { snapshot: { params: {}, url: [] } };
    await TestBed.configureTestingModule({
      imports: [PresentationCreateComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: route },
        { provide: PresentationManagementService, useValue: service },
        { provide: RegistrarService, useValue: { getConfig: vi.fn().mockResolvedValue(null) } },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: MatDialog, useValue: { open: vi.fn() } },
        { provide: ThemeService, useValue: { isDarkMode: false, themeChanges: new Subject() } },
        {
          provide: ConfigOwnershipService,
          useValue: { get: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    })
      .overrideProvider(MatSnackBar, { useValue: { open: vi.fn() } })
      .overrideComponent(EditorComponent, { set: { template: '' } })
      .compileComponents();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(PresentationCreateComponent);
    component = fixture.componentInstance;
  });

  function fill() {
    component.form.patchValue({
      id: 'test',
      description: 'Test request',
      dcql_query: structuredClone(query),
    });
  }

  describe("access hint with the tenant's default access key chain", () => {
    const withCertificate = { id: 'chosen', activeCertificate: { pem: 'pem' } } as any;
    const other = { id: 'other', activeCertificate: { pem: 'pem' } } as any;

    function setUp(keyChains: any[], defaultAccess: Record<string, string>) {
      component.keyChains = keyChains;
      component.keyChainsLoaded = true;
      (component as unknown as { defaultAccess: unknown }).defaultAccess = defaultAccess;
    }

    it('accepts a default with a certificate', () => {
      setUp([withCertificate], { defaultAccessKeyChainId: 'chosen', keyChainId: 'chosen' });
      expect(component.accessSetupMessage).toBeNull();
    });

    it('names a default that no longer exists, although another key chain has a certificate', () => {
      setUp([other], { defaultAccessKeyChainId: 'gone' });
      expect(component.accessSetupMessage).toContain(
        'The default access key chain of the tenant does not exist'
      );
    });

    it('names a default without certificate', () => {
      setUp([other, { id: 'chosen' }], { defaultAccessKeyChainId: 'chosen', keyChainId: 'chosen' });
      expect(component.accessSetupMessage).toContain(
        'The default access key chain has no active access certificate'
      );
    });

    it('checks the selected access key chain instead of the default', () => {
      setUp([other], { defaultAccessKeyChainId: 'gone' });
      component.form.patchValue({ accessKeyChainId: 'other' });
      expect(component.accessSetupMessage).toBeNull();
    });
  });

  it('renders the guided creation flow and validates each step', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.guided).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Step 1 of 4');
    component.nextStep();
    expect(component.activeStep).toBe(0);
    component.form.patchValue({ id: 'test', description: 'Test request' });
    component.nextStep();
    fixture.detectChanges();
    expect(component.activeStep).toBe(1);
    component.nextStep();
    expect(component.activeStep).toBe(1);
    component.queryControl.setValue(query);
    component.nextStep();
    component.nextStep();
    fixture.detectChanges();
    expect(component.activeStep).toBe(3);
    expect(component.form.valid).toBe(true);
  });

  it('uses the same state and payload in guided setup and direct editing', async () => {
    fill();
    component.addAttachment();
    component
      .getFormArray('attached')
      .at(0)
      .patchValue({ format: 'dc+sd-jwt', data: 'signed-credential', credential_ids: ['pid'] });
    component.form.patchValue({
      webhookEndpointId: 'events',
      registrationCertImportJwt: 'certificate',
      statusCheckMode: 'best_effort',
    });
    const before = component.form.getRawValue();
    component.toggleGuided();
    component.toggleGuided();
    expect(component.form.getRawValue()).toEqual(before);
    component.activeStep = 3;
    component.submitPresentation();
    const payload = service.createConfiguration.mock.calls[0][0];
    expect(payload.dcql_query).toEqual(query);
    expect(payload.attached).toEqual(before.attached);
    expect(payload.webhookEndpointId).toBe('events');
    expect(payload.registration_cert).toEqual({ jwt: 'certificate' });
    expect(payload.statusCheckMode).toBe('best_effort');
    expect(payload).not.toHaveProperty('registrationCertImportJwt');
    await Promise.resolve();
  });

  it('does not save when Enter is pressed before review', () => {
    fill();
    component.submitPresentation();
    expect(component.activeStep).toBe(1);
    expect(service.createConfiguration).not.toHaveBeenCalled();
  });

  it('finds invalid advanced settings even without visiting their editors', () => {
    fill();
    component.activeStep = 3;
    component.form.get('transaction_data')!.setValue('{');
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).not.toHaveBeenCalled();
    expect(component.activeStep).toBe(2);
    expect(component.showSettingsErrors).toBe(true);
  });

  it('summarises omitted, empty and malformed claims differently', () => {
    const { id, format, meta } = query.credentials[0];
    const credentialOnly = { id, format, meta };
    const summaryClaims = (claims: unknown) => {
      component.queryControl.setValue({
        credentials: [claims === undefined ? credentialOnly : { ...credentialOnly, claims }],
      });
      return component.querySummary[0].claims;
    };
    expect(summaryClaims(undefined)).toEqual([]);
    expect(summaryClaims([])[0]).toContain('Empty claims list');
    expect(summaryClaims({})).toEqual(['Invalid claims list']);
  });

  it('preserves explicit clearing of an access key override', () => {
    fill();
    component.form.patchValue({ accessKeyChainId: null, redirectUri: '' });
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ accessKeyChainId: null, redirectUri: '' })
    );
  });

  it('reports JSON null as invalid without crashing the editor', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.queryControl.setValue('null');
    fixture.detectChanges();
    component.createOrUpdatePresentation();
    expect(component.queryControl.invalid).toBe(true);
    expect(service.createConfiguration).not.toHaveBeenCalled();
  });

  it('keeps entered names when choosing a template', () => {
    fill();
    component.loadPredefinedConfig({
      name: 'Example',
      config: { id: 'template', description: 'Template', dcql_query: query },
    });
    expect(component.form.get('id')!.value).toBe('test');
    expect(component.form.get('description')!.value).toBe('Test request');
  });

  it('rebuilds arrays on JSON import and can clear existing integration settings', () => {
    fill();
    component['loadConfigurationFromJson']({
      id: 'test',
      description: 'Test request',
      dcql_query: query,
      attached: [{ format: 'dc+sd-jwt', data: 'signed', credential_ids: ['pid'] }],
      registration_cert: { jwt: 'cert' },
      webhookEndpointId: 'events',
    });
    expect(component.getFormArray('attached').length).toBe(1);
    expect(component['getCompleteConfiguration'](false).attached[0].data).toBe('signed');
    component['loadConfigurationFromJson']({
      id: 'test',
      description: 'Test request',
      dcql_query: query,
    });
    expect(component.getFormArray('attached').length).toBe(0);
    expect(component.hasRegistrationCertificate).toBe(false);
    component.createOrUpdatePresentation();
    expect(service.createConfiguration.mock.calls[0][0]).toMatchObject({
      attached: [],
      registration_cert: null,
      webhookEndpointId: null,
    });
  });

  it('opens existing complex configurations in direct editing and preserves rules on save', async () => {
    const advanced = {
      credentials: [
        {
          ...query.credentials[0],
          multiple: true,
          trusted_authorities: [{ type: 'openid_federation', values: ['https://trust.example'] }],
        },
      ],
    };
    route.snapshot.params = { id: 'existing' };
    route.snapshot.url = [{ path: 'existing' }, { path: 'edit' }];
    service.getPresentationById.mockResolvedValue({
      id: 'existing',
      description: 'Existing request',
      dcql_query: advanced,
      lifeTime: 600,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.guided).toBe(false);
    expect(component.form.get('id')!.disabled).toBe(true);
    component.toggleGuided();
    component.createOrUpdatePresentation();
    expect(client.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ id: 'existing', dcql_query: advanced, lifeTime: 600 }),
      })
    );
  });

  it('copies a configuration with an editable new ID', async () => {
    route.snapshot.params = { id: 'existing' };
    route.snapshot.url = [{ path: 'existing' }, { path: 'copy' }];
    service.getPresentationById.mockResolvedValue({
      id: 'existing',
      description: 'Existing request',
      dcql_query: query,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.copyMode).toBe(true);
    expect(component.form.get('id')!.value).toBe('existing-copy');
    expect(component.form.get('id')!.enabled).toBe(true);
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-copy', dcql_query: query })
    );
  });

  it('stays an edit page and shows why when the configuration to edit cannot be loaded', async () => {
    route.snapshot.params = { id: 'age-check' };
    route.snapshot.url = [{ path: 'age-check' }, { path: 'edit' }];
    service.getPresentationById.mockRejectedValue({ statusCode: 404, message: 'Not found' });

    fixture.detectChanges();
    await vi.waitFor(() => expect(component.loadingConfig).toBe(false));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(component.create).toBe(false);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load presentation configuration: Not found'
    );
    expect(element.querySelector('form')).toBeNull();
    component.submitPresentation();
    expect(service.createConfiguration).not.toHaveBeenCalled();
  });
});
