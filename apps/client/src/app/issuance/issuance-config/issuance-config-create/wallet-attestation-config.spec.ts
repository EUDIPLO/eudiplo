import { FormBuilder } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { IssuanceConfigCreateComponent } from './issuance-config-create.component';

describe('wallet attestation configuration round trips', () => {
  const component = Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
    fb: new FormBuilder(),
  }) as IssuanceConfigCreateComponent;

  for (const type of ['built-in', 'chained', 'oid4vp']) {
    it(`preserves inherited settings for ${type}`, () => {
      const form = component['createAuthorizationServerGroup']({ type, id: 'as' });
      const [saved] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(saved.walletAttestationRequired).toBeUndefined();
      expect(saved.walletProviderTrustLists).toBeUndefined();
    });

    it(`preserves explicit false and empty trust overrides for ${type}`, () => {
      const form = component['createAuthorizationServerGroup']({
        type,
        id: 'as',
        walletAttestationRequired: false,
        walletProviderTrustLists: [],
      });
      const [saved] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(saved.walletAttestationRequired).toBe(false);
      expect(saved.walletProviderTrustLists).toEqual([]);
    });

    it(`preserves provider trust when wallet attestation is optional for ${type}`, () => {
      const refs = [{ url: 'https://trust.example/list', verifierX509Der: 'cert' }];
      const form = component['createAuthorizationServerGroup']({
        type,
        id: 'as',
        walletAttestationRequired: false,
        walletProviderTrustLists: refs,
      });
      const [saved] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(saved.walletProviderTrustLists).toEqual(refs);
      form.get('inheritWalletProviderTrustLists')!.setValue(true);
      const [inherited] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(inherited.walletProviderTrustLists).toBeUndefined();
    });
  }

  it('serializes an empty shared list so existing trust can be cleared', () => {
    expect(component['buildWalletProviderTrustLists']([])).toEqual([]);
  });

  it('ignores incomplete custom trust entries while inheriting shared trust', () => {
    const form = component['createAuthorizationServerGroup']({
      type: 'built-in',
      id: 'as',
      walletProviderTrustLists: [{ url: '' }],
    });
    expect(form.valid).toBe(false);
    form.get('inheritWalletProviderTrustLists')!.setValue(true);
    expect(form.valid).toBe(true);
    form.get('inheritWalletProviderTrustLists')!.setValue(false);
    expect(form.valid).toBe(false);
  });
  it('accepts a PEM public key as the only verifier and rejects other PEM blocks', () => {
    const verifierKeyPem =
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n';
    const form = component['createAuthorizationServerGroup']({
      type: 'built-in',
      id: 'as',
      walletProviderTrustLists: [{ url: 'https://trust.example/list', verifierKeyPem }],
    });
    expect(form.valid).toBe(true);
    const [saved] = component['buildUnifiedAuthorizationServers']({
      authorizationServers: [form.value],
    });
    expect(saved.walletProviderTrustLists).toEqual([
      { url: 'https://trust.example/list', verifierKeyPem: verifierKeyPem.trim() },
    ]);

    const trustList = component['createAuthorizationServerGroup']({
      type: 'built-in',
      id: 'as',
      walletProviderTrustLists: [
        {
          url: 'https://trust.example/list',
          verifierKeyPem: '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----',
        },
      ],
    });
    expect(trustList.valid).toBe(false);
  });

  it('preserves a managed list reference without requiring a URL or verifier', () => {
    const refs = [{ trustListId: 'wallet-providers' }];
    const form = component['createAuthorizationServerGroup']({
      type: 'built-in',
      id: 'as',
      walletAttestationRequired: true,
      walletProviderTrustLists: refs,
    });
    expect(form.valid).toBe(true);
    const [saved] = component['buildUnifiedAuthorizationServers']({
      authorizationServers: [form.value],
    });
    expect(saved.walletProviderTrustLists).toEqual(refs);
    expect(component['buildWalletProviderTrustLists'](refs)).toEqual(refs);
  });
});
