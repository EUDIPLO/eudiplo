import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { MatSelectHarness } from '@angular/material/select/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipHarness } from '@angular/material/tooltip/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import {
  OTHER_TEST_ROOT_CERTIFICATE_PEM,
  pemToBase64Der,
  TEST_ROOT_CERTIFICATE_PEM,
} from '../../utils/certificate-validator.testing';
import { SchemaService } from '../schema.service';
import { SchemaCreateComponent } from './schema-create.component';
import { errorSnackBarDuration } from '../../utils/error-snackbar';
import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';

/** The arguments of an error snackbar with this text. */
const errorSnackBar = (text: string) =>
  [text, 'Close', { duration: errorSnackBarDuration(text) }] as const;

describe('SchemaCreateComponent', () => {
  let component: SchemaCreateComponent;
  let publishSchemaMetadata: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    publishSchemaMetadata = vi.fn().mockResolvedValue({ id: 'schema-1' });
    openSnackBar = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: new Map() } } },
      ],
    });
    component = TestBed.runInInjectionContext(
      () =>
        new SchemaCreateComponent(
          new FormBuilder(),
          { publishSchemaMetadata } as any,
          {} as any,
          { open: openSnackBar } as any
        )
    );

    component.credentialConfigs = [
      { id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } } as any,
    ];
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.trustLists = [{ id: 'tl-1' } as any];
    component.importTrustListIds.setValue(['tl-1']);
    component.syncTrustedAuthoritiesFromSelection();
    component.composeForm.patchValue({
      name: 'German PID',
      version: '1.0.0',
      rulebookURI: 'https://rules.example/pid.md',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      category: 'identity',
      tags: ['pid', 'eudi'],
    });
  });

  it('publishes category and tags with the schema metadata config', async () => {
    await component.submit();

    expect(publishSchemaMetadata).toHaveBeenCalledOnce();
    const [config, , credentialConfigId] = publishSchemaMetadata.mock.calls[0];
    expect(config).toMatchObject({ category: 'identity', tags: ['pid', 'eudi'] });
    expect(credentialConfigId).toBe('pid');
  });

  it('shows the message of a rejected publish request', async () => {
    publishSchemaMetadata.mockRejectedValue({
      statusCode: 400,
      message: 'config.rulebookURI is required when publishing new schema metadata',
    });

    await component.submit();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to submit schema: config.rulebookURI is required when publishing new schema metadata'
      )
    );
    expect(component.loading).toBe(false);
  });
});

