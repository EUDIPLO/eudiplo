import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { FormControl, Validators } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaFormValidator } from '../../../utils/schema-form-validator';
import { DCQLSchema } from '../../../utils/schemas';
import { DcqlQueryEditorComponent } from './dcql-query-editor.component';
import { FederationTrustAnchorService } from '../../../federation-trust-anchor/federation-trust-anchor.service';
import { FederationTrustAnchorSelectComponent } from '../../../federation-trust-anchor/federation-trust-anchor-select/federation-trust-anchor-select.component';

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

function editor(value: unknown = null) {
  const component = new DcqlQueryEditorComponent();
  component.control = new FormControl(value, [
    Validators.required,
    schemaFormValidator(DCQLSchema),
  ]);
  component.ngOnInit();
  return component;
}

describe('DCQL editor shared form state', () => {
  it('preserves the original value when switching views', () => {
    const component = editor(query);
    component.setJsonMode(true);
    component.setJsonMode(false);
    expect(component.control.value).toBe(query);
    expect(component.control.valid).toBe(true);
    component.ngOnDestroy();
  });

  it('automatically falls back for advanced imports and never replaces them', () => {
    const component = editor(query);
    const advanced = { credentials: [{ ...query.credentials[0], multiple: true }] };
    component.control.setValue(advanced);
    expect(component.jsonMode).toBe(true);
    expect(component.supported).toBe(false);
    component.setJsonMode(false);
    expect(component.jsonMode).toBe(true);
    expect(component.control.value).toBe(advanced);
    expect(component.control.valid).toBe(true);
    component.ngOnDestroy();
  });

  it('blocks incomplete visual drafts and updates the shared control when completed', () => {
    const component = editor();
    component.addCredential();
    expect(component.control.invalid).toBe(true);
    component.credentials[0].type = 'urn:membership';
    component.credentials[0].claims = [{ path: ['member_id'] }, { path: ['address', 'locality'] }];
    component.updateQuery();
    expect(component.control.valid).toBe(true);
    expect(component.control.value.credentials[0].claims[1].path).toEqual(['address', 'locality']);
    component.removeCredential(0);
    expect(component.control.invalid).toBe(true);
    component.ngOnDestroy();
  });

  it('accepts a credential query without claims and omits the claims array', () => {
    const component = editor(query);
    component.removeClaim(component.credentials[0], 0);
    expect(component.control.valid).toBe(true);
    expect(component.control.value.credentials[0]).not.toHaveProperty('claims');
    const { id, format, meta } = query.credentials[0];
    component.control.setValue({ credentials: [{ id, format, meta }] });
    expect(component.jsonMode).toBe(false);
    expect(component.credentials[0].claims).toEqual([]);
    expect(component.control.valid).toBe(true);
    component.ngOnDestroy();
  });

  it('keeps schema validation when the visual editor is destroyed', () => {
    const component = editor(query);
    component.ngOnDestroy();
    component.control.setValue('{');
    expect(component.control.hasError('invalidJson')).toBe(true);
    component.control.setValue({ credentials: [] });
    expect(component.control.hasError('invalidSchema')).toBe(true);
  });
  it('updates set references on rename and flags deletion without weakening the requirement', () => {
    const component = editor(query);
    component.configureAlternatives(true);
    component.renameCredential(component.credentials[0], 'identity');
    expect(component.control.value.credential_sets[0].options).toEqual([['identity']]);
    component.addCredential();
    component.credentials[1].type = 'urn:membership';
    component.credentials[1].claims = [{ path: ['member_id'] }];
    component.removeCredential(0);
    expect(component.control.value.credential_sets[0].options).toEqual([['identity']]);
    expect(component.control.errors?.['simpleQuery']).toContain('missing credential');
    component.ngOnDestroy();
  });

  it('keeps options, paths and trust material intact when adding another claim', () => {
    const imported = {
      ...query,
      credentials: [
        {
          ...query.credentials[0],
          claims: [{ path: ['items', 0, 'literal.name'], id: 'name', values: ['Erika'] }],
          trusted_authorities: [
            {
              type: 'etsi_tl',
              values: [
                {
                  url: 'https://trust.example',
                  verifierKey: { kty: 'EC', x: 'x' },
                  verifierX509Der: 'cert',
                },
              ],
            },
          ],
        },
      ],
    };
    const component = editor(imported);
    expect(component.supported).toBe(true);
    component.addClaim(component.credentials[0]);
    component.credentials[0].claims[1].path = ['family_name'];
    component.updateQuery();
    expect(component.control.value.credentials[0].claims[0]).toEqual(
      imported.credentials[0].claims[0]
    );
    expect(component.control.value.credentials[0].trusted_authorities).toEqual(
      imported.credentials[0].trusted_authorities
    );
    expect(component.control.valid).toBe(true);
    component.ngOnDestroy();
  });

  it('pastes into rows without dropping existing constraints or adding duplicates', () => {
    const component = editor(query);
    component.credentials[0].claims[0].values = ['Erika'];
    component.pastedClaims.set(component.credentials[0], 'given_name\naddress.locality');
    component.pasteClaims(component.credentials[0]);
    expect(component.control.value.credentials[0].claims).toEqual([
      { path: ['given_name'], values: ['Erika'] },
      { path: ['address', 'locality'] },
    ]);
    component.ngOnDestroy();
  });

  it('removes stale resolved material when a different managed trust list is selected', () => {
    const component = editor(query);
    const authority = {
      type: 'etsi_tl' as const,
      values: [{ trustListId: 'old', verifierX509Der: 'old-cert', url: 'https://old.example' }],
    };
    component.credentials[0].trustedAuthorities = [authority];
    component.selectTrustList(authority, 0, 'new');
    expect(component.control.value.credentials[0].trusted_authorities[0].values).toEqual([
      { trustListId: 'new' },
    ]);
    component.ngOnDestroy();
  });

  it('preserves the distinction between numeric indexes and numeric property names', () => {
    const component = editor(query);
    const claim = component.credentials[0].claims[0];
    claim.path = ['items', '0'];
    component.setSegmentKind(claim, 1, 'index');
    component.setArrayIndex(claim, 1, 2);
    expect(component.control.value.credentials[0].claims[0].path).toEqual(['items', 2]);
    component.setArrayIndex(claim, 1, null);
    expect(component.control.invalid).toBe(true);
    component.ngOnDestroy();
  });
});

