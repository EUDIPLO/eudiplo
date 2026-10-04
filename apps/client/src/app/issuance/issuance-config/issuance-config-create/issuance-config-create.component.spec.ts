import { FormBuilder } from '@angular/forms';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssuanceConfigCreateComponent } from './issuance-config-create.component';

const config = {
  display: [{ name: 'Example Issuer', locale: 'en-US' }],
  authorizationServers: [{ type: 'built-in', id: 'issuer-built-in', enabled: true }],
  batchSize: 1,
  dPopRequired: true,
};

describe('issuer settings guided setup', () => {
  let component: IssuanceConfigCreateComponent;
  let service: { getConfig: ReturnType<typeof vi.fn>; saveConfiguration: ReturnType<typeof vi.fn> };
  let setup: string | null;
  beforeEach(() => {
    setup = null;
    service = {
      getConfig: vi.fn().mockResolvedValue(config),
      saveConfiguration: vi.fn().mockResolvedValue({}),
    };
    component = new IssuanceConfigCreateComponent(
      service as any,
      { navigate: vi.fn() } as any,
      { snapshot: { queryParamMap: { get: () => setup } } } as any,
      { open: vi.fn() } as any,
      {} as any,
      new FormBuilder(),
      {} as any,
      {} as any
    );
  });

  it('opens existing identity in direct editing and allows explicit guided setup', async () => {
    await component.loadConfigForEdit();
    expect(component.guidedMode).toBe(false);
    expect(component.form.valid).toBe(true); // Logo is optional.
    setup = 'true';
    await component.loadConfigForEdit();
    expect(component.guidedMode).toBe(true);
  });

  it('guides an issuer with no identity and validates before advancing', async () => {
    service.getConfig.mockResolvedValue({ ...config, display: [] });
    await component.loadConfigForEdit();
    expect(component.guidedMode).toBe(true);
    component.submitSettings();
    expect(component.activeStep).toBe(0);
    expect(component.stepError).toContain('Identity');
    expect(component.displays.at(0).get('name')!.touched).toBe(true);
    component.displays.at(0).get('name')!.setValue('Example Issuer');
    component.onInputEnter(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(component.activeStep).toBe(1);
    component.submitSettings();
    component.submitSettings();
    expect(component.activeStep).toBe(3);
    expect(service.saveConfiguration).not.toHaveBeenCalled();
    component.submitSettings();
    expect(service.saveConfiguration).toHaveBeenCalledOnce();
    expect(service.saveConfiguration.mock.calls[0][0]).toMatchObject(config);
  });

  it('preserves values across mode switches', async () => {
    await component.loadConfigForEdit();
    component.form.get('batchSize')!.setValue(5);
    const before = component.form.getRawValue();
    component.toggleGuidedMode();
    component.toggleGuidedMode();
    expect(component.form.getRawValue()).toEqual(before);
  });

  it('blocks saving on loading failure and supports retry', async () => {
    service.getConfig.mockRejectedValueOnce(new Error('offline'));
    await component.loadConfigForEdit();
    expect(component.loadError).toContain('Retry');
    component.onSubmit();
    expect(service.saveConfiguration).not.toHaveBeenCalled();
    await component.loadConfigForEdit();
    expect(component.loadError).toBe('');
  });

  it('opens trust settings for missing prerequisites', async () => {
    await component.loadConfigForEdit();
    component.registrationCertificate.patchValue({ enabled: true, mode: 'import', jwt: '' });
    component.onSubmit();
    expect(component.activeStep).toBe(2);
    expect(component.stepError).toContain('JWT');
    expect(component.expandedSections.has('registration')).toBe(true);
    component.registrationCertificate.patchValue({ enabled: false });
    component.federation.patchValue({ enabled: true });
    component.onSubmit();
    expect(component.stepError).toContain('trust anchor');
    expect(service.saveConfiguration).not.toHaveBeenCalled();
  });

  it('explicitly clears disabled trust settings and resets the PIN limit', async () => {
    service.getConfig.mockResolvedValue({
      ...config,
      txCodeMaxAttempts: 9,
      federation: {
        role: 'leaf',
        mode: 'hybrid',
        trustAnchors: [
          {
            entityId: 'https://trust.example',
            entityConfigurationUri: 'https://trust.example/config',
          },
        ],
      },
      registrationCertificate: { enabled: true, mode: 'import', jwt: 'existing.jwt.value' },
    });
    await component.loadConfigForEdit();
    expect(component.federationEnabled).toBe(true);
    component.federation.patchValue({ enabled: false });
    component.registrationCertificate.patchValue({ enabled: false });
    component.form.get('txCodeMaxAttempts')!.setValue(null);
    component.onSubmit();
    expect(service.saveConfiguration.mock.calls[0][0]).toMatchObject({
      federation: null,
      registrationCertificate: null,
      txCodeMaxAttempts: null,
    });
  });

  it('rejects duplicate and reserved authorization IDs before save', async () => {
    await component.loadConfigForEdit();
    component.authorizationServers.at(0).get('id')!.setValue('built-in');
    component.onSubmit();
    expect(component.stepError).toContain('reserved');
    expect(component.activeStep).toBe(1);
    component.authorizationServers.at(0).get('id')!.setValue('same');
    component.addAuthorizationServer();
    component.authorizationServers
      .at(1)
      .patchValue({ id: 'same', label: 'Second', enabled: false });
    component.onSubmit();
    expect(component.stepError).toContain('unique');
    expect(service.saveConfiguration).not.toHaveBeenCalled();
  });

  it('defaults the built-in token lifetime to 300 s and keeps explicit values', async () => {
    await component.loadConfigForEdit();
    expect(component.authorizationServers.at(0).get('token.lifetimeSeconds')!.value).toBe(300);
    component.onSubmit();
    expect(service.saveConfiguration.mock.calls[0][0].authorizationServers[0].token).toMatchObject({
      lifetimeSeconds: 300,
    });

    service.getConfig.mockResolvedValue({
      ...config,
      authorizationServers: [
        { ...config.authorizationServers[0], token: { lifetimeSeconds: 900 } },
      ],
    });
    await component.loadConfigForEdit();
    const payload = (component as any).buildConfigurationPayload();
    expect(payload.authorizationServers[0].token).toMatchObject({ lifetimeSeconds: 900 });
  });

  it('switches token lifetime defaults with the server type unless the user edited it', async () => {
    await component.loadConfigForEdit();
    component.removeAuthorizationServer(0);
    component.addAuthorizationServer();
    const lifetime = () => component.authorizationServers.at(0).get('token.lifetimeSeconds')!;
    expect(lifetime().value).toBe(3600);

    component.authorizationServers.at(0).get('type')!.setValue('built-in');
    component.onAuthorizationServerTypeChange(0, 'built-in');
    expect(lifetime().value).toBe(300);

    component.authorizationServers.at(0).get('type')!.setValue('chained');
    component.onAuthorizationServerTypeChange(0, 'chained');
    expect(lifetime().value).toBe(3600);

    lifetime().setValue(1200);
    lifetime().markAsDirty();
    component.authorizationServers.at(0).get('type')!.setValue('built-in');
    component.onAuthorizationServerTypeChange(0, 'built-in');
    expect(lifetime().value).toBe(1200);
  });
});
