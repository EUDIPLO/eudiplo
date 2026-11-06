import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { ApiService } from '../../core';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { FrontendConfigService } from '../../services/frontend-config.service';
import { JwtService, type Role } from '../../services/jwt.service';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { TrustListShowComponent } from './trust-list-show.component';
import { expectUnavailable, tooltipOf } from '../../common/unavailable-action.testing';

/** Answers the trust list requests of the page with this body and status, and no versions. */
function serveTrustList(trustList: object, status = 200): void {
  client.setConfig({
    fetch: async (request: RequestInfo | URL) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (path.endsWith('/versions')) {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(trustList), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

describe('TrustListShowComponent', () => {
  let component: TrustListShowComponent;
  let fixture: ComponentFixture<TrustListShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('TrustListShowComponent public URL', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Issuers accepted for membership checks',
    entityConfig: [],
  };

  async function render(publicUrl: string | undefined) {
    serveTrustList(trustList);
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: trustList.id }) } },
        },
        // The admin signed in with the Compose-internal address.
        { provide: ApiService, useValue: { getBaseUrl: () => 'http://eudiplo:3000' } },
        {
          provide: FrontendConfigService,
          useValue: { getConfig: async () => ({ configImportMode: 'disabled', publicUrl }) },
        },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(TrustListShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.publicUrl).not.toBe(''));
    fixture.detectChanges();
    return fixture;
  }

  function shownUrl(fixture: ComponentFixture<TrustListShowComponent>): string | undefined {
    const element = fixture.nativeElement as HTMLElement;
    return element.querySelector<HTMLInputElement>('.public-url-section input')?.value;
  }

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('shows the URL under the public URL of the backend, not the instance URL', async () => {
    const fixture = await render('https://eudiplo.example.com');

    expect(shownUrl(fixture)).toBe(
      'https://eudiplo.example.com/issuers/membership-demo/trust-list/membership-issuers'
    );
    expect(fixture.nativeElement.textContent).not.toContain('did not report its public URL');
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('button[mattooltip="Copy URL"]')
        ?.getAttribute('aria-label')
    ).toBe('Copy URL');
  });

  it('falls back to the instance URL with a warning when the backend reports no public URL', async () => {
    const fixture = await render(undefined);

    expect(shownUrl(fixture)).toBe(
      'http://eudiplo:3000/issuers/membership-demo/trust-list/membership-issuers'
    );
    expect(fixture.nativeElement.textContent).toContain('did not report its public URL');
  });
});

