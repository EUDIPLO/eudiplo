import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { DcqlQueryEditorComponent } from '../dcql-query-editor/dcql-query-editor.component';
import { By } from '@angular/platform-browser';
import { TenantCredentialCatalogService } from '../issuer-metadata-browser/tenant-credential-catalog.service';
import { EMPTY, of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '@eudiplo/sdk-core';
import { PresentationCreateComponent } from './presentation-create.component';
import { PresentationManagementService } from '../presentation-management.service';
import { EditorComponent } from '../../../utils/editor/editor.component';
import { ThemeService } from '../../../services/theme.service';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { registerFieldFocus } from '../../../common/field-to-fix.util';
import { expectHeadingFocusOnlyAfterRetry } from '../../../common/retry-focus.testing';
import { expectAvailable, expectUnavailable } from '../../../common/unavailable-action.testing';

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

/** What the tenant credential catalog returns; reset before every test. */
let knownCredentials: unknown[] = [];

describe('Verification config editor', () => {
  let component: PresentationCreateComponent;
  let fixture: ComponentFixture<PresentationCreateComponent>;
  let service: {
    createConfiguration: ReturnType<typeof vi.fn>;
    getPresentationById: ReturnType<typeof vi.fn>;
  };
  let route: { snapshot: { params: Record<string, string>; url: { path: string }[] } };

  beforeEach(async () => {
    knownCredentials = [];
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
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: MatDialog, useValue: { open: vi.fn() } },
        {
          provide: TenantCredentialCatalogService,
          useValue: { load: vi.fn(() => Promise.resolve(knownCredentials)) },
        },
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

  it('keeps a stored purpose language the list lacks and starts new ones in English', () => {
    component.addRegistrationCertPurpose('de-DE', 'Altersprüfung');
    component.addRegistrationCertPurpose();

    expect(component.registrationCertPurposeArray.value).toEqual([
      { lang: 'de-DE', content: 'Altersprüfung' },
      { lang: 'en', content: '' },
    ]);
  });

  it('sends a stored purpose language back unchanged, even one never listed', () => {
    (component as any).loadRegistrationCertIntoForm({
      purpose: [{ lang: 'pt-BR', content: 'Verificação de idade' }],
    });

    expect((component as any).buildRegistrationCertFromForm()?.purpose).toEqual([
      { lang: 'pt-BR', content: 'Verificação de idade' },
    ]);
  });

  it('keeps the JWT, purpose and privacy policy together in registration_cert', () => {
    (component as any).loadRegistrationCertIntoForm({
      jwt: 'ey.registration.cert',
      purpose: [{ lang: 'en', content: 'Age check' }],
      privacy_policy: 'https://verifier.example/privacy',
    });

    expect((component as any).buildRegistrationCertFromForm()).toEqual({
      jwt: 'ey.registration.cert',
      purpose: [{ lang: 'en', content: 'Age check' }],
      privacy_policy: 'https://verifier.example/privacy',
    });
  });

  it('reads the purpose and privacy policy of a file that kept them under body', () => {
    (component as any).loadRegistrationCertIntoForm({
      body: {
        purpose: [{ lang: 'en', content: 'Age check' }],
        privacy_policy: 'https://verifier.example/privacy',
      },
    });

    expect((component as any).buildRegistrationCertFromForm()).toEqual({
      purpose: [{ lang: 'en', content: 'Age check' }],
      privacy_policy: 'https://verifier.example/privacy',
    });
  });

  it('says "Purpose only, no certificate" until there is a JWT', () => {
    expect(component.registrationCertSummary).toBe('Not configured');

    (component as any).loadRegistrationCertIntoForm({
      purpose: [{ lang: 'en', content: 'Age check' }],
    });
    expect(component.registrationCertSummary).toBe('Purpose only, no certificate');

    component.form.patchValue({ registrationCertJwt: 'not-a-jwt' });
    expect(component.registrationCertSummary).toContain('Not a valid JWT');

    const part = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
    component.form.patchValue({
      registrationCertJwt: `${part({ alg: 'ES256' })}.${part({ exp })}.c2ln`,
    });
    expect(component.registrationCertSummary).toMatch(/^Active — expires in \d+ days$/);
  });

  it('moves focus to the next purpose after a removal, and to Add Purpose after the last', async () => {
    component.guided = false;
    component.activeStep = 2;
    component.addRegistrationCertPurpose('de', 'Altersprüfung');
    component.addRegistrationCertPurpose('en', 'Age check');
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const contents = () => [
      ...element.querySelectorAll<HTMLInputElement>('input[formcontrolname="content"]'),
    ];
    expect(contents()).toHaveLength(2);

    contents()[0].focus();
    component.removeRegistrationCertPurpose(0);
    fixture.detectChanges();
    await vi.waitFor(() => expect(document.activeElement).toBe(contents()[0]));
    expect(contents()[0].value).toBe('Age check');

    component.removeRegistrationCertPurpose(0);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.textContent).toContain('Add Purpose')
    );
  });

  it('says a changed DCQL query may need a new certificate only while a JWT is set', () => {
    expect(component.dcqlChangedWithCertificate).toBe(false);
    component.form.patchValue({ registrationCertJwt: 'ey.registration.cert' });
    expect(component.dcqlChangedWithCertificate).toBe(false);
    component.queryControl.markAsDirty();
    expect(component.dcqlChangedWithCertificate).toBe(true);
    component.form.patchValue({ registrationCertJwt: '' });
    expect(component.dcqlChangedWithCertificate).toBe(false);
  });

  it('refuses a privacy policy that is no http(s) URL', () => {
    const control = component.form.get('registrationCertPrivacyPolicy')!;
    control.setValue('mailto:privacy@verifier.example');
    expect(control.hasError('url')).toBe(true);
    control.setValue('https://verifier.example/privacy');
    expect(control.valid).toBe(true);
  });

  it('sends no registration_cert when all its fields are empty', () => {
    expect((component as any).buildRegistrationCertFromForm()).toBeNull();
  });

  it('offers the next purpose in a language no purpose has yet', () => {
    component.addRegistrationCertPurpose('en-US', 'Age check');

    expect(component.unusedPurposeLanguage).toBe('de');
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
      registrationCertJwt: 'certificate',
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
    expect(payload).not.toHaveProperty('registrationCertJwt');
    await Promise.resolve();
  });

  it('waits while the configuration is saved: a second click sends nothing', async () => {
    service.createConfiguration.mockReturnValue(new Promise(() => undefined));
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.guided = false;
    fixture.detectChanges();
    const save = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    )!;
    expectAvailable(fixture, save);

    save.click();
    fixture.detectChanges();
    save.click();
    fixture.detectChanges();

    expect(service.createConfiguration).toHaveBeenCalledOnce();
    expectUnavailable(fixture, save, 'Saving the verification config…');
  });

  it('steps back while idle and keeps the guided Back focusable while the configuration is saved', async () => {
    service.createConfiguration.mockReturnValue(new Promise(() => undefined));
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.guided = true;
    component.activeStep = 3;
    component.furthestStep = 3;
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const back = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Back'
    )!;
    expectAvailable(fixture, back);
    back.click();
    expect(component.activeStep).toBe(2);
    component.activeStep = 3;
    fixture.detectChanges();

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    back.click();
    fixture.detectChanges();

    expect(service.createConfiguration).toHaveBeenCalledOnce();
    expect(component.activeStep).toBe(3);
    expectUnavailable(fixture, back, 'Saving the verification config…');
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
    expect(component.validationMessage).toBe('Check the highlighted fields in Settings.');
  });

  it('shows the field to fix after a refused Continue', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.activeStep).toBe(0);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Check the highlighted fields in Name.'
    );
    expect(document.activeElement).toBe(element.querySelector('input[formcontrolname="id"]'));
  });

  it('shows the Settings field to fix after a refused Save on Review', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.form.patchValue({ lifeTime: 0 });
    component.guided = false;
    component.activeStep = 3;
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(service.createConfiguration).not.toHaveBeenCalled();
    expect(component.activeStep).toBe(2);
    expect(document.activeElement).toBe(element.querySelector('input[formcontrolname="lifeTime"]'));
  });

  it('points at the query builder when the query keeps Continue from the Credentials step', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    component.form.patchValue({ id: 'test', description: 'Test request' });
    component.nextStep();
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.activeStep).toBe(1);
    expect(component.validationMessage).toBe('Check the errors in Credentials.');
    expect(
      element
        .querySelector('[data-step="1"] app-dcql-query-editor')
        ?.contains(document.activeElement)
    ).toBe(true);
  });

  it('refuses an attachment that names a removed credential and shows where to fix it', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.addAttachment();
    component
      .getFormArray('attached')
      .at(0)
      .patchValue({ format: 'dc+sd-jwt', data: 'signed', credential_ids: ['gone'] });
    component.guided = false;
    component.activeStep = 3;
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(service.createConfiguration).not.toHaveBeenCalled();
    expect(component.activeStep).toBe(2);
    expect(component.validationMessage).toContain('references missing credential "gone"');
    expect(document.activeElement).toBe(
      element.querySelector('[data-step="2"] [formarrayname="attached"] input')
    );
  });

  it('refuses transaction data that names a removed credential and focuses its editor', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.form.patchValue({
      transaction_data: JSON.stringify([{ type: 'payment', credential_ids: ['gone'] }]),
    });
    component.guided = false;
    // Settings is rendered once shown, and stays rendered.
    component.activeStep = 2;
    fixture.detectChanges();
    await fixture.whenStable();
    component.activeStep = 3;
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const transactionEditor = element.querySelector<HTMLElement>(
      '[data-step="2"] app-editor[formcontrolname="transaction_data"]'
    )!;
    const focus = vi.fn();
    registerFieldFocus(transactionEditor, focus);

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(service.createConfiguration).not.toHaveBeenCalled();
    expect(component.activeStep).toBe(2);
    expect(component.validationMessage).toContain(
      'Transaction data references missing credential "gone"'
    );
    expect(focus).toHaveBeenCalled();
  });

  it('focuses the field to fix in its own step, also after the Credentials step was shown', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.nextStep();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.activeStep).toBe(1);
    component.nextStep();
    component.form.patchValue({ lifeTime: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.activeStep).toBe(2);
    expect(document.activeElement).toBe(element.querySelector('input[formcontrolname="lifeTime"]'));
  });

  it('moves focus to the next attachment after a removal, and to Add Attachment after the last', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.guided = false;
    component.activeStep = 2;
    component.addAttachment();
    component.addAttachment();
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const rows = () => [...element.querySelectorAll('[data-step="2"] app-credential-ids')];
    rows()[0].querySelector('input')!.focus();

    component.removeAttachment(0);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(rows()[0].querySelector('input'));

    component.removeAttachment(0);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement?.textContent).toContain('Add Attachment');
  });

  it('opens an edit page without unsaved changes', async () => {
    route.snapshot.params = { id: 'existing' };
    route.snapshot.url = [{ path: 'existing' }, { path: 'edit' }];
    service.getPresentationById.mockResolvedValue({
      id: 'existing',
      description: 'Existing request',
      dcql_query: query,
      transaction_data: [{ type: 'payment', credential_ids: ['pid'] }],
      attached: [{ format: 'dc+sd-jwt', data: 'signed', credential_ids: ['pid'] }],
      registration_cert: { purpose: [{ lang: 'en', content: 'Age check' }] },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.form.dirty).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.change-state')?.textContent?.trim()
    ).toBe('No changes');
  });

  it('counts added and removed list entries and an imported query as unsaved changes', () => {
    fill();
    component.form.markAsPristine();
    component.addPurposeByUser();
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    component.removeRegistrationCertPurpose(0);
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    component.addAttachmentByUser();
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    component.removeAttachment(0);
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    const dialog = TestBed.inject(MatDialog) as unknown as { open: ReturnType<typeof vi.fn> };
    dialog.open.mockReturnValue({ afterClosed: () => of(query) });
    component.importFromIssuer();
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    dialog.open.mockReturnValue({ afterClosed: () => of(query) });
    component.importFromCredentialConfig();
    expect(dialog.open).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ data: { source: 'tenant' } })
    );
    expect(component.form.dirty).toBe(true);

    component.form.markAsPristine();
    dialog.open.mockReturnValue({ afterClosed: () => of({ dcqlQuery: query }) });
    component.importFromSchemaMetadata();
    expect(component.form.dirty).toBe(true);
  });

  it('shows every setting in its own section, without panels to expand', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.guided = false;
    component.activeStep = 2;
    fixture.detectChanges();
    await fixture.whenStable();
    const settings = (fixture.nativeElement as HTMLElement).querySelector('[data-step="2"]')!;

    expect(
      [...settings.querySelectorAll('section[aria-labelledby] h2')].map((heading) =>
        heading.textContent?.trim()
      )
    ).toEqual([
      'Request and verification options',
      'Registration certificate',
      'Application integration',
      'Transaction data',
    ]);
    expect(settings.querySelector('mat-expansion-panel')).toBeNull();
    for (const name of [
      'lifeTime',
      'statusCheckMode',
      'accessKeyChainId',
      'redirectUri',
      'allowedOrigins',
      'registrationCertJwt',
      'registrationCertPrivacyPolicy',
      'webhookEndpointId',
    ]) {
      expect(settings.querySelector(`[formcontrolname="${name}"]`), name).not.toBeNull();
    }
  });

  it('names the verification config in the heading, Save and the change state', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fill();
    component.guided = false;
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Create Verification Config');
    expect(element.querySelector('button[type="submit"]')?.textContent).toContain(
      'Create Verification Config'
    );
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('');
    component.form.markAsDirty();
    fixture.detectChanges();
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('Unsaved changes');
  });

  it('says the verification config was created', async () => {
    fill();
    component.activeStep = 3;
    component.submitPresentation();
    await vi.waitFor(() => expect(component.saving).toBe(false));
    expect(TestBed.inject(MatSnackBar).open).toHaveBeenCalledWith(
      'Verification config created',
      'Close',
      { duration: 3000 }
    );
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

  it('saves allowed origins entered one per line as a list', () => {
    fill();
    component.form.patchValue({
      allowedOrigins: 'https://shop.example\n\n  http://localhost:4200  ',
    });
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOrigins: ['https://shop.example', 'http://localhost:4200'],
      })
    );
  });

  it('also splits allowed origins at commas and shows the saved list for review', () => {
    fill();
    component.form.patchValue({ allowedOrigins: 'https://a.example, https://b.example' });
    expect(component.allowedOriginsSummary).toBe('https://a.example, https://b.example');
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigins: ['https://a.example', 'https://b.example'] })
    );
  });

  it('reviews an empty origin list as not restricted', () => {
    fill();
    component.form.patchValue({ allowedOrigins: '  \n ' });
    expect(component.allowedOriginsSummary).toBe('Not restricted');
  });

  it('clears allowed origins with null and leaves them out of exports', () => {
    fill();
    component.form.patchValue({ allowedOrigins: '  ' });
    expect(component['getCompleteConfiguration'](true).allowedOrigins).toBeUndefined();
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigins: null })
    );
  });

  it('names at most two invalid origins', () => {
    const control = component.form.get('allowedOrigins')!;
    control.setValue(
      'https://a.example/\nhttps://b.example/\nhttps://c.example/\nhttps://d.example/'
    );
    expect(control.getError('invalidOrigins')).toBe(
      'https://a.example/, https://b.example/ and 2 more'
    );
  });

  it('refuses more than 100 allowed origins', () => {
    const control = component.form.get('allowedOrigins')!;
    control.setValue(
      Array.from({ length: 101 }, (_, index) => `https://${index}.example`).join('\n')
    );
    expect(control.hasError('tooManyOrigins')).toBe(true);
  });

  it('refuses allowed origins that are not origins', () => {
    fill();
    const control = component.form.get('allowedOrigins')!;
    control.setValue('https://shop.example/checkout\nhttps://ok.example');
    expect(control.getError('invalidOrigins')).toBe('https://shop.example/checkout');
    component.activeStep = 3;
    component.createOrUpdatePresentation();
    expect(service.createConfiguration).not.toHaveBeenCalled();
    expect(component.activeStep).toBe(2);
  });

  it('loads allowed origins from JSON into the form, one per line', () => {
    fill();
    component['loadConfigurationFromJson']({
      id: 'test',
      description: 'Test request',
      dcql_query: query,
      allowedOrigins: ['https://shop.example', 'https://app.example'],
    });
    expect(component.form.get('allowedOrigins')!.value).toBe(
      'https://shop.example\nhttps://app.example'
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

  it("passes the tenant's credential configs to the query builder for hints", async () => {
    const pid = {
      id: 'pid',
      format: 'dc+sd-jwt',
      displayName: 'PID',
      vct: 'urn:pid',
      claims: [{ path: ['given_name'], displayName: 'Given name', mandatory: false }],
    };
    knownCredentials = [pid];
    component.ngOnInit();
    await vi.waitFor(() => expect(component.knownCredentials).toEqual([pid]));
    fill();
    component.activeStep = 1;
    component.furthestStep = 1;
    fixture.detectChanges();

    const builder = fixture.debugElement.query(By.directive(DcqlQueryEditorComponent));
    expect(builder.componentInstance.knownCredentials).toEqual([pid]);
  });

  it('loads the credential configs again when the user returns to the tab', async () => {
    const pid = { id: 'pid', format: 'dc+sd-jwt', displayName: 'PID', vct: 'urn:pid', claims: [] };
    knownCredentials = [pid];

    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(component.knownCredentials).toEqual([pid]));
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
    expect(component.registrationCertSummary).toBe('Not configured');
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
      allowedOrigins: ['https://shop.example', 'https://app.example'],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.form.get('allowedOrigins')!.value).toBe(
      'https://shop.example\nhttps://app.example'
    );
    expect(component.guided).toBe(false);
    expect(component.form.get('id')!.disabled).toBe(true);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Edit Verification Config');
    expect(element.querySelector('button[type="submit"]')?.textContent).toContain('Save Changes');
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('No changes');
    component.toggleGuided();
    component.createOrUpdatePresentation();
    expect(client.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          id: 'existing',
          dcql_query: advanced,
          lifeTime: 600,
          allowedOrigins: ['https://shop.example', 'https://app.example'],
        }),
      })
    );
    await vi.waitFor(() =>
      expect(TestBed.inject(MatSnackBar).open).toHaveBeenCalledWith(
        'Verification config saved',
        'Close',
        { duration: 3000 }
      )
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
      'Failed to load verification config: Not found'
    );
    expect(element.querySelector('form')).toBeNull();
    component.submitPresentation();
    expect(service.createConfiguration).not.toHaveBeenCalled();
  });

  describe('back link', () => {
    const backLink = () =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.back-link')!;

    it('leads a new configuration back to the list', () => {
      fixture.detectChanges();
      expect(backLink().textContent?.trim()).toContain('Verification Configs');
      expect(backLink().getAttribute('aria-label')).toBe('Back to Verification Configs');
      expect(backLink().getAttribute('href')).toBe('/');
    });

    it('leads an edit back to the configuration, also while it loads', () => {
      route.snapshot.params = { id: 'age-check' };
      route.snapshot.url = [{ path: 'age-check' }, { path: 'edit' }];
      service.getPresentationById.mockReturnValue(new Promise(() => undefined));
      fixture.detectChanges();

      expect(component.loadingConfig).toBe(true);
      expect(backLink().getAttribute('aria-label')).toBe('Back to age-check');
      expect(component.backLink).toEqual(['../']);
    });

    it('keeps Cancel on the page while a save runs', () => {
      fixture.detectChanges();
      component.saving = true;
      fixture.detectChanges();
      const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      const cancel = [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          '.action-bar button'
        ),
      ].find((button) => button.textContent?.trim() === 'Cancel')!;

      expect(cancel.getAttribute('aria-disabled')).toBe('true');
      cancel.click();
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('leads a copy back to the list', async () => {
      route.snapshot.params = { id: 'existing' };
      route.snapshot.url = [{ path: 'existing' }, { path: 'copy' }];
      service.getPresentationById.mockResolvedValue({
        id: 'existing',
        description: 'Existing request',
        dcql_query: query,
      });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(backLink().getAttribute('aria-label')).toBe('Back to Verification Configs');
      expect(backLink().getAttribute('href')).toBe('/');
      const cancel = [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
          '.action-bar button'
        ),
      ].find((button) => button.textContent?.trim() === 'Cancel');
      expect(cancel).toBeDefined();
      expect(component.backLink).toEqual(['../../']);
    });
  });

  describe('JSON View', () => {
    let open: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      open = TestBed.inject(MatDialog).open as ReturnType<typeof vi.fn>;
      open.mockReturnValue({ afterClosed: () => EMPTY });
    });

    function jsonViewButton(): HTMLButtonElement {
      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
      return [...buttons].find((button) => button.textContent?.includes('JSON View'))!;
    }

    it('opens only with the loaded configuration, stays focusable and says why it waits', async () => {
      route.snapshot.params = { id: 'age-check' };
      route.snapshot.url = [{ path: 'age-check' }, { path: 'edit' }];
      service.getPresentationById
        .mockRejectedValueOnce({ statusCode: 500, message: 'Unavailable' })
        .mockResolvedValue({ id: 'age-check', description: 'Age check', dcql_query: query });

      fixture.detectChanges();
      expect(component.jsonViewUnavailableReason).toBe(
        'Wait until the verification config has loaded'
      );
      // The button stays clickable while it cannot be used, so the handler checks again.
      component.viewAsJson();
      await vi.waitFor(() => expect(component.loadingConfig).toBe(false));
      fixture.detectChanges();
      expect(component.jsonViewUnavailableReason).toBe(
        'Retry loading the verification config before opening JSON View'
      );
      expect(jsonViewButton().getAttribute('aria-disabled')).toBe('true');
      expect(jsonViewButton().disabled).toBe(false);
      component.viewAsJson();
      expect(open).not.toHaveBeenCalled();

      component.loadConfigForEdit();
      await vi.waitFor(() => expect(component.loadingConfig).toBe(false));
      fixture.detectChanges();
      expect(component.jsonViewUnavailableReason).toBe('');
      expect(jsonViewButton().getAttribute('aria-disabled')).not.toBe('true');
      component.viewAsJson();
      expect(open).toHaveBeenCalledOnce();
    });

    it('opens right away when creating a configuration, but not while it saves', async () => {
      let rejectSave!: (error: unknown) => void;
      service.createConfiguration.mockReturnValue(
        new Promise((_, reject) => (rejectSave = reject))
      );
      fixture.detectChanges();
      expect(service.getPresentationById).not.toHaveBeenCalled();
      expect(component.loadingConfig).toBe(false);
      expect(component.jsonViewUnavailableReason).toBe('');
      component.viewAsJson();
      expect(open).toHaveBeenCalledOnce();

      // A successful save leaves the screen, so the dialog would stay open over the next one.
      fill();
      component.createOrUpdatePresentation();
      expect(service.createConfiguration).toHaveBeenCalledOnce();
      expect(component.jsonViewUnavailableReason).toBe(
        'Wait until the verification config has been saved'
      );
      component.viewAsJson();
      expect(open).toHaveBeenCalledOnce();
      rejectSave({ statusCode: 500, message: 'Unavailable' });
      await vi.waitFor(() => expect(component.saving).toBe(false));
      expect(component.jsonViewUnavailableReason).toBe('');
    });
  });

  it('moves focus to the heading only after a retry loads the configuration', async () => {
    const stored = { id: 'age-check', description: 'Age check', dcql_query: query };
    route.snapshot.params = { id: 'age-check' };
    route.snapshot.url = [{ path: 'age-check' }, { path: 'edit' }];
    service.getPresentationById
      .mockResolvedValueOnce(stored)
      .mockRejectedValueOnce({ statusCode: 500, message: 'Unavailable' })
      .mockResolvedValue(stored);

    await expectHeadingFocusOnlyAfterRetry(
      fixture,
      () => component.loadConfigForEdit(),
      () => !component.loadingConfig,
      'h1'
    );
  });
});
