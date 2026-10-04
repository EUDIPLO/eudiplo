import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialConfigCreateComponent } from './credential-config-create.component';

describe('CredentialConfigCreateComponent', () => {
  let component: CredentialConfigCreateComponent;
  let save: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    save = vi.fn().mockResolvedValue({});
    component = new CredentialConfigCreateComponent(
      { saveConfiguration: save, updateConfiguration: save } as any,
      { navigate: vi.fn() } as any,
      { snapshot: { params: {} } } as any,
      { open: vi.fn() } as any,
      {} as any,
      {} as any
    );
  });

  function basics() {
    component.form.patchValue({ id: 'member', description: 'Membership', vctString: 'urn:member' });
  }

  it('validates the current step and does not save on Continue', () => {
    component.submitCredential();
    expect(component.activeStep).toBe(0);
    expect(component.stepError).toContain('Basics');
    expect(component.form.get('id')?.touched).toBe(true);
    basics();
    component.submitCredential();
    expect(component.activeStep).toBe(1);
    expect(save).not.toHaveBeenCalled();
    component.submitCredential();
    component.submitCredential();
    expect(component.activeStep).toBe(2);
    expect(component.stepError).toContain('Appearance');
  });

  it('preserves values when switching modes and saves only after review', () => {
    basics();
    component.displayConfigs.at(0).patchValue({ name: 'Membership', description: 'Member card' });
    component.form.patchValue({ scope: 'membership', keyBinding: false });
    const before = component.form.getRawValue();
    component.toggleGuidedMode();
    component.toggleGuidedMode();
    expect(component.form.getRawValue()).toEqual(before);
    for (let i = 0; i < 4; i++) component.submitCredential();
    expect(component.activeStep).toBe(4);
    expect(save).not.toHaveBeenCalled();
    component.submitCredential();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      id: 'member',
      keyBinding: false,
      vct: 'urn:member',
      config: { scope: 'membership' },
    });
    component.submitCredential();
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps status management on while Single Active Credential is enabled', () => {
    basics();
    component.displayConfigs.at(0).patchValue({ name: 'Membership', description: 'Member card' });
    const statusManagement = component.form.get('statusManagement')!;
    statusManagement.setValue(false);
    component.form.get('activeCredentialsEnabled')!.setValue(true);
    expect(statusManagement.value).toBe(true);
    expect(statusManagement.disabled).toBe(true);
    expect(component.settingsSummary).toContain('Status management: On');

    for (let i = 0; i < 5; i++) component.submitCredential();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      statusManagement: true,
      activeCredentials: { enabled: true },
    });

    component.form.get('activeCredentialsEnabled')!.setValue(false);
    expect(statusManagement.enabled).toBe(true);
    statusManagement.setValue(false);
    expect((component as any).buildConfigurationPayload()).toMatchObject({
      statusManagement: false,
      activeCredentials: { enabled: false },
    });
  });

  it('loads Single Active Credential without status management as a valid combination', () => {
    const statusManagement = component.form.get('statusManagement')!;
    (component as any).patchFormFromConfig({
      id: 'member',
      description: 'Membership',
      vct: 'urn:member',
      statusManagement: false,
      activeCredentials: { enabled: true },
      config: { format: 'dc+sd-jwt', display: [{ name: 'Membership', locale: 'en-US' }] },
      fields: [],
    });
    expect(statusManagement.value).toBe(true);
    expect(statusManagement.disabled).toBe(true);
    expect((component as any).buildConfigurationPayload()).toMatchObject({
      statusManagement: true,
      activeCredentials: { enabled: true },
    });

    (component as any).patchFormFromConfig({
      id: 'member',
      description: 'Membership',
      vct: 'urn:member',
      statusManagement: false,
      config: { format: 'dc+sd-jwt', display: [{ name: 'Membership', locale: 'en-US' }] },
      fields: [],
    });
    expect(statusManagement.value).toBe(false);
    expect(statusManagement.enabled).toBe(true);
  });

  it('returns to an invalid earlier step before review or save', () => {
    basics();
    component.displayConfigs.at(0).patchValue({ name: 'Membership', description: 'Member card' });
    component.activeStep = 3;
    component.form.get('id')?.setValue('');
    component.nextStep();
    expect(component.activeStep).toBe(0);
    component.onSubmit();
    expect(save).not.toHaveBeenCalled();
  });

  it('validates collapsed JSON settings and mDOC type independently of mounted editors', () => {
    basics();
    component.form.get('format')?.setValue('mso_mdoc');
    component.nextStep();
    expect(component.activeStep).toBe(0);
    component.form.get('docType')?.setValue('org.example.member');
    component.nextStep();
    expect(component.activeStep).toBe(1);
    component.form.get('embeddedDisclosurePolicy')?.setValue('{broken');
    component.activeStep = 3;
    component.nextStep();
    expect(component.activeStep).toBe(3);
    expect(component.settingsExpanded).toBe(true);
    expect(component.stepError).toContain('Settings');
  });

  it('advances on Enter without submitting twice and ignores IME composition', () => {
    basics();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    component.onInputEnter(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(component.activeStep).toBe(1);
    component.onInputEnter(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(component.activeStep).toBe(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('opens existing configurations with direct navigation', () => {
    const edit = new CredentialConfigCreateComponent(
      {} as any,
      {} as any,
      { snapshot: { params: { id: 'existing' } } } as any,
      {} as any,
      {} as any,
      {} as any
    );
    expect(edit.create).toBe(false);
    expect(edit.guidedMode).toBe(false);
  });

  it.each([
    ['string', 'Max', 'Max'],
    ['string', '  Max  ', '  Max  '],
    ['string', '"Max"', '"Max"'],
    ['boolean', 'true', true],
    ['boolean', 'false', false],
    ['number', '0', 0],
    ['number', '-3.14', -3.14],
    ['integer', '42', 42],
    ['object', '{"city":"Berlin"}', { city: 'Berlin' }],
    ['array', '["one",2]', ['one', 2]],
  ])('validates and serializes a %s default %s', (type, input, expected) => {
    const field = component.createFieldGroup({ path: ['value'], type } as any);
    field.get('defaultValue')!.setValue(input);
    expect(field.valid).toBe(true);
    const [payload] = (component as any).buildFieldsPayload([field.value]);
    expect(payload.defaultValue).toEqual(expected);
    const restored = component.createFieldGroup(payload);
    expect(restored.valid).toBe(true);
    expect((component as any).buildFieldsPayload([restored.value])[0].defaultValue).toEqual(
      expected
    );
  });

  it.each([
    ['boolean', 'yes'],
    ['boolean', '"true"'],
    ['boolean', '1'],
    ['integer', '1.5'],
    ['number', 'Max'],
    ['number', '1e999'],
    ['object', '[]'],
    ['object', 'null'],
    ['object', '{broken'],
    ['array', '{}'],
    ['array', 'false'],
  ])('rejects %s default %s before continuing', (type, input) => {
    const field = component.createFieldGroup({ path: ['value'], type } as any);
    field.get('defaultValue')!.setValue(input);
    component.fields.push(field);
    component.activeStep = 1;
    component.nextStep();
    expect(field.get('defaultValue')!.hasError('defaultValueType')).toBe(true);
    expect(field.get('defaultValue')!.touched).toBe(true);
    expect(component.activeStep).toBe(1);
    expect(component.stepError).toContain('Claims');
    expect(save).not.toHaveBeenCalled();
  });

  it('revalidates defaults on type changes and allows an omitted default', () => {
    const field = component.createFieldGroup({
      path: ['value'],
      type: 'string',
      defaultValue: 'Max',
    });
    expect(field.valid).toBe(true);
    field.get('type')!.setValue('boolean');
    expect(field.get('defaultValue')!.invalid).toBe(true);
    field.get('defaultValue')!.setValue('false');
    expect(field.valid).toBe(true);
    field.get('defaultValue')!.setValue('');
    expect(field.valid).toBe(true);
    expect((component as any).buildFieldsPayload([field.value])[0]).not.toHaveProperty(
      'defaultValue'
    );
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('keeps relative mDOC field paths and stores namespace separately', () => {
    component.form.get('format')?.setValue('mso_mdoc');
    component.form.get('docType')?.setValue('eu.europa.ec.eudi.pid.1');

    const fieldGroup = component.createFieldGroup({
      path: ['given_name'],
      namespace: 'eu.europa.ec.eudi.pid.1',
      type: 'string',
      defaultValue: 'ERIKA',
    } as any);

    expect(fieldGroup.get('path')?.value).toBe('given_name');
    expect(fieldGroup.get('namespace')?.value).toBe('eu.europa.ec.eudi.pid.1');

    const payload = (component as any).buildFieldsPayload([
      {
        path: 'given_name',
        namespace: 'eu.europa.ec.eudi.pid.1',
        type: 'string',
        defaultValue: 'ERIKA',
        mandatory: true,
      },
    ]);

    expect(payload).toEqual([
      {
        path: ['given_name'],
        namespace: 'eu.europa.ec.eudi.pid.1',
        type: 'string',
        mandatory: true,
        disclosable: false,
        defaultValue: 'ERIKA',
      },
    ]);
  });

  it('supports nested mDOC paths using the shared field model', () => {
    component.form.get('format')?.setValue('mso_mdoc');

    const payload = (component as any).buildFieldsPayload([
      {
        path: 'org.iso.18013.5.1.given_name',
        namespace: 'eu.europa.ec.eudi.mdl.1',
        type: 'string',
      },
    ]);

    expect(payload).toEqual([
      {
        path: ['org', 'iso', 18013, 5, 1, 'given_name'],
        namespace: 'eu.europa.ec.eudi.mdl.1',
        type: 'string',
        mandatory: false,
        disclosable: false,
      },
    ]);
  });

  it('does not auto-fill mDOC namespace from docType', () => {
    component.form.get('format')?.setValue('mso_mdoc');
    component.form.get('docType')?.setValue('eu.europa.ec.eudi.mdl.1');

    const fieldGroup = component.createFieldGroup({
      path: ['given_name'],
      type: 'string',
    } as any);

    expect(fieldGroup.get('namespace')?.value).toBe('');
  });

  it('preserves array child wildcard paths when nesting and flattening field definitions', () => {
    const payload = (component as any).buildFieldsPayload([
      {
        path: 'nationalities',
        type: 'array',
        mandatory: true,
      },
      {
        path: 'nationalities.*',
        type: 'string',
        defaultValue: 'DE',
      },
    ]);

    expect(payload).toEqual([
      {
        path: ['nationalities'],
        type: 'array',
        mandatory: true,
        disclosable: false,
        children: [
          {
            path: [null],
            type: 'string',
            defaultValue: 'DE',
            mandatory: false,
            disclosable: false,
          },
        ],
      },
    ]);

    const flat = (component as any).flattenFieldDefinitionsForForm(payload);
    expect(flat).toHaveLength(2);
    expect(flat[0].path).toEqual(['nationalities']);
    expect(flat[1].path).toEqual(['nationalities', null]);
  });
});