describe('TrustListShowComponent references', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Membership issuers',
    entityConfig: [],
  };
  // Names the list by trustListId, as the schema form writes it.
  const referencing = {
    id: 'membership',
    description: 'Membership card',
    schemaMeta: { trustedAuthorities: [{ trustListId: trustList.id }] },
  };
  const unrelated = { id: 'pid', description: 'PID', schemaMeta: { trustedAuthorities: [] } };
  // Another list whose id starts with the id of this one.
  const otherListCard = {
    id: 'legacy-card',
    description: 'Legacy card',
    schemaMeta: {
      trustedAuthorities: [
        { frameworkType: 'etsi_tl', value: `<TENANT_URL>/trust-list/${trustList.id}-old` },
      ],
    },
  };

  /** A presentation config whose only credential query accepts issuers from these lists. */
  function presentationConfig(id: string, description: string, refs: object[]) {
    return {
      id,
      description,
      dcql_query: {
        credentials: [
          {
            id: 'card',
            format: 'dc+sd-jwt',
            meta: { vct_values: ['urn:membership'] },
            trusted_authorities: [{ type: 'etsi_tl', values: refs }],
          },
        ],
      },
    };
  }
  const checkById = presentationConfig('door-check', 'Door check', [{ trustListId: trustList.id }]);
  const checkByUrl = presentationConfig('age-check', 'Age check', [
    { url: `<TENANT_URL>/trust-list/${trustList.id}` },
  ]);
  // Another list whose id starts with the id of this one.
  const checkOtherList = presentationConfig('legacy-check', 'Legacy check', [
    { url: `https://eudiplo.example.com/issuers/membership-demo/trust-list/${trustList.id}-old` },
  ]);

  async function render(
    roles: Role[],
    loaders: {
      credentialConfigs?: () => Promise<unknown[]>;
      presentationConfigs?: () => Promise<unknown[]>;
    } = {}
  ) {
    serveTrustList(trustList);
    const load = vi.fn(loaders.credentialConfigs ?? (async () => []));
    const loadPresentations = vi.fn(loaders.presentationConfigs ?? (async () => []));
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: trustList.id }) } },
        },
        { provide: ApiService, useValue: { getBaseUrl: () => undefined } },
        { provide: FrontendConfigService, useValue: { getConfig: async () => undefined } },
        { provide: CredentialConfigService, useValue: { loadConfigurations: load } },
        {
          provide: PresentationManagementService,
          useValue: { loadConfigurations: loadPresentations },
        },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: Role | Role[]) => [role].flat().some((r) => roles.includes(r)),
            canUseConfigPortability: () => false,
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(TrustListShowComponent);
    fixture.detectChanges();
    return { fixture, load, loadPresentations };
  }

  /** The card with this title, once its text contains `expected`. */
  async function referencesCard(
    fixture: ComponentFixture<TrustListShowComponent>,
    expected: string,
    title = 'Referenced by Credential Configs'
  ): Promise<Element> {
    let card: Element | undefined;
    await vi.waitFor(() => {
      fixture.detectChanges();
      const cards = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('mat-card'));
      card = cards.find((c) => c.querySelector('mat-card-title')?.textContent?.trim() === title);
      expect(card?.textContent).toContain(expected);
    });
    return card!;
  }

  async function referencesText(
    fixture: ComponentFixture<TrustListShowComponent>,
    expected: string,
    title?: string
  ): Promise<string> {
    return (await referencesCard(fixture, expected, title)).textContent ?? '';
  }

  const presentationsTitle = 'Referenced by Presentation Configs';

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('lists the credential configs that reference the list', async () => {
    const { fixture } = await render(['issuance:manage'], {
      credentialConfigs: async () => [referencing, unrelated, otherListCard],
    });

    const card = await referencesCard(fixture, 'Membership card');
    expect(card.textContent).not.toContain('PID');
    expect(card.textContent).not.toContain('Legacy card');
    const link = card.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/credential-config/membership');
    expect(link?.getAttribute('aria-label')).toBe('Open credential config Membership card');
  });

  // GET /api/issuer/credentials needs issuance:manage; "none" would invite deleting a used list.
  it('tells verifier admins that they cannot see the credential config references', async () => {
    const { fixture, load } = await render(['presentation:manage'], {
      credentialConfigs: async () => [referencing],
    });

    const text = await referencesText(fixture, 'You need the issuance:manage role');
    expect(text).not.toContain('No credential configs');
    expect(load).not.toHaveBeenCalled();
  });

  it('says it is loading instead of claiming that no config uses the list', async () => {
    const { fixture } = await render(['issuance:manage'], {
      credentialConfigs: () => new Promise(() => undefined),
    });

    const text = await referencesText(fixture, 'Loading credential configs');
    expect(text).not.toContain('No credential configs');
    // <output> is a status live region, so screen readers announce the loading state.
    const output = (fixture.nativeElement as HTMLElement).querySelector('output');
    expect(output?.textContent?.trim()).toBe('Loading credential configs…');
  });

  it('reports a failed load instead of claiming that no config uses the list', async () => {
    const { fixture } = await render(['issuance:manage'], {
      credentialConfigs: async () => {
        throw new Error('503');
      },
    });

    const text = await referencesText(fixture, 'Could not load the credential configs');
    expect(text).not.toContain('No credential configs');
  });

  it('lists and links the presentation configs that accept issuers from the list', async () => {
    const { fixture } = await render(['presentation:manage'], {
      presentationConfigs: async () => [checkById, checkByUrl, checkOtherList],
    });

    const card = await referencesCard(fixture, 'Door check', presentationsTitle);
    expect(card.textContent).toContain('Age check');
    expect(card.textContent).not.toContain('Legacy check');
    const links = Array.from(card.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/presentation-config/door-check', '/presentation-config/age-check']);
    expect(card.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Open presentation config Door check'
    );
  });

  it('says that no presentation config references the list', async () => {
    const { fixture } = await render(['presentation:manage'], {
      presentationConfigs: async () => [checkOtherList],
    });

    const text = await referencesText(
      fixture,
      'No presentation configs reference this trust list.',
      presentationsTitle
    );
    expect(text).not.toContain('Legacy check');
  });

  // GET /api/verifier/config also admits presentation:request.
  it('reads the presentation configs with presentation:request', async () => {
    const { fixture, loadPresentations } = await render(
      ['issuance:manage', 'presentation:request'],
      {
        presentationConfigs: async () => [checkById],
      }
    );

    await referencesCard(fixture, 'Door check', presentationsTitle);
    expect(loadPresentations).toHaveBeenCalledOnce();
  });

  it('tells issuer admins that they cannot see the presentation config references', async () => {
    const { fixture, loadPresentations } = await render(['issuance:manage'], {
      presentationConfigs: async () => [checkById],
    });

    const text = await referencesText(
      fixture,
      'You need the presentation:manage or presentation:request role',
      presentationsTitle
    );
    expect(text).not.toContain('No presentation configs');
    expect(loadPresentations).not.toHaveBeenCalled();
  });

  it('says it is loading the presentation configs instead of claiming that none uses the list', async () => {
    const { fixture } = await render(['presentation:manage'], {
      presentationConfigs: () => new Promise(() => undefined),
    });

    const card = await referencesCard(fixture, 'Loading presentation configs', presentationsTitle);
    expect(card.textContent).not.toContain('No presentation configs');
    expect(card.querySelector('output')?.textContent?.trim()).toBe('Loading presentation configs…');
  });

  it('reports a failed presentation config load instead of claiming that none uses the list', async () => {
    const { fixture } = await render(['presentation:manage'], {
      presentationConfigs: async () => {
        throw new Error('503');
      },
    });

    const card = await referencesCard(
      fixture,
      'Could not load the presentation configs',
      presentationsTitle
    );
    expect(card.textContent).not.toContain('No presentation configs');
    expect(card.querySelector('[role="alert"]')).not.toBeNull();
  });

  describe('delete question', () => {
    function askedQuestion(fixture: ComponentFixture<TrustListShowComponent>): string {
      const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
      fixture.componentInstance.delete();
      expect(confirm).toHaveBeenCalledOnce();
      return confirm.mock.calls[0][0] as string;
    }

    /** Answers DELETE with `status` and records it; other requests as `serveTrustList`. */
    function answerDelete(status: number, body?: object): string[] {
      const deletes: string[] = [];
      client.setConfig({
        fetch: async (request: RequestInfo | URL) => {
          const req = request instanceof Request ? request : new Request(String(request));
          if (req.method === 'DELETE') {
            deletes.push(req.url);
            return new Response(body ? JSON.stringify(body) : null, {
              status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const list = new URL(req.url).pathname.endsWith('/versions') ? [] : trustList;
          return new Response(JSON.stringify(list), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });
      return deletes;
    }

    // The backend refuses to delete a list that configs reference; the page says so up front.
    it('does not ask or send the delete while configs it sees reference the list', async () => {
      const { fixture } = await render(['issuance:manage', 'presentation:manage'], {
        credentialConfigs: async () => [referencing, unrelated],
        presentationConfigs: async () => [checkById, checkByUrl],
      });
      await referencesCard(fixture, 'Age check', presentationsTitle);
      await referencesCard(fixture, 'Membership card');
      const deletes = answerDelete(204);
      const confirm = vi.spyOn(globalThis, 'confirm');
      // MatSnackBarModule in the component's imports provides its own MatSnackBar.
      const snackBar = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

      fixture.componentInstance.delete();
      await fixture.whenStable();

      expect(confirm).not.toHaveBeenCalled();
      expect(deletes).toEqual([]);
      expect(snackBar).toHaveBeenCalledWith(
        'Trust list "Membership issuers" (membership-issuers) is still referenced by' +
          ' 1 credential config and 2 presentation configs. Remove these references before' +
          ' deleting it.',
        'Close',
        expect.anything()
      );
    });

    it('names the references it sees even when it cannot read the other kind', async () => {
      const { fixture } = await render(['presentation:manage'], {
        presentationConfigs: async () => [checkById],
      });
      await referencesCard(fixture, 'Door check', presentationsTitle);
      const confirm = vi.spyOn(globalThis, 'confirm');
      const snackBar = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

      fixture.componentInstance.delete();

      expect(confirm).not.toHaveBeenCalled();
      expect(snackBar).toHaveBeenCalledWith(
        'Trust list "Membership issuers" (membership-issuers) is still referenced by' +
          ' 1 presentation config. Remove these references before deleting it.',
        'Close',
        expect.anything()
      );
    });

    // References it cannot see (a role, a failed load, the issuance configuration) are the
    // backend's to report.
    it('asks for a list it sees no references to and says the backend refuses used lists', async () => {
      const { fixture } = await render(['presentation:manage'], {
        presentationConfigs: async () => {
          throw new Error('503');
        },
      });
      await referencesCard(fixture, 'Could not load the presentation configs', presentationsTitle);

      expect(askedQuestion(fixture)).toBe(
        'Delete trust list "Membership issuers" (membership-issuers)? If a configuration still' +
          ' references it, the delete is refused and the configurations are named.' +
          ' This cannot be undone.'
      );
    });

    it('names a list without description by its id', async () => {
      const { fixture } = await render(['issuance:manage']);
      await referencesCard(fixture, 'No credential configs');
      fixture.componentInstance.trustList!.description = undefined;

      expect(askedQuestion(fixture)).toMatch(/^Delete trust list "membership-issuers"\? /);
    });

    it('loads the references again when the backend refuses the delete', async () => {
      let presentationConfigs: unknown[] = [];
      const { fixture, loadPresentations } = await render(['presentation:manage'], {
        presentationConfigs: async () => presentationConfigs,
      });
      await referencesCard(fixture, 'No presentation configs', presentationsTitle);
      // Another admin adds a reference after the page loaded.
      presentationConfigs = [checkById];
      const deletes = answerDelete(409, {
        statusCode: 409,
        code: 'TRUST_LIST_IN_USE',
        message: 'Trust list "membership-issuers" is still referenced by 1 presentation config.',
        references: [{ kind: 'PresentationConfig', id: 'door-check' }],
      });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

      fixture.componentInstance.delete();

      await referencesCard(fixture, 'Door check', presentationsTitle);
      expect(deletes).toHaveLength(1);
      expect(loadPresentations).toHaveBeenCalledTimes(2);
      expect(fixture.componentInstance.deleting).toBe(false);
    });

    it('replaces a failed load with the references after a refused delete', async () => {
      let fail = true;
      const { fixture } = await render(['presentation:manage'], {
        presentationConfigs: async () => {
          if (fail) throw new Error('503');
          return [checkById];
        },
      });
      await referencesCard(fixture, 'Could not load the presentation configs', presentationsTitle);
      fail = false;
      answerDelete(409, {
        statusCode: 409,
        code: 'TRUST_LIST_IN_USE',
        message: 'Trust list "membership-issuers" is still referenced by 1 presentation config.',
        references: [{ kind: 'PresentationConfig', id: 'door-check' }],
      });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

      fixture.componentInstance.delete();

      const card = await referencesCard(fixture, 'Door check', presentationsTitle);
      expect(card.textContent).not.toContain('Could not load');
    });

    it('does not reload the references when the delete fails for another reason', async () => {
      const { fixture, loadPresentations } = await render(['presentation:manage']);
      await referencesCard(fixture, 'No presentation configs', presentationsTitle);
      answerDelete(500, { statusCode: 500, message: 'Internal Server Error' });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      const snackBar = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

      fixture.componentInstance.delete();

      await vi.waitFor(() => expect(fixture.componentInstance.deleting).toBe(false));
      expect(snackBar).toHaveBeenCalled();
      expect(loadPresentations).toHaveBeenCalledTimes(1);
    });

    it('does not send a second delete while one runs', async () => {
      const { fixture } = await render(['issuance:manage']);
      await referencesCard(fixture, 'No credential configs');
      const deletes: string[] = [];
      client.setConfig({
        fetch: async (request: RequestInfo | URL) => {
          deletes.push(String(request instanceof Request ? request.url : request));
          return new Promise<Response>(() => undefined);
        },
      });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

      fixture.componentInstance.delete();
      fixture.componentInstance.delete();

      await vi.waitFor(() => expect(deletes).toHaveLength(1));
      expect(fixture.componentInstance.deleting).toBe(true);
    });
  });
});

describe('TrustListShowComponent delete', () => {
  const trustList = { id: 'membership-issuers', tenantId: 'membership-demo', entityConfig: [] };
  const refusal = {
    statusCode: 409,
    code: 'TRUST_LIST_IN_USE',
    message:
      'Trust list "membership-issuers" is still referenced by 1 presentation config ("membership"). Remove these references before deleting the trust list.',
    references: [{ kind: 'PresentationConfig', id: 'membership' }],
  };

  /**
   * Serves the list and answers its DELETE with `status` and `body`, or not at
   * all with `'never'`. Returns the URLs of the DELETE requests.
   */
  function serve(status: number | 'never', body?: object): string[] {
    const deletes: string[] = [];
    client.setConfig({
      fetch: async (request: RequestInfo | URL) => {
        const req = request instanceof Request ? request : new Request(String(request));
        if (req.method === 'DELETE') {
          deletes.push(req.url);
          if (status === 'never') return new Promise<Response>(() => undefined);
          return body
            ? new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
              })
            : new Response(null, { status });
        }
        const list = new URL(req.url).pathname.endsWith('/versions') ? [] : trustList;
        return new Response(JSON.stringify(list), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    return deletes;
  }

  async function render() {
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: trustList.id }) } },
        },
        { provide: ApiService, useValue: { getBaseUrl: () => undefined } },
        { provide: FrontendConfigService, useValue: { getConfig: async () => undefined } },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(TrustListShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.trustList).toBeDefined());
    // MatSnackBarModule in the component's imports provides its own MatSnackBar.
    const snackBar = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    return { fixture, component: fixture.componentInstance, snackBar, navigate };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it("shows the backend's reason when the list is still referenced, and stays on the page", async () => {
    serve(409, refusal);
    const { component, snackBar, navigate } = await render();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.delete();

    await vi.waitFor(() =>
      expect(snackBar).toHaveBeenCalledWith(
        `Error deleting trust list: ${refusal.message}`,
        'Close',
        expect.anything()
      )
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps Delete focusable while the list is deleted: a second click sends one request', async () => {
    const deletes = serve('never');
    const { fixture } = await render();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fixture.detectChanges();
    const remove = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Delete list"]'
    )!;
    // Clicks are held back until the ownership lookup of the managed resource has answered.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(remove.getAttribute('aria-busy')).toBeNull();
    });
    expect(tooltipOf(fixture, remove)).toBe('Delete list');

    remove.click();
    fixture.detectChanges();
    remove.click();
    fixture.detectChanges();

    await vi.waitFor(() => expect(deletes).toHaveLength(1));
    expect(confirm).toHaveBeenCalledOnce();
    expectUnavailable(fixture, remove, 'Deleting the trust list…');
  });

  it('returns to the list after deleting', async () => {
    serve(204);
    const { component, snackBar, navigate } = await render();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.delete();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/trust-list']));
    expect(snackBar).toHaveBeenCalledWith('Trust list deleted', 'Close', { duration: 3000 });
  });
});