describe('SchemaCreateComponent loading its sources', () => {
  const pendingFetch = () => new Promise<Response>(() => undefined);
  let loadConfigurations: ReturnType<typeof vi.fn>;
  let getVocabularies: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;

  function respondToTrustLists(status: number, body: unknown) {
    client.setConfig({
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
  }

  function createComponent() {
    return TestBed.runInInjectionContext(
      () =>
        new SchemaCreateComponent(
          new FormBuilder(),
          { getVocabularies } as any,
          { loadConfigurations } as any,
          { open: openSnackBar } as any
        )
    );
  }

  beforeEach(() => {
    loadConfigurations = vi
      .fn()
      .mockResolvedValue([{ id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } }]);
    getVocabularies = vi.fn().mockResolvedValue({
      version: '1',
      categories: [{ code: 'identity', label: 'Identity', status: 'active' }],
      tags: [{ code: 'pid', label: 'PID', status: 'active' }],
    });
    openSnackBar = vi.fn();
    respondToTrustLists(200, [{ id: 'tl-1' }]);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    });
  });

  afterEach(() => {
    client.setConfig({ fetch: pendingFetch });
  });

  it('keeps credential configs and trust lists when the registrar vocabularies fail', async () => {
    getVocabularies.mockRejectedValue({
      statusCode: 400,
      message: 'Registrar is not configured for this tenant',
    });
    const component = createComponent();
    component.credentialConfigId = 'pid';

    await component.loadData();

    expect(component.credentialConfigs.map((c) => c.id)).toEqual(['pid']);
    expect(component.importSchemaConfigIds.value).toEqual(['pid']);
    expect(component.schemaURIs.length).toBe(1);
    expect(component.trustLists.map((t) => t.id)).toEqual(['tl-1']);
    expect(component.loadState).toEqual({
      credentialConfigs: 'loaded',
      trustLists: 'loaded',
      vocabularies: 'failed',
    });
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load the registrar vocabulary: Registrar is not configured for this tenant'
      )
    );
  });

  it('names every source that failed to load', async () => {
    loadConfigurations.mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' });
    respondToTrustLists(403, { statusCode: 403, message: 'Forbidden resource' });
    const component = createComponent();

    await component.loadData();

    expect(component.categoryVocabularies.map((v) => v.code)).toEqual(['identity']);
    expect(component.loadState).toEqual({
      credentialConfigs: 'failed',
      trustLists: 'failed',
      vocabularies: 'loaded',
    });
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load credential configs: Forbidden resource; Failed to load trust lists: Forbidden resource'
      )
    );
  });

  it('names the source when the backend message already says what failed', async () => {
    getVocabularies.mockRejectedValue({
      statusCode: 502,
      message: 'Failed to authenticate with registrar: the OIDC provider could not be reached',
    });

    await createComponent().loadData();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load the registrar vocabulary: ' +
          'Failed to authenticate with registrar: the OIDC provider could not be reached'
      )
    );
  });

  it('names each source when the backend cannot be reached', async () => {
    loadConfigurations.mockRejectedValue(new TypeError('Failed to fetch'));
    getVocabularies.mockRejectedValue(new TypeError('Failed to fetch'));
    client.setConfig({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await createComponent().loadData();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load credential configs, trust lists, and the registrar vocabulary: ' +
          'the backend could not be reached. Check the connection and try again.'
      )
    );
  });

  it('gives the unreachable hint once, after the reasons the backend gave', async () => {
    loadConfigurations.mockRejectedValue(new TypeError('Failed to fetch'));
    respondToTrustLists(403, { statusCode: 403, message: 'Forbidden resource' });
    getVocabularies.mockRejectedValue(new TypeError('Failed to fetch'));

    await createComponent().loadData();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load trust lists: Forbidden resource; ' +
          'Failed to load credential configs and the registrar vocabulary: ' +
          'the backend could not be reached. Check the connection and try again.'
      )
    );
  });

  it('shows no snackbar when every source loads', async () => {
    await createComponent().loadData();

    expect(openSnackBar).not.toHaveBeenCalled();
  });

  function createFixture() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SchemaCreateComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
        { provide: SchemaService, useValue: { getVocabularies } },
        { provide: CredentialConfigService, useValue: { loadConfigurations } },
      ],
    });
    return TestBed.createComponent(SchemaCreateComponent);
  }

  /** Renders the form and returns its text once `ngOnInit` has loaded the sources. */
  async function render(): Promise<string> {
    const fixture = createFixture();
    const loadData = vi.spyOn(fixture.componentInstance, 'loadData');
    fixture.detectChanges();
    await loadData.mock.results[0].value;
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('says in the hints that sources are loading, and fills each in as it answers', async () => {
    const pending = () => new Promise<never>(() => undefined);
    getVocabularies.mockImplementation(pending);
    client.setConfig({ fetch: pendingFetch });
    const fixture = createFixture();

    fixture.detectChanges();
    let text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Loading credential configs…');
    expect(text).toContain('Loading trust lists…');
    expect(text).toContain('Loading categories…');
    expect(text).toContain('Loading tags…');
    expect(text).not.toContain('No credential configs available.');

    // The credential configs answer while the registrar and trust lists are still pending.
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loadState.credentialConfigs).toBe('loaded')
    );
    fixture.detectChanges();
    text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Loading credential configs…');
    expect(fixture.componentInstance.credentialConfigs.map((c) => c.id)).toEqual(['pid']);
    expect(text).toContain('Loading tags…');
  });

  it('says in the hints that sources failed instead of claiming none exist', async () => {
    loadConfigurations.mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' });
    respondToTrustLists(403, { statusCode: 403, message: 'Forbidden resource' });
    getVocabularies.mockRejectedValue({ statusCode: 503, message: 'Registrar unreachable' });

    const text = await render();

    expect(text).toContain('Could not load credential configs.');
    expect(text).toContain('Could not load trust lists.');
    expect(text).toContain('Could not load categories from the registrar.');
    expect(text).toContain('Could not load tags from the registrar.');
    expect(text).not.toContain('No credential configs available.');
    expect(text).not.toContain('No trust lists available.');
    expect(text).not.toContain('No predefined categories available.');
    expect(text).not.toContain('No predefined tags available.');
  });

  it('says in the hints that nothing exists when the sources load empty', async () => {
    loadConfigurations.mockResolvedValue([]);
    respondToTrustLists(200, []);
    getVocabularies.mockResolvedValue({ version: '1', categories: [], tags: [] });

    const text = await render();

    expect(text).toContain('No credential configs available.');
    expect(text).toContain('No trust lists available.');
    expect(text).toContain('No predefined categories available.');
    expect(text).toContain('No predefined tags available.');
    expect(text).not.toContain('Could not load');
    expect(openSnackBar).not.toHaveBeenCalled();
  });
});

