import { FormBuilder } from '@angular/forms';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssuanceConfigCreateComponent } from './issuance-config-create.component';
import {
  pemToBase64Der,
  TEST_ROOT_CERTIFICATE_PEM,
} from '../../../utils/certificate-validator.testing';

const config = {
  display: [{ name: 'Example Issuer', locale: 'en-US' }],
  authorizationServers: [{ type: 'built-in', id: 'issuer-built-in', enabled: true }],
  batchSize: 1,
  dPopRequired: true,
};

describe('issuer settings guided setup', () => {
  let component: IssuanceConfigCreateComponent;
  let service: { getConfig: ReturnType<typeof vi.fn>; saveConfiguration: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let setup: string | null;
  let keyChains: { getAll: ReturnType<typeof vi.fn> };
  let tenantId: string | null;
  let frontendConfig: { getConfig: ReturnType<typeof vi.fn> };
  let trustAnchors: {
    registeredEntityIds: ReturnType<typeof vi.fn>;
    registeredAnchors: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    tenantId = 'acme';
    keyChains = { getAll: vi.fn().mockResolvedValue([]) };
    frontendConfig = {
      getConfig: vi.fn().mockResolvedValue({ publicUrl: 'https://eudiplo.example.com' }),
    };
    setup = null;
    trustAnchors = {
      registeredEntityIds: vi.fn().mockReturnValue(undefined),
      registeredAnchors: vi.fn().mockResolvedValue([]),
    };
    snackBar = { open: vi.fn() };
    service = {
      getConfig: vi.fn().mockResolvedValue(config),
      saveConfiguration: vi.fn().mockResolvedValue({}),
    };
    component = new IssuanceConfigCreateComponent(
      service as any,
      { navigate: vi.fn() } as any,
      { snapshot: { queryParamMap: { get: () => setup } } } as any,
      snackBar as any,
      {} as any,
      new FormBuilder(),
      {} as any,
      {} as any,
      keyChains as any,
      frontendConfig as any,
      { getTenantId: () => tenantId } as any,
      { getBaseUrl: () => 'http://localhost:3000' } as any,
      { get: () => ({ destroyed: true }) } as any,
      trustAnchors as any
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

  it('loads and saves shared wallet provider trust lists unchanged', async () => {
    const walletProviderTrustLists = [
      {
        url: 'https://trust.example/list',
        verifierKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        verifierX509Der: pemToBase64Der(TEST_ROOT_CERTIFICATE_PEM),
      },
      {
        url: 'https://trust.example/pem',
        verifierKeyPem: '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----',
      },
      { trustListId: 'wallet-providers' },
    ];
    service.getConfig.mockResolvedValue({ ...config, walletProviderTrustLists });
    await component.loadConfigForEdit();
    expect(component.walletProviderTrustLists).toHaveLength(3);
    expect(component.form.valid).toBe(true);
    component.submitSettings();
    expect(service.saveConfiguration.mock.calls[0][0].walletProviderTrustLists).toEqual(
      walletProviderTrustLists
    );
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
    service.getConfig.mockRejectedValueOnce({ statusCode: 403, message: 'Forbidden resource' });
    await component.loadConfigForEdit();
    expect(component.loadError).toBe(
      'Could not load issuer settings: Forbidden resource. Retry before making changes.'
    );
    component.onSubmit();
    expect(service.saveConfiguration).not.toHaveBeenCalled();
    await component.loadConfigForEdit();
    expect(component.loadError).toBe('');
  });

  it("shows the backend's reason when saving is rejected", async () => {
    service.saveConfiguration.mockRejectedValue({
      statusCode: 409,
      error: 'Conflict',
      message:
        "Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI.",
    });
    await component.loadConfigForEdit();

    component.onSubmit();

    await vi.waitFor(() =>
      expect(snackBar.open.mock.lastCall?.[0]).toBe(
        "Failed to save configuration: Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI."
      )
    );
  });

  it('names every rejected field, since the form shows none of them at a field', async () => {
    service.saveConfiguration.mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: ['a', 'b', 'c', 'd'].map((path) => ({
        path: ['display', 0, path],
        message: 'Invalid',
      })),
    });
    await component.loadConfigForEdit();

    component.onSubmit();

    await vi.waitFor(() =>
      expect(snackBar.open.mock.lastCall?.[0]).toBe(
        'Failed to save configuration: Validation failed (display.0.a: Invalid; ' +
          'display.0.b: Invalid; display.0.c: Invalid; display.0.d: Invalid)'
      )
    );
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

  it('omits a display logo without a URI', async () => {
    await component.loadConfigForEdit();
    component.onSubmit();
    const [payload] = service.saveConfiguration.mock.calls[0];
    expect(payload.display).toEqual([{ name: 'Example Issuer', locale: 'en-US' }]);
  });

  it('keeps the federation entity settings the form does not edit', async () => {
    service.getConfig.mockResolvedValue({
      ...config,
      federation: {
        mode: 'hybrid',
        entityId: 'https://issuer.example/issuers/root',
        trustAnchors: [
          {
            entityId: 'https://trust.example',
            entityConfigurationUri: 'https://trust.example/config',
          },
        ],
        entityTypes: ['openid_credential_issuer', 'openid_credential_verifier'],
        authorityHints: ['https://intermediate.example'],
        includeTrustChain: true,
      },
    });
    await component.loadConfigForEdit();
    component.onSubmit();
    expect(service.saveConfiguration.mock.calls[0][0].federation).toMatchObject({
      entityId: 'https://issuer.example/issuers/root',
      entityTypes: ['openid_credential_issuer', 'openid_credential_verifier'],
      authorityHints: ['https://intermediate.example'],
      includeTrustChain: true,
    });
  });

  describe('federation entity ID', () => {
    const withAnchor = (entityId?: string) =>
      service.getConfig.mockResolvedValue({
        ...config,
        federation: {
          mode: 'hybrid',
          ...(entityId === undefined ? {} : { entityId }),
          trustAnchors: [
            {
              entityId: 'https://trust.example',
              entityConfigurationUri: 'https://trust.example/config',
            },
          ],
        },
      });

    it('sends a blank entity ID as not set', async () => {
      withAnchor();
      await component.loadConfigForEdit();
      component.federation.patchValue({ entityId: '' });
      component.onSubmit();
      const [payload] = service.saveConfiguration.mock.calls[0];
      expect(payload.federation).toBeTruthy();
      expect(payload.federation.entityId).toBeUndefined();
    });

    it('saves with federation off although a hidden entity ID is invalid', async () => {
      await component.loadConfigForEdit();
      component.federation.patchValue({ enabled: true, entityId: 'https://issuer.example/?a' });
      component.federation.patchValue({ enabled: false });
      component.onSubmit();
      expect(service.saveConfiguration).toHaveBeenCalled();
      expect(service.saveConfiguration.mock.calls[0][0].federation).toBeNull();
    });

    it('stops at the trust step for an entity ID with a query', async () => {
      withAnchor();
      await component.loadConfigForEdit();
      component.federation.patchValue({ entityId: 'https://issuer.example/?tenant=a' });
      component.onSubmit();
      expect(component.federation.get('entityId')?.hasError('pattern')).toBe(true);
      expect(component.activeStep).toBe(2);
      expect(service.saveConfiguration).not.toHaveBeenCalled();
    });
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

  describe('federation entity setup', () => {
    it('offers the URL the entity configuration is served under and applies it', async () => {
      await component.loadFederationSetup();
      expect(component.expectedEntityId).toBe('https://eudiplo.example.com/issuers/acme');
      expect(component.expectedEntityIdUsesInstanceUrl).toBe(false);
      component.useExpectedEntityId();
      expect(component.federation.get('entityId')!.value).toBe(
        'https://eudiplo.example.com/issuers/acme'
      );
      expect(component.federation.get('entityId')!.dirty).toBe(true);
      expect(component.entityIdDiffers).toBe(false);
    });

    it('falls back to the instance URL when the backend reports no public URL', async () => {
      frontendConfig.getConfig.mockResolvedValue({ configImportMode: 'none' });
      await component.loadFederationSetup();
      expect(component.expectedEntityId).toBe('http://localhost:3000/issuers/acme');
      expect(component.expectedEntityIdUsesInstanceUrl).toBe(true);
    });

    it('warns only about a set entity ID that differs from that URL', async () => {
      await component.loadFederationSetup();
      expect(component.entityIdDiffers).toBe(false);
      component.federation.get('entityId')!.setValue('https://proxy.example.com/acme');
      expect(component.entityIdDiffers).toBe(true);
      component.federation.get('entityId')!.setValue(' https://eudiplo.example.com/issuers/acme ');
      expect(component.entityIdDiffers).toBe(false);
    });

    it('says the federation key is missing only when an entity ID is set and none exists', async () => {
      keyChains.getAll.mockResolvedValue([{ id: 'attestation', usageType: 'attestation' }]);
      await component.loadFederationSetup();
      expect(component.federationKeyMissing).toBe(false);
      component.federation.get('entityId')!.setValue('https://eudiplo.example.com/issuers/acme');
      expect(component.federationKeyMissing).toBe(true);

      keyChains.getAll.mockResolvedValue([{ id: 'fed', usageType: 'federation' }]);
      await component.loadFederationSetup();
      expect(component.federationKeyMissing).toBe(false);
    });

    it('flags a token signing key that is no access token key chain of the tenant', async () => {
      keyChains.getAll.mockResolvedValue([
        { id: 'attestation', usageType: 'attestation' },
        { id: 'token', usageType: 'accessToken', description: 'Tokens' },
      ]);
      // Unknown until the key chains are loaded.
      expect(component.signingKeyIdInvalid('attestation')).toBe(false);

      await component.loadFederationSetup();

      expect(component.accessTokenKeyChains).toEqual([{ id: 'token', description: 'Tokens' }]);
      expect(component.signingKeyIdInvalid('attestation')).toBe(true);
      expect(component.signingKeyIdInvalid('gone')).toBe(true);
      expect(component.signingKeyIdInvalid('token')).toBe(false);
      expect(component.signingKeyIdInvalid('')).toBe(false);
    });

    it('keeps a stored token signing key visible while the key chains are unknown', async () => {
      expect(component.signingKeyIdUnlisted('stored')).toBe(true);
      expect(component.signingKeyIdInvalid('stored')).toBe(false);

      keyChains.getAll.mockRejectedValue(new Error('offline'));
      await component.loadFederationSetup();
      expect(component.accessTokenKeyChainsLoadFailed).toBe(true);
      expect(component.signingKeyIdUnlisted('stored')).toBe(true);

      keyChains.getAll.mockResolvedValue([{ id: 'stored', usageType: 'accessToken' }]);
      await component.loadFederationSetup();
      expect(component.accessTokenKeyChainsLoadFailed).toBe(false);
      expect(component.signingKeyIdUnlisted('stored')).toBe(false);
    });

    it('labels access token keys by description and ID', () => {
      expect(
        component.accessTokenKeyChainLabel({ id: 'k1', description: 'Access Token Signing Key' })
      ).toBe('Access Token Signing Key (k1)');
      expect(component.accessTokenKeyChainLabel({ id: 'k2' })).toBe('k2');
    });

    it('checks the key federation.entityKeyChainId pins', async () => {
      service.getConfig.mockResolvedValue({
        ...config,
        federation: {
          entityId: 'https://eudiplo.example.com/issuers/acme',
          trustAnchors: [{ entityId: 'https://ta.example.org' }],
          entityKeyChainId: 'pinned',
        },
      });
      await component.loadConfigForEdit();
      keyChains.getAll.mockResolvedValue([{ id: 'other', usageType: 'federation' }]);
      await component.loadFederationSetup();
      expect(component.federationKeyMissing).toBe(true);

      keyChains.getAll.mockResolvedValue([{ id: 'pinned', usageType: 'federation' }]);
      await component.loadFederationSetup();
      expect(component.federationKeyMissing).toBe(false);
    });

    it('suggests no entity ID when the frontend configuration could not be loaded', async () => {
      frontendConfig.getConfig.mockResolvedValue(null);
      await component.loadFederationSetup();
      expect(component.expectedEntityId).toBeNull();
      expect(component.expectedEntityIdUsesInstanceUrl).toBe(false);
    });

    it('reports a failed check and keeps the last known keys', async () => {
      await component.loadFederationSetup();
      component.federation.get('entityId')!.setValue('https://eudiplo.example.com/issuers/acme');
      expect(component.federationKeyMissing).toBe(true);

      keyChains.getAll.mockRejectedValue({ statusCode: 503, message: 'Service unavailable' });
      await component.checkFederationKeyAgain();
      expect(component.federationKeyMissing).toBe(true);
      expect(snackBar.open).toHaveBeenCalledWith(
        expect.stringContaining('Service unavailable'),
        expect.anything(),
        expect.anything()
      );
    });

    it('says when a check still finds no key and confirms a found one', async () => {
      component.federation.get('entityId')!.setValue('https://eudiplo.example.com/issuers/acme');
      await component.checkFederationKeyAgain();
      expect(component.federationKeyCheckMessage).toBe('Still no matching federation key.');

      keyChains.getAll.mockResolvedValue([{ id: 'fed', usageType: 'federation' }]);
      await component.checkFederationKeyAgain();
      expect(component.federationKeyCheckMessage).toBe('');
      expect(component.federationKeyMissing).toBe(false);
      expect(snackBar.open).toHaveBeenCalledWith('Federation key found', 'Close', {
        duration: 3000,
      });
    });

    it('marks the check as running until the key chains answer, also on failure', async () => {
      let reject!: (error: unknown) => void;
      keyChains.getAll.mockReturnValue(new Promise((_, r) => (reject = r)));
      const done = component.loadFederationSetup();
      expect(component.checkingFederationKey).toBe(true);
      reject({ statusCode: 500 });
      await done;
      expect(component.checkingFederationKey).toBe(false);
    });

    it('offers no entity ID without a tenant in the token', async () => {
      tenantId = null;
      await component.loadFederationSetup();
      expect(component.expectedEntityId).toBeNull();
      component.federation.get('entityId')!.setValue('https://eudiplo.example.com/issuers/acme');
      expect(component.entityIdDiffers).toBe(false);
    });

    it('does not claim the key is missing when the key chains could not be read', async () => {
      keyChains.getAll.mockRejectedValue({ statusCode: 403 });
      await component.loadFederationSetup();
      component.federation.get('entityId')!.setValue('https://eudiplo.example.com/issuers/acme');
      expect(component.hasFederationKey).toBeNull();
      expect(component.federationKeyMissing).toBe(false);
    });
  });

  describe('federation trust anchors', () => {
    const stored = {
      ...config,
      federation: {
        mode: 'hybrid',
        cacheTtlSeconds: 300,
        trustAnchors: [
          {
            entityId: 'https://stored.example',
            entityConfigurationUri: 'https://stored.example/.well-known/openid-federation',
          },
        ],
      },
    };

    function addAnchor(entityId: string) {
      component.addTrustAnchor();
      const anchor = component.trustAnchors.at(component.trustAnchors.length - 1);
      anchor.patchValue({
        entityId,
        entityConfigurationUri: `${entityId}/.well-known/openid-federation`,
      });
    }

    it('refuses a trust anchor this edit adds that is not registered', async () => {
      service.getConfig.mockResolvedValue(stored);
      trustAnchors.registeredEntityIds.mockReturnValue(new Set(['https://ta.example']));
      await component.loadConfigForEdit();
      addAnchor('https://unknown.example');

      expect((component as any).validateStep(2)).toBe(false);
      expect(component.stepError).toBe(
        'Register https://unknown.example as a federation trust anchor first, or choose a registered one.'
      );
    });

    it('does not save settings that add an unregistered trust anchor', async () => {
      service.getConfig.mockResolvedValue(stored);
      trustAnchors.registeredEntityIds.mockReturnValue(new Set(['https://ta.example']));
      await component.loadConfigForEdit();
      expect(trustAnchors.registeredAnchors).toHaveBeenCalled();
      addAnchor('https://unknown.example');

      component.submitSettings();

      expect(service.saveConfiguration).not.toHaveBeenCalled();
      expect(component.stepError).toContain('Register https://unknown.example');
    });

    it('keeps an unregistered trust anchor of the stored configuration and accepts registered ones', async () => {
      service.getConfig.mockResolvedValue(stored);
      trustAnchors.registeredEntityIds.mockReturnValue(new Set(['https://ta.example']));
      await component.loadConfigForEdit();
      addAnchor('https://ta.example');

      expect(component.newUnregisteredTrustAnchors).toEqual([]);
      expect((component as any).validateStep(2)).toBe(true);
    });

    it('leaves the check to the backend while the registered trust anchors are not loaded', async () => {
      await component.loadConfigForEdit();
      component.federation.get('enabled')!.setValue(true);
      addAnchor('https://unknown.example');

      expect((component as any).validateStep(2)).toBe(true);
    });

    it('derives the entity configuration URI of a picked trust anchor, keeping one entered by hand', () => {
      component.addTrustAnchor();
      const uri = component.trustAnchors.at(0).get('entityConfigurationUri')!;
      const anchor = { id: 'ta', tenantId: 't', entityId: 'https://ta.example/', jwks: {} };
      const other = { ...anchor, entityId: 'https://other.example' };

      component.onTrustAnchorSelected(0, { anchor, previous: '' });
      expect(uri.value).toBe('https://ta.example/.well-known/openid-federation');

      component.onTrustAnchorSelected(0, { anchor: other, previous: 'https://ta.example/' });
      expect(uri.value).toBe('https://other.example/.well-known/openid-federation');

      uri.setValue('https://mirror.example/.well-known/openid-federation');
      component.onTrustAnchorSelected(0, { anchor, previous: 'https://other.example' });
      expect(uri.value).toBe('https://mirror.example/.well-known/openid-federation');
    });
  });
});
