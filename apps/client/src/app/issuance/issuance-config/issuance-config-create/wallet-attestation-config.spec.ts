import { ApplicationRef, ElementRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AbstractControl, FormArray, FormBuilder, FormGroup } from '@angular/forms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrustList } from '@eudiplo/sdk-core';
import { IssuanceConfigCreateComponent } from './issuance-config-create.component';
import {
  OTHER_TEST_ROOT_CERTIFICATE_PEM,
  pemToBase64Der,
  TEST_ROOT_CERTIFICATE_PEM,
} from '../../../utils/certificate-validator.testing';
import { loseFocus } from '../../../common/settings-screen.testing';

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
      expect(saved.walletAttestationStatusCheckMode).toBeUndefined();
    });

    it(`preserves a status check mode override for ${type}`, () => {
      const form = component['createAuthorizationServerGroup']({
        type,
        id: 'as',
        walletAttestationStatusCheckMode: 'strict',
      });
      const [saved] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(saved.walletAttestationStatusCheckMode).toBe('strict');
      form.get('walletAttestationStatusCheckMode')!.setValue('inherit');
      const [inherited] = component['buildUnifiedAuthorizationServers']({
        authorizationServers: [form.value],
      });
      expect(inherited.walletAttestationStatusCheckMode).toBeUndefined();
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
      const refs = [{ url: 'https://trust.example/list', verifierX509Der: certificateDer }];
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
  const certificatePem = TEST_ROOT_CERTIFICATE_PEM;
  const certificateDer = pemToBase64Der(TEST_ROOT_CERTIFICATE_PEM);
  const url = 'https://trust.example/list';

  function trustListGroup(entry: Record<string, unknown>) {
    const form = component['createAuthorizationServerGroup']({
      type: 'built-in',
      id: 'as',
      walletProviderTrustLists: [entry],
    });
    return { form, entry: (form.get('walletProviderTrustLists') as FormArray).at(0) };
  }

  function save(form: AbstractControl) {
    const [saved] = component['buildUnifiedAuthorizationServers']({
      authorizationServers: [form.value],
    });
    return saved.walletProviderTrustLists;
  }

  for (const [format, certificate] of [
    ['PEM', certificatePem],
    ['Base64 DER', certificateDer],
  ]) {
    it(`stores a ${format} signer certificate as Base64 DER`, () => {
      const { form, entry } = trustListGroup({ url });
      entry.get('verifierCertificate')!.setValue(certificate);
      expect(form.valid).toBe(true);
      expect(save(form)).toEqual([{ url, verifierX509Der: certificateDer }]);
    });
  }

  it('rejects public keys and other input as the signer certificate', () => {
    const { form, entry } = trustListGroup({ url });
    for (const value of [
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----',
      '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
      'not base64!',
    ]) {
      entry.get('verifierCertificate')!.setValue(value);
      expect(entry.get('verifierCertificate')!.hasError('certificate')).toBe(true);
      expect(form.valid).toBe(false);
    }
    entry.get('verifierCertificate')!.setValue(`${certificatePem}${certificatePem}`);
    expect(entry.get('verifierCertificate')!.hasError('multipleCertificates')).toBe(true);
    entry.get('verifierCertificate')!.setValue('');
    expect(entry.hasError('missingVerifier')).toBe(true);
  });

  it('keeps a stored public key next to an unchanged certificate', () => {
    const verifierKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const { form, entry } = trustListGroup({ url, verifierKey, verifierX509Der: certificateDer });
    expect(save(form)).toEqual([{ url, verifierKey, verifierX509Der: certificateDer }]);

    entry.get('verifierCertificate')!.setValue(certificatePem);
    expect(save(form)).toEqual([{ url, verifierKey, verifierX509Der: certificateDer }]);
  });

  it('keeps a stored public key until a certificate replaces it', () => {
    const verifierKeyPem =
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----';
    const verifierKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const { form, entry } = trustListGroup({ url, verifierKey, verifierKeyPem });
    expect(form.valid).toBe(true);
    expect(save(form)).toEqual([{ url, verifierKey, verifierKeyPem }]);

    expect(component.pinnedPublicKey(entry)).toBe('JWK and PEM');
    entry.get('verifierCertificate')!.setValue(certificatePem);
    expect(component.pinnedPublicKey(entry)).toBeNull();
    expect(form.valid).toBe(true);
    expect(save(form)).toEqual([{ url, verifierX509Der: certificateDer }]);
  });

  it('drops a cleared certificate and keeps the stored key', () => {
    const verifierKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const { form, entry } = trustListGroup({ url, verifierKey, verifierX509Der: certificateDer });
    entry.get('verifierCertificate')!.setValue('');
    expect(form.valid).toBe(true);
    expect(save(form)).toEqual([{ url, verifierKey }]);
  });

  it('replaces a stored key and certificate when a different certificate is entered', () => {
    const verifierKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const { form, entry } = trustListGroup({ url, verifierKey, verifierX509Der: certificateDer });
    entry.get('verifierCertificate')!.setValue(OTHER_TEST_ROOT_CERTIFICATE_PEM);
    expect(save(form)).toEqual([
      { url, verifierX509Der: pemToBase64Der(OTHER_TEST_ROOT_CERTIFICATE_PEM) },
    ]);
  });

  it('reads a stored JWK given as a JSON string', () => {
    const verifierKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const { form } = trustListGroup({ url, verifierKey: JSON.stringify(verifierKey) });
    expect(form.valid).toBe(true);
    expect(save(form)).toEqual([{ url, verifierKey }]);

    const { entry } = trustListGroup({ url, verifierKey: 'not json' });
    expect(entry.hasError('missingVerifier')).toBe(true);
  });

  it('flags a stored value that is not a certificate', () => {
    const { form, entry } = trustListGroup({ url, verifierX509Der: 'cert' });
    expect(entry.get('verifierCertificate')!.hasError('certificate')).toBe(true);
    expect(form.valid).toBe(false);
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

  describe('managed trust lists', () => {
    const lists = [
      {
        id: 'wallet-providers',
        description: 'Wallets',
        entityConfig: [{ providerType: 'wallet-provider' }],
      },
      { id: 'issuers', entityConfig: [{ providerType: 'attestation-provider' }] },
    ] as unknown as TrustList[];

    function withLists(fetch: () => Promise<TrustList[]>) {
      const host = Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
        fb: new FormBuilder(),
        trustLists: [],
        trustListsLoading: false,
        trustListsLoaded: false,
        trustListsError: '',
        fetchTrustLists: fetch,
      }) as IssuanceConfigCreateComponent;
      return host;
    }

    it('opens a stored managed reference as a managed entry', () => {
      const { entry } = trustListGroup({ trustListId: 'wallet-providers' });
      expect(entry.get('mode')!.value).toBe('managed');
    });

    it('requires a selection for a new managed entry and saves only its ID', () => {
      const form = component['createAuthorizationServerGroup']({ type: 'built-in', id: 'as' });
      form.get('inheritWalletProviderTrustLists')!.setValue(false);
      component.addAuthorizationServerWalletProviderTrustList.call(
        Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
          fb: new FormBuilder(),
          getAuthorizationServerWalletProviderTrustLists: () =>
            form.get('walletProviderTrustLists'),
          loadTrustLists: async () => undefined,
        }),
        0,
        'managed'
      );
      const entry = (form.get('walletProviderTrustLists') as FormArray).at(0);
      expect(entry.hasError('missingTrustList')).toBe(true);
      entry.patchValue({ trustListId: 'wallet-providers', url: 'https://ignored.example' });
      expect(form.valid).toBe(true);
      expect(save(form)).toEqual([{ trustListId: 'wallet-providers' }]);
    });

    it('saves an external entry without a stale managed ID', () => {
      const { form, entry } = trustListGroup({ url });
      entry.patchValue({ trustListId: 'wallet-providers', verifierCertificate: certificatePem });
      expect(save(form)).toEqual([{ url, verifierX509Der: certificateDer }]);
    });

    it('offers only lists with a wallet provider and explains other stored IDs', async () => {
      const host = withLists(async () => lists);
      expect(host.managedTrustListNote('issuers')).toBe('lists not loaded');
      expect(host.managedTrustListNote('')).toBeNull();
      await host.loadTrustLists();
      expect(host.walletProviderTrustListOptions.map((list) => list.id)).toEqual([
        'wallet-providers',
      ]);
      expect(host.managedTrustListNote('wallet-providers')).toBeNull();
      expect(host.managedTrustListNote('issuers')).toBe('no wallet provider');
      expect(host.managedTrustListNote('gone')).toBe('not found');
    });

    it('reports a failed load and loads again on retry', async () => {
      const fetch = vi
        .fn<() => Promise<TrustList[]>>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(lists);
      const host = withLists(fetch);
      await host.loadTrustLists();
      expect(host.trustListsError).toContain('Selected lists are kept');
      expect(host.managedTrustListNote('gone')).toBe('lists not loaded');
      await host.loadTrustLists();
      expect(host.trustListsError).toBe('');
      expect(host.walletProviderTrustListOptions).toHaveLength(1);
    });

    it('loads the tenant lists when a managed entry is added', () => {
      const trustLists = new FormArray<FormGroup>([]);
      const loadTrustLists = vi.fn(async () => undefined);
      const host = Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
        fb: new FormBuilder(),
        form: new FormGroup({ walletProviderTrustLists: trustLists }),
        loadTrustLists,
      }) as IssuanceConfigCreateComponent;
      host.addWalletProviderTrustList('external');
      expect(loadTrustLists).not.toHaveBeenCalled();
      host.addWalletProviderTrustList('managed');
      expect(loadTrustLists).toHaveBeenCalledOnce();
      expect(trustLists).toHaveLength(2);
    });

    it('fetches the tenant lists once', async () => {
      const fetch = vi.fn(async () => lists);
      const host = withLists(fetch);
      await Promise.all([host.loadTrustLists(), host.loadTrustLists()]);
      await host.loadTrustLists();
      expect(fetch).toHaveBeenCalledOnce();
    });

    describe('focus after removing an entry', () => {
      const added: HTMLElement[] = [];
      afterEach(() => added.splice(0).forEach((element) => element.remove()));

      /** A list on the page: its entry fields, then its Add managed trust list button. */
      function listSection(count: number) {
        const element = document.body.appendChild(document.createElement('div'));
        added.push(element);
        const fields = Array.from({ length: count }, () =>
          element.appendChild(document.createElement('input'))
        );
        const add = element.appendChild(document.createElement('button'));
        const list = new FormArray(
          fields.map(() => component['createWalletProviderTrustListGroup']({ url }))
        );
        return { element, fields, add, list };
      }

      it('moves focus to the next entry or the Add button of the same list', () => {
        const first = listSection(2);
        const second = listSection(2);
        // Like the view queries, the fields and buttons of every list on the page.
        const fields = [...first.fields, ...second.fields].map((field) => new ElementRef(field));
        const host = Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
          injector: TestBed.inject(Injector),
          trustListFields: fields,
          addManagedTrustListButtons: [first.add, second.add].map((add) => new ElementRef(add)),
        }) as IssuanceConfigCreateComponent;
        /** Removes entry `index` of `section` while it holds the focus, then renders. */
        const remove = (section: ReturnType<typeof listSection>, index: number) => {
          const [field] = section.fields.splice(index, 1);
          field.focus();
          host.removeTrustListEntry(section.list, index, section.element);
          fields.splice(
            fields.findIndex((ref) => ref.nativeElement === field),
            1
          );
          field.remove();
          loseFocus();
          TestBed.inject(ApplicationRef).tick();
        };

        remove(second, 0);
        expect(second.list).toHaveLength(1);
        expect(document.activeElement).toBe(second.fields[0]);
        remove(second, 0);
        expect(document.activeElement).toBe(second.add);
        remove(first, 1);
        expect(first.list).toHaveLength(1);
        expect(document.activeElement).toBe(first.fields[0]);
      });
    });

    it('asks for the tenant lists only where a managed entry exists', () => {
      const external = new FormArray([component['createWalletProviderTrustListGroup']({ url })]);
      expect(component.hasManagedEntry(external)).toBe(false);
      external.push(component['createWalletProviderTrustListGroup']({ trustListId: 'x' }));
      expect(component.hasManagedEntry(external)).toBe(true);
    });
  });

  it('saves the issuer status check mode, and null for the default', () => {
    const form = new FormBuilder().group({
      walletAttestationStatusCheckMode: ['strict' as string | null],
    });
    const host = Object.assign(Object.create(IssuanceConfigCreateComponent.prototype), {
      fb: new FormBuilder(),
      form,
    }) as IssuanceConfigCreateComponent;
    const payload = () => host['buildConfigurationPayload']();
    expect(host.issuerStatusCheckModeLabel).toBe('Strict');
    expect(payload().walletAttestationStatusCheckMode).toBe('strict');
    form.get('walletAttestationStatusCheckMode')!.setValue(null);
    expect(host.issuerStatusCheckModeLabel).toBe('Best effort');
    expect(payload().walletAttestationStatusCheckMode).toBeNull();
  });
});