describe('TrustListShowComponent download', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Issuers accepted for membership checks',
    entityConfig: [],
  };

  async function render(
    downloadWithFeedback: ConfigDocumentService['downloadWithFeedback'],
    isDownloading: ConfigDocumentService['isDownloading'] = () => false
  ) {
    serveTrustList(trustList);
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: trustList.id }) } },
        },
        { provide: ApiService, useValue: { getBaseUrl: () => undefined } },
        { provide: FrontendConfigService, useValue: { getConfig: async () => undefined } },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
        {
          provide: ConfigDocumentService,
          useValue: { downloadWithFeedback, isDownloading },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(TrustListShowComponent);
    fixture.detectChanges();
    let button: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      fixture.detectChanges();
      button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        'button[aria-label="Download configuration"]'
      );
      expect(button).not.toBeNull();
    });
    return button as unknown as HTMLButtonElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('names the header actions like their tooltips', async () => {
    const button = await render(vi.fn());
    const header = button.parentElement as HTMLElement;

    expect([...header.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(
      ['Back to list', 'Edit list', 'Download configuration', 'Delete list']
    );
  });

  it('downloads the configuration of the list', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const button = await render(downloadWithFeedback);

    button.click();

    expect(downloadWithFeedback).toHaveBeenCalledWith('TrustList', trustList.id);
  });
  it('disables the download while the document of the list is being downloaded', async () => {
    const button = await render(vi.fn(), (kind, id) => kind === 'TrustList' && id === trustList.id);

    expect(button.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('TrustListShowComponent loading the list', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Issuers accepted for membership checks',
    entityConfig: [],
  };

  /** Opens the page under its real route, so relative links resolve as in the app. */
  async function render(): Promise<RouterTestingHarness> {
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([{ path: 'trust-list/:id', component: TrustListShowComponent }]),
        { provide: ApiService, useValue: { getBaseUrl: () => undefined } },
        { provide: FrontendConfigService, useValue: { getConfig: async () => undefined } },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
      ],
    }).compileComponents();

    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/trust-list/${trustList.id}`, TrustListShowComponent);
    return harness;
  }

  function retryButton(harness: RouterTestingHarness): HTMLButtonElement | undefined {
    return [
      ...harness.routeNativeElement!.querySelectorAll<HTMLButtonElement>('app-load-error button'),
    ].find((button) => button.textContent?.includes('Retry'));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('says it is loading while the list is requested', async () => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    const page = (await render()).routeNativeElement!;

    // <output> is a status live region, so screen readers announce the loading state.
    expect(page.querySelector('output')?.textContent?.trim()).toBe('Loading trust list…');
    expect(page.querySelector('app-load-error')).toBeNull();
  });

  it('stays on the page and says why the list could not be loaded', async () => {
    serveTrustList(
      {
        statusCode: 404,
        message: 'Trust list membership-issuers not found',
      },
      404
    );
    const navigate = vi.spyOn(Router.prototype, 'navigate');
    const harness = await render();
    const page = harness.routeNativeElement!;

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('app-load-error [role="alert"]')?.textContent).toContain(
        'Failed to load trust list: Trust list membership-issuers not found'
      );
    });
    expect(page.querySelector('output')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    const back = page.querySelector('app-load-error a');
    expect(back?.textContent?.trim()).toBe('Back to the list');
    expect(back?.getAttribute('href')).toBe('/trust-list');
  });

  it('leaves the focus alone when the list loads on the first try', async () => {
    serveTrustList(trustList);
    const harness = await render();
    const page = harness.routeNativeElement!;

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('h2')?.textContent).toBe('Trust List Details');
    });
    await harness.fixture.whenRenderingDone();
    expect(document.activeElement).not.toBe(page.querySelector('h2'));
  });

  it('shows the list after a retry succeeds and focuses its heading', async () => {
    serveTrustList({ statusCode: 503, message: 'Service unavailable' }, 503);
    const harness = await render();
    const page = harness.routeNativeElement!;
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(retryButton(harness)).toBeDefined();
    });

    serveTrustList(trustList);
    const retry = retryButton(harness)!;
    retry.focus();
    retry.click();
    harness.detectChanges();
    expect(page.querySelector('app-load-error')).toBeNull();
    expect(page.querySelector('output')?.textContent?.trim()).toBe('Loading trust list…');

    await vi.waitFor(() => {
      harness.detectChanges();
      const heading = page.querySelector('h2');
      expect(heading?.textContent).toBe('Trust List Details');
      // The retry removed the focused Retry button with the error card.
      expect(document.activeElement).toBe(heading);
    });
    expect(page.querySelector('app-load-error')).toBeNull();
  });
});
