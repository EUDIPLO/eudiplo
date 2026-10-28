import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { provideFormlyCore } from '@ngx-formly/core';
import { withFormlyMaterial } from '@ngx-formly/material';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IssuanceOfferComponent } from './issuance-offer.component';
import { AttributeProviderService } from '../attribute-provider/attribute-provider.service';
import { CredentialConfigService } from '../credential-config/credential-config.service';
import { IssuanceConfigService } from '../issuance-config/issuance-config.service';
import { ArrayTypeComponent } from '../../types/array.type';
import { ObjectTypeComponent } from '../../types/object.type';

function buildMdocConfig() {
  return {
    id: 'pid',
    config: {
      format: 'mso_mdoc',
      docType: 'eu.europa.ec.eudi.pid.1',
    },
    fields: [
      {
        path: ['eu.europa.ec.eudi.pid.1', 'given_name'],
        type: 'string',
        mandatory: true,
        defaultValue: 'Ada',
      },
      {
        path: ['eu.europa.ec.eudi.pid.1', 'family_name'],
        type: 'string',
        mandatory: true,
      },
    ],
  };
}

describe('IssuanceOfferComponent', () => {
  let component: IssuanceOfferComponent;
  let fixture: ComponentFixture<IssuanceOfferComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IssuanceOfferComponent],
      providers: [
        provideFormlyCore([
          ...withFormlyMaterial(),
          {
            types: [
              { name: 'array', component: ArrayTypeComponent },
              { name: 'object', component: ObjectTypeComponent },
            ],
          },
        ]),
        {
          provide: IssuanceConfigService,
          useValue: {
            getConfig: vi.fn().mockResolvedValue(undefined),
            getOffer: vi.fn().mockResolvedValue({ session: 'session-id', uri: 'uri' }),
          },
        },
        {
          provide: CredentialConfigService,
          useValue: {
            loadConfigurations: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AttributeProviderService,
          useValue: {
            getAll: vi.fn().mockResolvedValue([]),
          },
        },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: Router, useValue: { navigate: vi.fn().mockResolvedValue(true) } },
        { provide: MatDialog, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(IssuanceOfferComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('hands formly-form the same fields array for the same field config', async () => {
    component.credentialConfigs = [buildMdocConfig() as any];
    await component.setClaimFormFields(['pid']);

    const first = component.getFields(component.fields[0]);

    expect(component.getFields(component.fields[0])).toBe(first);
    expect(first).toEqual([component.fields[0]]);
  });

  it('renders mdoc fields without the namespace wrapper and wraps them on submit', async () => {
    const config = buildMdocConfig() as any;
    component.credentialConfigs = [config];

    await component.setClaimFormFields(['pid']);

    expect(component.fields).toHaveLength(1);
    expect(component.fields[0].fieldGroup?.some((field) => field.key === 'given_name')).toBe(true);
    expect(
      component.fields[0].fieldGroup?.some((field) => field.key === 'eu.europa.ec.eudi.pid.1')
    ).toBe(false);

    expect(component.elements[0].defaultClaims).toEqual({ given_name: 'Ada' });

    component.flowStepForm.patchValue({ flow: 'pre_authorized_code' });
    component.credentialStepForm.patchValue({ credentialConfigurationIds: ['pid'] });
    component.configStepForm
      .get('claims')
      ?.patchValue({ pid: { given_name: 'Ada', family_name: 'Lovelace' } });
    component.elements[0].claimSource = 'form';

    await component.onSubmit();

    const issuanceConfigService = TestBed.inject(IssuanceConfigService) as any;
    const offerRequest = issuanceConfigService.getOffer.mock.lastCall[0];

    expect(offerRequest.credentialClaims.pid.claims).toEqual({
      'eu.europa.ec.eudi.pid.1': { given_name: 'Ada', family_name: 'Lovelace' },
    });
  });

  it('labels claim inputs with the claim name when the claim has no display label', async () => {
    component.credentialConfigs = [
      {
        id: 'membership',
        config: { format: 'dc+sd-jwt' },
        fields: [
          { path: ['name'], type: 'string', mandatory: true },
          { path: ['member_id'], type: 'string', mandatory: true },
          {
            path: ['level'],
            type: 'string',
            display: [{ locale: 'en-US', name: 'Membership level' }],
          },
          { path: ['address', 'street'], type: 'string' },
        ],
      } as any,
    ];

    await component.setClaimFormFields(['membership']);

    const fieldGroup = component.fields[0].fieldGroup ?? [];
    const labelOf = (key: string) => fieldGroup.find((field) => field.key === key)?.props?.label;
    expect(labelOf('name')).toBe('name');
    expect(labelOf('member_id')).toBe('member_id');
    expect(labelOf('level')).toBe('Membership level');

    // The object keeps its group header and no extra label; its leaves get their own name.
    const address = fieldGroup.find((field) => field.key === 'address');
    expect(address?.props?.label).toBeFalsy();
    expect(address?.fieldGroup?.find((field) => field.key === 'street')?.props?.label).toBe(
      'street'
    );
  });

  it('includes configured authorization server options in order for pre-authorized flow', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'oid4vp', id: 'pid-auth', label: 'PID Auth Server', enabled: true },
        {
          type: 'external',
          id: 'ext-auth',
          issuer: 'https://auth.example.com',
          enabled: true,
        },
        {
          type: 'chained',
          id: 'chained-auth',
          enabled: true,
          upstream: { issuer: 'https://upstream.example.com' },
        },
        { type: 'built-in', id: 'issuer-built-in', enabled: true, label: 'Issuer Local AS' },
      ],
    } as any;

    expect(component.preAuthAuthorizationServerOptions).toEqual([
      { value: 'pid-auth', label: 'PID Auth Server' },
      { value: 'ext-auth', label: 'ext-auth' },
      { value: 'chained-auth', label: 'Chained Authorization Server' },
      { value: 'issuer-built-in', label: 'Issuer Local AS' },
    ]);
  });

  it('defaults pre-authorized flow authorization server to first configured server', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'external', id: 'ext-auth', issuer: 'https://auth.example.com', enabled: true },
        { type: 'built-in', id: 'issuer-built-in', enabled: true },
      ],
    } as any;

    const defaultServer = (component as any).getDefaultAuthServerForFlow('pre_authorized_code');

    expect(defaultServer).toBe('ext-auth');
  });

  it('defaults pre-authorized flow to a built-in server when it is first configured', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'built-in', id: 'issuer-built-in', enabled: true },
        { type: 'external', id: 'ext-auth', issuer: 'https://auth.example.com', enabled: true },
      ],
    } as any;

    const defaultServer = (component as any).getDefaultAuthServerForFlow('pre_authorized_code');

    expect(defaultServer).toBe('issuer-built-in');
  });

  it('does not expose authorization servers when none are configured', () => {
    component.issuanceConfig = { authorizationServers: [] } as any;

    expect(component.preAuthAuthorizationServerOptions).toEqual([]);
    expect(component.authCodeAuthorizationServerOptions).toEqual([]);
  });

  it('selects the only available attribute provider automatically', async () => {
    component.credentialConfigs = [buildMdocConfig() as any];
    component.availableAttributeProviders = [{ id: 'provider-one' } as any];

    await component.setClaimFormFields(['pid']);

    expect(component.getWebhookFormGroup('pid')?.get('attributeProviderId')?.value).toBe(
      'provider-one'
    );
  });

  it('leaves attribute provider selection empty when multiple providers are available', async () => {
    component.credentialConfigs = [buildMdocConfig() as any];
    component.availableAttributeProviders = [
      { id: 'provider-one' } as any,
      { id: 'provider-two' } as any,
    ];

    await component.setClaimFormFields(['pid']);

    expect(component.getWebhookFormGroup('pid')?.get('attributeProviderId')?.value).toBe('');
  });

  it('auto-selects the only authorization server and excludes built-in for auth code', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'external', id: 'external-auth', issuer: 'https://auth.example.com' },
        { type: 'built-in', id: 'issuer-built-in' },
      ],
    } as any;

    (component as any).syncAuthorizationServerControl('authorization_code');

    expect(component.authCodeAuthorizationServerOptions).toEqual([
      { value: 'external-auth', label: 'external-auth' },
    ]);
    expect(component.configStepForm.get('authorization_server')?.value).toBe('external-auth');
    expect(component.configStepForm.get('authorization_server')?.valid).toBe(true);
  });

  it('requires a valid explicit selection when multiple servers are available', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'external', id: 'first-auth', issuer: 'https://first.example.com' },
        { type: 'oid4vp', id: 'second-auth' },
      ],
    } as any;

    (component as any).syncAuthorizationServerControl('pre_authorized_code');

    expect(component.configStepForm.get('authorization_server')?.value).toBe('');
    expect(component.configStepForm.get('authorization_server')?.invalid).toBe(true);

    component.configStepForm.patchValue({ authorization_server: 'second-auth' });
    expect(component.configStepForm.get('authorization_server')?.valid).toBe(true);
  });

  it('clears a stale authorization server when the flow changes', () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'external', id: 'external-auth', issuer: 'https://auth.example.com' },
        { type: 'built-in', id: 'issuer-built-in' },
      ],
    } as any;
    component.configStepForm.patchValue({ authorization_server: 'issuer-built-in' });

    (component as any).syncAuthorizationServerControl('authorization_code');

    expect(component.configStepForm.get('authorization_server')?.value).toBe('external-auth');
  });

  it('submits the selected authorization server identifier', async () => {
    component.issuanceConfig = {
      authorizationServers: [
        { type: 'external', id: 'first-auth', issuer: 'https://first.example.com' },
        { type: 'oid4vp', id: 'second-auth' },
      ],
    } as any;
    component.credentialConfigs = [buildMdocConfig() as any];
    await component.setClaimFormFields(['pid']);
    component.credentialStepForm.patchValue({ credentialConfigurationIds: ['pid'] });
    component.configStepForm.patchValue({
      authorization_server: 'second-auth',
      claims: { pid: { given_name: 'Ada', family_name: 'Lovelace' } },
    });

    await component.onSubmit();

    const issuanceConfigService = TestBed.inject(IssuanceConfigService) as any;
    expect(issuanceConfigService.getOffer.mock.lastCall[0].authorization_server).toBe(
      'second-auth'
    );
  });

  describe('credential configuration picker', () => {
    beforeEach(() => {
      component.credentialConfigs = [
        { id: 'pid', description: 'Person identification data' },
        { id: 'pid-mdoc', description: 'PID in ISO mdoc format' },
        { id: 'membership', description: null },
        { id: 'login', description: 'Login with IAE', iaeActions: [{}] },
      ] as any;
      vi.mocked(TestBed.inject(CredentialConfigService).loadConfigurations).mockResolvedValue(
        component.credentialConfigs
      );
    });

    it('suggests only configs of the selected flow', () => {
      expect(component.filteredCredentialConfigs.map((c) => c.id)).toEqual([
        'pid',
        'pid-mdoc',
        'membership',
      ]);
    });

    it('filters by ID or description, ignoring case', () => {
      component.credentialConfigFilter = 'MDOC';
      expect(component.filteredCredentialConfigs.map((c) => c.id)).toEqual(['pid-mdoc']);

      component.credentialConfigFilter = 'identification';
      expect(component.filteredCredentialConfigs.map((c) => c.id)).toEqual(['pid']);
    });

    it('adds a picked config, clears the filter and stops suggesting it', () => {
      const input = document.createElement('input');
      input.value = 'mdoc';
      component.credentialConfigFilter = 'mdoc';

      component.selectCredentialConfig('pid-mdoc', input);

      expect(component.selectedCredentialConfigIds).toEqual(['pid-mdoc']);
      expect(component.credentialConfigFilter).toBe('');
      expect(input.value).toBe('');
      expect(component.filteredCredentialConfigs.map((c) => c.id)).toEqual(['pid', 'membership']);
    });

    it('clears the filter and suggests IAE configs only after switching to the IAE flow', async () => {
      await component.ngOnInit();
      component.credentialConfigFilter = 'mdoc';

      component.flowStepForm.patchValue({ flow: 'authorization_code_iae' });

      expect(component.credentialConfigFilter).toBe('');
      expect(component.filteredCredentialConfigs.map((c) => c.id)).toEqual(['login']);
    });

    describe('rendered', () => {
      async function render(selected: string[] = []): Promise<void> {
        fixture.detectChanges();
        await fixture.whenStable();
        component.credentialStepForm.patchValue({ credentialConfigurationIds: selected });
        fixture.detectChanges();
      }

      function openSuggestions(filter: string): string[] {
        component.credentialConfigFilter = filter;
        fixture.detectChanges();
        fixture.debugElement
          .query(By.directive(MatAutocompleteTrigger))
          .injector.get(MatAutocompleteTrigger)
          .openPanel();
        fixture.detectChanges();
        return Array.from(document.querySelectorAll('mat-option')).map((option) =>
          option.textContent!.replace(/\s+/g, ' ').trim()
        );
      }

      it('removes a chip with its remove button and shows the required error', async () => {
        await render(['pid']);
        const remove = fixture.nativeElement.querySelector(
          'button[aria-label="Remove pid"]'
        ) as HTMLButtonElement;

        remove.click();
        fixture.detectChanges();

        expect(component.selectedCredentialConfigIds).toEqual([]);
        expect(fixture.nativeElement.textContent).toContain(
          'At least one credential configuration is required'
        );
      });

      it('keeps the claim step when focus leaves the picker without a change', async () => {
        await render(['pid']);
        await fixture.whenStable();
        component.elements[0].claimSource = 'attributeProvider';
        const input = fixture.nativeElement.querySelector(
          'input[placeholder="Type to filter by ID or description"]'
        ) as HTMLInputElement;

        input.focus();
        input.value = 'mem';
        input.dispatchEvent(new Event('input'));
        input.blur();
        await new Promise((resolve) => setTimeout(resolve));
        fixture.detectChanges();

        expect(component.selectedCredentialConfigIds).toEqual(['pid']);
        expect(component.elements[0].claimSource).toBe('attributeProvider');
      });

      it('keeps the claim step of a preselected config when focus leaves the picker', async () => {
        component.credentialConfigs = [{ id: 'pid', description: null }] as any;
        vi.mocked(TestBed.inject(CredentialConfigService).loadConfigurations).mockResolvedValue(
          component.credentialConfigs
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(component.selectedCredentialConfigIds).toEqual(['pid']);
        component.elements[0].claimSource = 'attributeProvider';
        const input = fixture.nativeElement.querySelector(
          'input[placeholder="Type to filter by ID or description"]'
        ) as HTMLInputElement;

        input.focus();
        input.blur();
        await new Promise((resolve) => setTimeout(resolve));

        expect(component.elements[0].claimSource).toBe('attributeProvider');
      });

      it('drops typed text that was not picked when the suggestions close', async () => {
        await render();
        const input = fixture.nativeElement.querySelector(
          'input[placeholder="Type to filter by ID or description"]'
        ) as HTMLInputElement;
        input.value = 'mem';
        openSuggestions('mem');

        fixture.debugElement
          .query(By.directive(MatAutocompleteTrigger))
          .injector.get(MatAutocompleteTrigger)
          .closePanel();
        fixture.detectChanges();

        expect(component.credentialConfigFilter).toBe('');
        expect(input.value).toBe('');
        expect(component.selectedCredentialConfigIds).toEqual([]);
      });

      it('lists ID and description and says when nothing matches', async () => {
        await render();

        expect(openSuggestions('mdoc')).toEqual(['pid-mdoc PID in ISO mdoc format']);
        expect(openSuggestions('zzz')).toEqual(['No credential configuration matches "zzz"']);
      });

      it('says when every config is selected', async () => {
        await render(['pid', 'pid-mdoc', 'membership']);

        expect(openSuggestions('')).toEqual(['All credential configurations are selected']);
      });
    });
  });
});