describe('DCQL editor managed trust lists', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it("shows the backend's reason with one period when the trust lists cannot be loaded", async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 403, message: 'Use a tenant-bound account.' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          )
      ),
    });
    const component = editor(query);

    await component.loadTrustLists();

    expect(component.trustListsError).toBe(
      'Could not load managed trust lists: Use a tenant-bound account. ' +
        'Existing references are preserved. Retry or add an external reference.'
    );
    component.ngOnDestroy();
  });
});

describe('DCQL editor federation authorities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picks a registered trust anchor and writes its entity ID to the query', async () => {
    const anchors = [
      { id: 'eu', tenantId: 't', entityId: 'https://ta.example', jwks: { keys: [] } },
    ];
    TestBed.configureTestingModule({
      imports: [DcqlQueryEditorComponent],
      providers: [
        provideRouter([]),
        {
          provide: FederationTrustAnchorService,
          useValue: {
            registeredAnchors: vi.fn().mockResolvedValue(anchors),
            loaded: new Subject(),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(DcqlQueryEditorComponent);
    fixture.componentInstance.control = new FormControl(query);
    fixture.detectChanges();
    fixture.componentInstance.addTrust(fixture.componentInstance.credentials[0], 'federation');
    fixture.detectChanges();

    const picker = fixture.debugElement.query(By.directive(FederationTrustAnchorSelectComponent))
      .componentInstance as FederationTrustAnchorSelectComponent;
    await vi.waitFor(() => expect(picker.loaded).toBe(true));
    picker.selection.setValue('https://ta.example');

    expect(fixture.componentInstance.control.value.credentials[0].trusted_authorities).toEqual([
      { type: 'openid_federation', values: ['https://ta.example'] },
    ]);
    fixture.destroy();
  });
});