describe('SchemaCreateComponent required fields', () => {
  const root = pemToBase64Der(TEST_ROOT_CERTIFICATE_PEM);
  const other = pemToBase64Der(OTHER_TEST_ROOT_CERTIFICATE_PEM);
  let publishSchemaMetadata: ReturnType<typeof vi.fn>;
  let loadConfigurations: ReturnType<typeof vi.fn>;
  /** Answer of the backend to the trust-list request. */
  let trustLists: { status: number; body: unknown };

  async function render() {
    client.setConfig({
      fetch: async () =>
        new Response(JSON.stringify(trustLists.body), {
          status: trustLists.status,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    TestBed.configureTestingModule({
      imports: [SchemaCreateComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: SchemaService,
          useValue: {
            getVocabularies: async () => ({ version: '1', categories: [], tags: [] }),
            publishSchemaMetadata,
          },
        },
        { provide: CredentialConfigService, useValue: { loadConfigurations } },
      ],
    });
    const fixture = TestBed.createComponent(SchemaCreateComponent);
    const loadData = vi.spyOn(fixture.componentInstance, 'loadData');
    fixture.detectChanges();
    await loadData.mock.results[0].value;
    fixture.componentInstance.composeForm.patchValue({
      name: 'German PID',
      version: '1.0.0',
      rulebookURI: 'https://rules.example/pid.md',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
    });
    fixture.detectChanges();
    return fixture;
  }

  function text(fixture: { nativeElement: HTMLElement }): string {
    return (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ');
  }

  function submitButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    return [...fixture.nativeElement.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Submit')
    )!;
  }

  beforeEach(() => {
    publishSchemaMetadata = vi.fn().mockResolvedValue({ id: 'schema-1' });
    loadConfigurations = vi
      .fn()
      .mockResolvedValue([{ id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } }]);
    trustLists = { status: 200, body: [{ id: 'tl-1' }] };
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  /** The field that holds focus, by its label. */
  function focusedLabel(): string | undefined {
    return document.activeElement
      ?.closest('mat-form-field')
      ?.querySelector('mat-label')
      ?.textContent?.trim();
  }

  it('says what is missing when Submit is pressed without schema URI and trusted authority', async () => {
    const fixture = await render();
    // The component's own injector provides the snack bar it uses.
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    expect(text(fixture)).not.toContain('At least one schema URI is required');

    const submit = submitButton(fixture);
    expectAvailable(fixture, submit);
    submit.focus();
    submit.click();

    // The select that fills the schema URIs shows their error, so it takes the focus.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(focusedLabel()).toBe('Select credential configs');
    });
    expect(publishSchemaMetadata).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('At least one schema URI is required.');
    expect(text(fixture)).toContain('At least one trusted authority is required.');
    expect(open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Schema URIs, Trusted Authorities.',
      'Close',
      expect.anything()
    );
  });

  it('focuses the first missing field and names each part of the form that holds one', async () => {
    const fixture = await render();
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    const component = fixture.componentInstance;
    component.composeForm.patchValue({ version: '' });
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.addX509TrustAnchor();
    fixture.detectChanges();

    submitButton(fixture).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('version');
    });
    expect(open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Compose Schema, Trusted Authorities.',
      'Close',
      expect.anything()
    );
    expect(publishSchemaMetadata).not.toHaveBeenCalled();
  });

  it('focuses Add Root Certificate when no trust list can be selected', async () => {
    trustLists = { status: 200, body: [] };
    const fixture = await render();
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    fixture.detectChanges();

    submitButton(fixture).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.textContent).toContain('Add Root Certificate');
    });
    expect(open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Trusted Authorities.',
      'Close',
      expect.anything()
    );
    expect(publishSchemaMetadata).not.toHaveBeenCalled();
  });

  it('focuses an empty root certificate when it is the only field left to fix', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.addX509TrustAnchor();
    fixture.detectChanges();

    submitButton(fixture).click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.id).toBe('root-certificate-1');
    });
    expect(publishSchemaMetadata).not.toHaveBeenCalled();
  });

  it('flags a trust-list select that was left empty, and clears it for a root certificate', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;

    component.importTrustListIds.markAsTouched();
    fixture.detectChanges();
    expect(text(fixture)).toContain('At least one trusted authority is required.');
    expect(text(fixture)).not.toContain('At least one schema URI is required');

    component.addX509TrustAnchor();
    fixture.detectChanges();
    expect(text(fixture)).not.toContain('At least one trusted authority is required.');
  });

  it('labels a root certificate field once, through its mat-label', async () => {
    const fixture = await render();
    fixture.componentInstance.addX509TrustAnchor();
    fixture.detectChanges();

    const labels = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'label[for="root-certificate-1"]'
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain('Root certificate 1 (PEM or base64 DER)');
  });

  it('numbers root certificates among themselves, behind the selected trust lists', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    const element = fixture.nativeElement as HTMLElement;
    component.addX509TrustAnchor();
    component.addX509TrustAnchor();
    component.trustedAuthorities.at(0).patchValue({ value: root });
    component.trustedAuthorities.at(1).patchValue({ value: other });
    component.importTrustListIds.setValue(['tl-1']);
    component.syncTrustedAuthoritiesFromSelection();
    fixture.detectChanges();

    const fields = () =>
      [...element.querySelectorAll<HTMLTextAreaElement>('textarea[id^="root-certificate-"]')].map(
        (textarea) => ({
          label: element.querySelector(`label[for="${textarea.id}"]`)?.textContent?.trim(),
          value: textarea.value,
        })
      );
    const removeButtons = () => [
      ...element.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Remove root certificate"]'
      ),
    ];

    expect(fields()).toEqual([
      { label: 'Root certificate 1 (PEM or base64 DER)', value: root },
      { label: 'Root certificate 2 (PEM or base64 DER)', value: other },
    ]);
    expect(removeButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove root certificate 1',
      'Remove root certificate 2',
    ]);
    const tooltipText = async (name: string) => {
      const tooltip = await TestbedHarnessEnvironment.loader(fixture).getHarness(
        MatTooltipHarness.with({ selector: `[aria-label="${name}"]` })
      );
      await tooltip.show();
      return tooltip.getTooltipText();
    };
    expect(await tooltipText('Remove root certificate 2')).toBe('Remove root certificate 2');

    removeButtons()[0].click();
    fixture.detectChanges();

    expect(fields()).toEqual([{ label: 'Root certificate 1 (PEM or base64 DER)', value: other }]);
    expect(removeButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove root certificate 1',
    ]);
    expect(await tooltipText('Remove root certificate 1')).toBe('Remove root certificate 1');

    // The remaining row still edits its own entry, behind the trust list.
    const textarea = element.querySelector<HTMLTextAreaElement>('#root-certificate-1')!;
    textarea.value = TEST_ROOT_CERTIFICATE_PEM;
    textarea.dispatchEvent(new Event('input'));
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await component.submit();

    expect(publishSchemaMetadata.mock.calls[0][0].trustedAuthorities).toEqual([
      { trustListId: 'tl-1' },
      { frameworkType: 'x509', value: root },
    ]);
  });

  it('flags a root certificate that is not base64 DER at its field, without sending it', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.addX509TrustAnchor();
    component.trustedAuthorities.at(0).patchValue({ value: 'not a certificate' });
    const fieldText = () =>
      (fixture.nativeElement as HTMLElement)
        .querySelector('#root-certificate-1')!
        .closest('mat-form-field')!.textContent;

    submitButton(fixture).click();
    fixture.detectChanges();

    expect(publishSchemaMetadata).not.toHaveBeenCalled();
    expect(fieldText()).toContain('Must be a base64-encoded DER or PEM certificate.');
    expect(fieldText()).not.toContain('Paste the root certificate');

    // Selecting a trust list afterwards keeps the entry and its error.
    component.importTrustListIds.setValue(['tl-1']);
    component.syncTrustedAuthoritiesFromSelection();
    fixture.detectChanges();

    expect(fieldText()).toContain('Must be a base64-encoded DER or PEM certificate.');
    submitButton(fixture).click();
    fixture.detectChanges();
    expect(publishSchemaMetadata).not.toHaveBeenCalled();
  });

  it('flags a pasted certificate chain at its field, without sending it', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.addX509TrustAnchor();
    // A fullchain.pem: the first certificate's base64 has no padding, so
    // without the PEM armor the two read as one base64 value.
    component.trustedAuthorities.at(0).patchValue({
      value: TEST_ROOT_CERTIFICATE_PEM + OTHER_TEST_ROOT_CERTIFICATE_PEM,
    });
    const fieldText = () =>
      (fixture.nativeElement as HTMLElement)
        .querySelector('#root-certificate-1')!
        .closest('mat-form-field')!
        .textContent!.replace(/\s+/g, ' ');

    submitButton(fixture).click();
    fixture.detectChanges();

    expect(publishSchemaMetadata).not.toHaveBeenCalled();
    expect(fieldText()).toContain('Contains 2 certificates. Paste only the root certificate.');
    expect(fieldText()).not.toContain('Must be a base64-encoded DER or PEM certificate.');

    component.trustedAuthorities.at(0).patchValue({ value: OTHER_TEST_ROOT_CERTIFICATE_PEM });
    fixture.detectChanges();

    expect(fieldText()).not.toContain('Contains 2 certificates');
  });

  it('sends a pasted PEM root certificate as base64 DER', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.addX509TrustAnchor();
    component.trustedAuthorities.at(0).patchValue({ value: OTHER_TEST_ROOT_CERTIFICATE_PEM });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await component.submit();

    expect(publishSchemaMetadata.mock.calls[0][0].trustedAuthorities).toEqual([
      { frameworkType: 'x509', value: other },
    ]);
  });

  it('waits while the schema is submitted: a second click sends nothing', async () => {
    publishSchemaMetadata.mockReturnValue(new Promise(() => undefined));
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.importTrustListIds.setValue(['tl-1']);
    component.syncTrustedAuthoritiesFromSelection();
    fixture.detectChanges();
    const submit = submitButton(fixture);
    expectAvailable(fixture, submit);

    submit.click();
    fixture.detectChanges();
    submit.click();
    fixture.detectChanges();

    expect(publishSchemaMetadata).toHaveBeenCalledOnce();
    expectUnavailable(fixture, submit, 'Submitting the schema…');
  });

  it('does not navigate after a submit that finishes once the user has left', async () => {
    let finishPublish!: (entry: unknown) => void;
    publishSchemaMetadata.mockReturnValue(new Promise((resolve) => (finishPublish = resolve)));
    const fixture = await render();
    const component = fixture.componentInstance;
    component.importSchemaConfigIds.setValue(['pid']);
    component.syncSchemaURIsFromSelection();
    component.importTrustListIds.setValue(['tl-1']);
    component.syncTrustedAuthoritiesFromSelection();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const submitting = component.submit();
    fixture.destroy();
    finishPublish({ id: 'schema-1' });
    await submitting;

    expect(publishSchemaMetadata).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('names every missing required field after Submit', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.composeForm.patchValue({
      name: '',
      version: '',
      rulebookURI: '',
      attestationLoS: '',
      bindingType: '',
    });
    component.addX509TrustAnchor();

    submitButton(fixture).click();
    fixture.detectChanges();

    const page = text(fixture);
    expect(page).toContain('Version is required.');
    expect(page).not.toContain('Must be a valid semantic version');
    expect(page).toContain('Rulebook URI is required.');
    expect(page).toContain('Attestation LoS is required.');
    expect(page).toContain('Binding type is required.');
    expect(page).toContain('Name is required.');
    expect(page).toContain('Paste the root certificate or remove this entry.');
  });

  it('keeps saying why a select is empty when Submit marks it as missing', async () => {
    loadConfigurations.mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' });
    trustLists = { status: 200, body: [] };
    const fixture = await render();

    submitButton(fixture).click();
    fixture.detectChanges();

    expect(text(fixture)).toContain(
      'At least one schema URI is required. The credential configs could not be loaded.'
    );
    expect(text(fixture)).toContain(
      'At least one trusted authority is required. No trust lists exist; add a root certificate.'
    );
  });

  it('says to create a credential config first when none exist', async () => {
    loadConfigurations.mockResolvedValue([]);
    const fixture = await render();

    submitButton(fixture).click();
    fixture.detectChanges();

    expect(text(fixture)).toContain(
      'At least one schema URI is required. Create a credential config first.'
    );
    expect(text(fixture)).toContain(
      'At least one trusted authority is required. Select a trust list or add a root certificate.'
    );
  });

  it('suggests a root certificate when the trust lists could not be loaded', async () => {
    trustLists = { status: 403, body: { statusCode: 403, message: 'Forbidden resource' } };
    const fixture = await render();

    submitButton(fixture).click();
    fixture.detectChanges();

    expect(text(fixture)).toContain(
      'At least one trusted authority is required. The trust lists could not be loaded; add a root certificate.'
    );
  });
});

describe('SchemaCreateComponent template', () => {
  it('lets the user clear a selected category', async () => {
    const pending = () => new Promise<never>(() => undefined);
    TestBed.configureTestingModule({
      imports: [SchemaCreateComponent],
      providers: [
        provideRouter([]),
        { provide: SchemaService, useValue: { getVocabularies: pending } },
        { provide: CredentialConfigService, useValue: { loadConfigurations: pending } },
      ],
    });
    const fixture = TestBed.createComponent(SchemaCreateComponent);
    const component = fixture.componentInstance;
    component.categoryVocabularies = [{ code: 'identity', label: 'Identity' } as any];
    fixture.detectChanges();
    component.composeForm.patchValue({ category: 'identity' });

    const select = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '[formControlName="category"]' })
    );
    await select.open();
    const [none] = await select.getOptions();
    expect(await none.getText()).toBe('— None —');
    await none.click();

    expect(component.composeForm.value.category).toBe('');
  });
});
