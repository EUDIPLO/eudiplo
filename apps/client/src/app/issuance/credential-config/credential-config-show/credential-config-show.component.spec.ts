import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatTabGroupHarness } from '@angular/material/tabs/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialConfig } from '@eudiplo/sdk-core';
import { JwtService } from '../../../services/jwt.service';

import { CredentialConfigShowComponent } from './credential-config-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { CredentialConfigService } from '../credential-config.service';

describe('CredentialConfigShowComponent', () => {
  let component: CredentialConfigShowComponent;
  let fixture: ComponentFixture<CredentialConfigShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CredentialConfigShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(CredentialConfigShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('CredentialConfigShowComponent schema links', () => {
  function render(roles: string[], extra: Record<string, unknown> = {}): HTMLElement {
    TestBed.configureTestingModule({
      imports: [CredentialConfigShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string) => roles.includes(role),
            // Read by the ownership notice the screen renders.
            canUseConfigPortability: () => false,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(CredentialConfigShowComponent);
    fixture.componentInstance.config = {
      id: 'pid',
      config: { format: 'dc+sd-jwt' },
      ...extra,
    } as unknown as CredentialConfig;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const createSchema = '[aria-label="Create schema for this configuration"]';
  const linked = { schemaMeta: { id: 'https://registrar.example/schema-metadata/schema-1' } };

  it('offers Create schema to users who can open the schema pages', () => {
    expect(
      render(['issuance:manage', 'registrar:manage']).querySelector(createSchema)
    ).not.toBeNull();
  });

  it('hides Create schema without registrar:manage, which would end in "Access denied"', () => {
    expect(render(['issuance:manage']).querySelector(createSchema)).toBeNull();
  });

  it('links the linked schema for users who can open it', () => {
    const page = render(['issuance:manage', 'registrar:manage'], linked);

    expect(page.querySelector('a[href="/schema/schema-1"]')).not.toBeNull();
  });

  it('shows the linked schema as text without registrar:manage', () => {
    const page = render(['issuance:manage'], linked);

    expect(page.querySelector('a[href="/schema/schema-1"]')).toBeNull();
    expect(page.textContent).toContain('https://registrar.example/schema-metadata/schema-1');
  });
});

describe('CredentialConfigShowComponent loading', () => {
  it('says why the configuration could not be loaded instead of a blank page', async () => {
    const component = new CredentialConfigShowComponent(
      {
        getConfig: vi.fn().mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' }),
      } as never,
      {} as never,
      { snapshot: { paramMap: { get: () => 'pid' } } } as never,
      { open: vi.fn() } as never,
      { navigate: vi.fn() } as never,
      {} as never,
      { hasRole: () => true } as never,
      {} as never
    );

    component.loadConfig();

    await vi.waitFor(() =>
      expect(component.loadError).toBe(
        'Failed to load credential configuration: Forbidden resource'
      )
    );
  });
});

describe('CredentialConfigShowComponent download', () => {
  it('downloads the configuration document', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const component = new CredentialConfigShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { downloadWithFeedback } as never
    );
    component.config = { id: 'pid' } as never;

    await component.downloadConfig();

    expect(downloadWithFeedback).toHaveBeenCalledWith('CredentialConfig', 'pid');
  });

  it('disables the button while the document is being downloaded', async () => {
    const button = await renderDownloadButton(CredentialConfigShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'pid' }) } },
        },
        {
          provide: CredentialConfigService,
          useValue: { getConfig: async () => ({ id: 'pid', config: { format: 'dc+sd-jwt' } }) },
        },
      ],
      loaded: (component) => !!component.config,
      downloading: ['CredentialConfig', 'pid'],
    });

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another resource is being downloaded', async () => {
    const button = await renderDownloadButton(CredentialConfigShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'pid' }) } },
        },
        {
          provide: CredentialConfigService,
          useValue: { getConfig: async () => ({ id: 'pid', config: { format: 'dc+sd-jwt' } }) },
        },
      ],
      loaded: (component) => !!component.config,
      downloading: ['CredentialConfig', 'other'],
    });

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('CredentialConfigShowComponent claim fields', () => {
  const fields = [
    {
      path: ['birthdate'],
      type: 'string',
      mandatory: true,
      disclosable: true,
      constraints: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      display: [{ locale: 'en-US', name: 'Date of birth' }],
    },
    {
      path: ['address'],
      type: 'object',
      constraints: {},
      children: [
        {
          path: ['country'],
          type: 'string',
          defaultValue: 'NL',
          disclosable: false,
          constraints: { minLength: 2, maxLength: 2 },
          display: [{ locale: 'de-DE', name: 'Land' }],
        },
      ],
    },
  ];

  async function renderTab(label: RegExp, format = 'dc+sd-jwt'): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      imports: [CredentialConfigShowComponent],
      providers: [
        provideRouter([]),
        // Without animations the selected tab's body replaces the first one at once.
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
        {
          provide: JwtService,
          useValue: { hasRole: () => true, canUseConfigPortability: () => false },
        },
      ],
    });
    const fixture = TestBed.createComponent(CredentialConfigShowComponent);
    fixture.componentInstance.config = {
      id: 'pid',
      config: { format },
      fields,
    } as unknown as CredentialConfig;
    fixture.detectChanges();

    const tabs = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatTabGroupHarness);
    await tabs.selectTab({ label });
    return fixture.nativeElement as HTMLElement;
  }

  function claimCard(page: HTMLElement, path: string): string {
    const item = Array.from(page.querySelectorAll('.claim-metadata-item')).find(
      (element) => element.querySelector('.claim-path')?.textContent?.trim() === path
    );
    return item?.textContent ?? '';
  }

  function matrixRow(page: HTMLElement, key: string): string {
    const row = Array.from(page.querySelectorAll('.claims-matrix-row')).find(
      (element) => element.querySelector('.field-path code')?.textContent?.trim() === key
    );
    return row?.textContent ?? '';
  }

  it('shows type, default value and constraints of every field, nested children included', async () => {
    const page = await renderTab(/Visual/);

    const birthdate = claimCard(page, 'birthdate');
    expect(birthdate).toContain('Type: string');
    expect(birthdate).toContain('Constraints');
    expect(birthdate).toContain('"pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"');

    const country = claimCard(page, 'address > country');
    expect(country).toContain('Type: string');
    expect(country).toContain('Default Value');
    expect(country).toContain('NL');
    expect(country).toContain('"minLength": 2');
    expect(country).toContain('Land');
  });

  it('lists nested children with their constraints and display labels in the matrix', async () => {
    const page = await renderTab(/Claims/);

    const birthdate = matrixRow(page, 'birthdate');
    expect(birthdate).toContain('"pattern"');
    expect(birthdate).toContain('en-US: Date of birth');

    const country = matrixRow(page, 'address.country');
    expect(country).toContain('NL');
    expect(country).toContain('"maxLength": 2');
    expect(country).toContain('de-DE: Land');
  });

  it('says on SD-JWT cards whether each claim is disclosable', async () => {
    const page = await renderTab(/Visual/);

    expect(claimCard(page, 'birthdate')).toContain('Disclosable');
    expect(claimCard(page, 'address > country')).toContain('Non-disclosable');
  });

  it('leaves empty constraints out of the card', async () => {
    expect(claimCard(await renderTab(/Visual/), 'address')).not.toContain('Constraints');
  });

  it('leaves empty constraints out of the matrix', async () => {
    const row = matrixRow(await renderTab(/Claims/), 'address');

    expect(row).toContain('object');
    expect(row).not.toContain('{');
  });

  it('shows no disclosure chip on mdoc claims, where the matrix says N/A', async () => {
    const page = await renderTab(/Visual/, 'mso_mdoc');

    expect(claimCard(page, 'birthdate')).toContain('Type: string');
    expect(claimCard(page, 'birthdate')).not.toContain('Disclosable');
  });

  it('names array items with * in the card heading, as the matrix does', () => {
    const component = new CredentialConfigShowComponent(
      ...(Array.from({ length: 8 }, () => ({})) as never as ConstructorParameters<
        typeof CredentialConfigShowComponent
      >)
    );

    expect(component.claimPathLabel(['tags', null])).toBe('tags > *');
    expect(component.claimPathLabel(['address', 'country'])).toBe('address > country');
  });

  it('shows the JSON Schema when a nested child leaves a matrix cell empty', () => {
    const component = new CredentialConfigShowComponent(
      ...(Array.from({ length: 8 }, () => ({})) as never as ConstructorParameters<
        typeof CredentialConfigShowComponent
      >)
    );
    const parent = { path: ['tags'], type: 'array', mandatory: true, disclosable: true };
    const configWith = (field: object) =>
      ({
        id: 'pid',
        config: { format: 'dc+sd-jwt' },
        fields: [field],
      }) as unknown as CredentialConfig;

    component.config = configWith(parent);
    expect(component.showJsonSchemaSection).toBe(false);

    component.config = configWith({ ...parent, children: [{ path: [null], type: 'string' }] });
    expect(component.showJsonSchemaSection).toBe(true);
  });
});
