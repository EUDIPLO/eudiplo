import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { FormControl, Validators } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatAutocompleteHarness } from '@angular/material/autocomplete/testing';
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

describe('DCQL editor hints from the credential configs of the tenant', () => {
  const pid = {
    id: 'pid',
    format: 'dc+sd-jwt',
    displayName: 'PID',
    vct: 'urn:pid',
    claims: [
      { path: ['given_name'], displayName: 'Given name', mandatory: false },
      { path: ['family_name'], displayName: 'Family name', mandatory: false },
    ],
  };

  function render(value: unknown) {
    TestBed.configureTestingModule({
      imports: [DcqlQueryEditorComponent],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(DcqlQueryEditorComponent);
    fixture.componentInstance.control = new FormControl(value);
    fixture.componentInstance.knownCredentials = [pid];
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('says which credential config issues the type and suggests its claims', () => {
    const { fixture, element } = render(query);
    const component = fixture.componentInstance;

    expect(element.textContent).toContain('Issued by this tenant\'s credential config "pid".');
    const credential = component.credentials[0];
    expect(component.claimPathSuggestions(credential, { path: [''] })).toEqual([
      'given_name',
      'family_name',
    ]);
    expect(component.claimPathSuggestions(credential, { path: ['fam'] })).toEqual(['family_name']);
    expect(component.typeSuggestions({ ...credential, type: '' })).toEqual([
      { value: 'urn:pid', label: 'PID (pid)' },
    ]);
  });

  it('writes a picked claim path suggestion into the query', async () => {
    const nested = {
      ...pid,
      claims: [{ path: ['address', 'locality'], displayName: 'Locality', mandatory: false }],
    };
    const empty = { credentials: [{ ...query.credentials[0], claims: [{ path: [''] }] }] };
    const { fixture } = render(empty);
    fixture.componentInstance.knownCredentials = [nested as never];
    fixture.detectChanges();
    const loader = TestbedHarnessEnvironment.loader(fixture);
    const autocomplete = await loader.getHarness(
      MatAutocompleteHarness.with({ selector: 'input[placeholder="given_name"]' })
    );

    await autocomplete.focus();
    await autocomplete.selectOption({ text: 'address.locality' });

    expect(fixture.componentInstance.control.value.credentials[0].claims[0].path).toEqual([
      'address',
      'locality',
    ]);
  });

  it('filters suggestions by what was typed and leaves out a finished value', () => {
    const { fixture } = render(query);
    const component = fixture.componentInstance;
    const credential = component.credentials[0];

    expect(component.typeSuggestions({ ...credential, type: 'PI' })).toEqual([
      { value: 'urn:pid', label: 'PID (pid)' },
    ]);
    expect(component.typeSuggestions({ ...credential, type: 'mdl' })).toEqual([]);
    expect(component.claimPathSuggestions(credential, { path: ['given_name'] })).toEqual([]);
  });

  it('suggests mDOC namespaces and claim names and marks a claim in another namespace', () => {
    const mdl = {
      id: 'mdl',
      format: 'mso_mdoc',
      displayName: 'Driving licence',
      doctype: 'org.iso.18013.5.1.mDL',
      claims: [
        {
          path: ['org.iso.18013.5.1', 'family_name'],
          namespace: 'org.iso.18013.5.1',
          displayName: 'Family name',
          mandatory: false,
        },
      ],
    };
    const mdocQuery = {
      credentials: [
        {
          id: 'mdl',
          format: 'mso_mdoc',
          meta: { doctype_value: 'org.iso.18013.5.1.mDL' },
          claims: [{ path: ['other', 'family_name'] }],
        },
      ],
    };
    TestBed.configureTestingModule({
      imports: [DcqlQueryEditorComponent],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(DcqlQueryEditorComponent);
    fixture.componentInstance.control = new FormControl(mdocQuery);
    fixture.componentInstance.knownCredentials = [mdl as never];
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const credential = component.credentials[0];

    expect(component.namespaceSuggestions(credential, { path: ['org', ''] })).toEqual([
      'org.iso.18013.5.1',
    ]);
    expect(
      component.claimNameSuggestions(credential, { path: ['org.iso.18013.5.1', 'fam'] })
    ).toEqual(['family_name']);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.unpublished-claim')?.textContent
    ).toContain('This tenant\'s credential config "mdl" does not publish this claim.');
  });

  it('marks a half-typed claim name only once its field is left', () => {
    const { fixture } = render(query);
    const component = fixture.componentInstance;
    const credential = component.credentials[0];
    const claim = { path: ['given_na'] };

    component.focusedClaim = claim;
    expect(component.unpublishedHint(credential, claim)).toBe('');
    component.focusedClaim = null;
    expect(component.unpublishedHint(credential, claim)).toContain('does not publish this claim');
  });

  it('marks an unpublished claim edited as path segments too', () => {
    const segments = {
      credentials: [{ ...query.credentials[0], claims: [{ path: ['urn:x:age', 0] }] }],
    };
    const { element } = render(segments);

    expect(element.querySelector('.path-segments .unpublished-claim')).toBeNull();
    const named = {
      credentials: [{ ...query.credentials[0], claims: [{ path: ['urn:x:age'] }] }],
    };
    TestBed.resetTestingModule();
    const { element: namedElement } = render(named);
    expect(namedElement.querySelector('.path-segments .unpublished-claim')?.textContent).toContain(
      'does not publish this claim'
    );
  });

  it('names several credential configs that issue the same type', () => {
    const { fixture } = render(query);
    const component = fixture.componentInstance;
    component.knownCredentials = [pid as never, { ...pid, id: 'pid-2' } as never];
    const credential = component.credentials[0];

    expect(component.issuedHint(credential)).toBe(
      'Issued by this tenant\'s credential configs "pid" and "pid-2".'
    );
    expect(component.unpublishedHint(credential, { path: ['birth_date'] })).toBe(
      'This tenant\'s credential configs "pid" and "pid-2" do not publish this claim.'
    );
  });

  it('marks a claim the issuing config does not publish, but keeps the query valid', () => {
    const unknownClaim = {
      credentials: [{ ...query.credentials[0], claims: [{ path: ['birth_date'] }] }],
    };
    const { fixture, element } = render(unknownClaim);

    expect(element.querySelector('.unpublished-claim')?.textContent).toContain(
      'This tenant\'s credential config "pid" does not publish this claim.'
    );
    expect(fixture.componentInstance.control.valid).toBe(true);
  });

  it('gives no hints for a type no local config issues', () => {
    const elsewhere = {
      credentials: [
        {
          ...query.credentials[0],
          meta: { vct_values: ['urn:elsewhere'] },
          claims: [{ path: ['birth_date'] }],
        },
      ],
    };
    const { element } = render(elsewhere);

    expect(element.textContent).not.toContain('Issued by');
    expect(element.querySelector('.unpublished-claim')).toBeNull();
    expect(element.textContent).toContain('Must match the type issued to the wallet.');
  });
});
