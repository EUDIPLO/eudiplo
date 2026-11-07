import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { ApiService } from '../../../core';
import { PresentationManagementService } from '../../../presentation/presentation-config/presentation-management.service';
import { JwtService } from '../../../services/jwt.service';
import { grantHint } from '../../../services/role-grants';
import { ClientCreateComponent, type ConfigSource } from './client-create.component';

const PRESENTATION = 'Allowed Presentation Configurations';
const CREDENTIAL = 'Allowed Credential Configurations';
const ALL_ROLES = ['clients:manage', 'issuance:manage', 'presentation:manage'];

describe('ClientCreateComponent config restrictions', () => {
  const stored = {
    clientId: 'restricted-client',
    description: 'Restricted',
    roles: ['clients:manage'],
    allowedPresentationConfigs: ['stored-presentation'],
    allowedIssuanceConfigs: ['stored-issuance-a', 'stored-issuance-b'],
  };

  let requests: string[];
  let patchBodies: unknown[];
  /** Status and body per `GET` path; a missing path answers 200 with `[]`, a `pending` one never. */
  let responses: Record<string, { status: number; body: unknown } | 'pending'>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  /** Requests to these paths wait for their promise before they answer. */
  let gates: Record<string, Promise<void>>;

  /** Creates the page as a caller with `callerRoles`, editing the stored client unless `id` is null. */
  function create(
    callerRoles: string[],
    id: string | null = stored.clientId
  ): ComponentFixture<ClientCreateComponent> {
    TestBed.overrideProvider(JwtService, {
      useValue: {
        getRoles: () => callerRoles,
        hasRole: (role: string | string[]) =>
          (Array.isArray(role) ? role : [role]).some((r) => callerRoles.includes(r)),
        grantHint: () => grantHint(callerRoles),
        canUseConfigPortability: () => false,
      },
    });
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } },
    });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ClientCreateComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Edits the stored client and waits until the client and every list the caller may read have loaded. */
  async function render(callerRoles: string[]): Promise<ComponentFixture<ClientCreateComponent>> {
    const fixture = create(callerRoles);
    await vi.waitFor(() => {
      fixture.detectChanges();
      const state = fixture.componentInstance.configLoadState;
      expect(fixture.componentInstance.clientForm.getRawValue().clientId).toBe(stored.clientId);
      for (const source of ['presentationConfigs', 'issuanceConfigs'] as ConfigSource[]) {
        if (fixture.componentInstance.configStatus(source) === 'loading') {
          throw new Error(`${source} still loading (${state[source]})`);
        }
      }
      expect(updateButton(fixture).getAttribute('aria-busy')).toBeNull();
    });
    await settleRender(fixture);
    return fixture;
  }

  /** MatSelect picks up options that arrive after its value in a microtask. */
  async function settleRender(fixture: ComponentFixture<ClientCreateComponent>): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function host(fixture: ComponentFixture<ClientCreateComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function field(fixture: ComponentFixture<ClientCreateComponent>, label: string): HTMLElement {
    const found = [...host(fixture).querySelectorAll('mat-form-field')].find(
      (candidate) => candidate.querySelector('mat-label')?.textContent?.trim() === label
    );
    if (!found) throw new Error(`No ${label} field`);
    return found as HTMLElement;
  }

  function select(fixture: ComponentFixture<ClientCreateComponent>, label: string): HTMLElement {
    return field(fixture, label).querySelector('mat-select') as HTMLElement;
  }

  function hint(fixture: ComponentFixture<ClientCreateComponent>, label: string): string {
    return field(fixture, label).querySelector('mat-hint')?.textContent?.trim() ?? '';
  }

  function button(
    fixture: ComponentFixture<ClientCreateComponent>,
    text: string
  ): HTMLButtonElement | undefined {
    return [...host(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === text
    );
  }

  function retryCredentials(fixture: ComponentFixture<ClientCreateComponent>) {
    return button(fixture, 'refresh Retry loading credential configurations');
  }

  function updateButton(fixture: ComponentFixture<ClientCreateComponent>): HTMLButtonElement {
    const found = button(fixture, 'Update Client');
    if (!found) throw new Error('No Update Client button');
    return found;
  }

  async function submit(fixture: ComponentFixture<ClientCreateComponent>): Promise<unknown> {
    updateButton(fixture).click();
    await vi.waitFor(() => expect(patchBodies).toHaveLength(1));
    return patchBodies[0];
  }

  beforeEach(async () => {
    requests = [];
    patchBodies = [];
    responses = {
      '/api/client/restricted-client': { status: 200, body: stored },
      '/api/verifier/config': { status: 200, body: [{ id: 'other-presentation' }] },
      '/api/issuer/credentials': { status: 200, body: [{ id: 'other-issuance' }] },
    };
    snackBar = { open: vi.fn() };
    gates = {};
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method === 'PATCH') {
          patchBodies.push(await request.json());
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        await gates[path];
        const response = responses[path] ?? { status: 200, body: [] };
        if (response === 'pending') return new Promise<Response>(() => undefined);
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      imports: [ClientCreateComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: {} },
        { provide: ApiService, useValue: { getClientId: () => 'admin' } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    })
      .overrideProvider(MatSnackBar, { useValue: snackBar })
      .compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.restoreAllMocks();
  });

  it('names a config list that failed to load, locks its select and sends the stored IDs back unchanged', async () => {
    responses['/api/issuer/credentials'] = {
      status: 500,
      body: { statusCode: 500, message: 'Database unavailable' },
    };
    const fixture = await render(ALL_ROLES);

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to load credential configurations: Database unavailable'
    );
    expect(hint(fixture, CREDENTIAL)).toBe(
      'Locked: could not load credential configurations. The client stays limited to stored-issuance-a, stored-issuance-b.'
    );
    const credentials = select(fixture, CREDENTIAL);
    expect(credentials.getAttribute('aria-disabled')).toBe('true');
    // The stored IDs are options, so the select shows them instead of an empty field.
    expect(credentials.textContent).toContain('stored-issuance-a, stored-issuance-b');
    expect(retryCredentials(fixture)).toBeDefined();

    // The other list loaded: its select can be changed and keeps the stored ID next to the loaded ones.
    expect(select(fixture, PRESENTATION).getAttribute('aria-disabled')).toBe('false');
    expect(fixture.componentInstance.configOptions.presentationConfigs).toEqual([
      'other-presentation',
      'stored-presentation',
    ]);
    expect(hint(fixture, PRESENTATION)).toBe(
      'Leave empty to allow all presentation configurations'
    );

    expect(await submit(fixture)).toMatchObject({
      allowedPresentationConfigs: ['stored-presentation'],
      allowedIssuanceConfigs: ['stored-issuance-a', 'stored-issuance-b'],
    });
  });

  it('retries only the failed list and unlocks its select with the stored IDs still selected', async () => {
    responses['/api/issuer/credentials'] = {
      status: 503,
      body: { statusCode: 503, message: 'Try later' },
    };
    const fixture = await render(ALL_ROLES);
    const retry = retryCredentials(fixture);
    retry?.focus();

    responses['/api/issuer/credentials'] = {
      status: 200,
      body: [{ id: 'other-issuance' }, { id: 'stored-issuance-a' }],
    };
    requests = [];
    snackBar.open.mockClear();
    retry?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.configLoadState.issuanceConfigs).toBe('loaded');
    });
    await settleRender(fixture);

    expect(requests).toEqual(['GET /api/issuer/credentials']);
    expect(snackBar.open).not.toHaveBeenCalled();
    const credentials = select(fixture, CREDENTIAL);
    expect(credentials.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(credentials);
    expect(fixture.componentInstance.configOptions.issuanceConfigs).toEqual([
      'other-issuance',
      'stored-issuance-a',
      'stored-issuance-b',
    ]);
    // A stored ID whose config no longer exists stays selected and says so.
    expect(credentials.textContent).toContain('stored-issuance-a, stored-issuance-b (not found)');
    expect(fixture.componentInstance.clientForm.value.allowedIssuanceConfigs).toEqual([
      'stored-issuance-a',
      'stored-issuance-b',
    ]);
  });

  it('keeps the select locked and moves focus to the new Retry when a retry fails again', async () => {
    responses['/api/issuer/credentials'] = {
      status: 503,
      body: { statusCode: 503, message: 'Try later' },
    };
    const fixture = await render(ALL_ROLES);
    const retry = retryCredentials(fixture);
    retry?.focus();
    snackBar.open.mockClear();
    let releaseRetry!: () => void;
    gates['/api/issuer/credentials'] = new Promise<void>((resolve) => (releaseRetry = resolve));

    retry?.click();
    fixture.detectChanges();
    // While the list loads again, its Retry is gone and focus with it.
    expect(retryCredentials(fixture)).toBeUndefined();
    expect(document.activeElement).toBe(document.body);

    releaseRetry();
    await vi.waitFor(() => expect(snackBar.open).toHaveBeenCalled());
    await settleRender(fixture);

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to load credential configurations: Try later'
    );
    expect(select(fixture, CREDENTIAL).getAttribute('aria-disabled')).toBe('true');
    const retryAgain = retryCredentials(fixture);
    expect(retryAgain).toBeDefined();
    expect(retryAgain).not.toBe(retry);
    expect(document.activeElement).toBe(retryAgain);
  });

  it('names both lists in one snackbar when both fail and locks both selects', async () => {
    responses['/api/verifier/config'] = {
      status: 500,
      body: { statusCode: 500, message: 'Database unavailable' },
    };
    responses['/api/issuer/credentials'] = {
      status: 500,
      body: { statusCode: 500, message: 'Database unavailable' },
    };
    const fixture = await render(ALL_ROLES);

    expect(snackBar.open).toHaveBeenCalledTimes(1);
    const message = snackBar.open.mock.lastCall?.[0] as string;
    expect(message).toContain('presentation configurations');
    expect(message).toContain('credential configurations');
    for (const label of [PRESENTATION, CREDENTIAL]) {
      expect(select(fixture, label).getAttribute('aria-disabled')).toBe('true');
    }
    expect(button(fixture, 'refresh Retry loading presentation configurations')).toBeDefined();
    expect(retryCredentials(fixture)).toBeDefined();
  });

  it('does not report a failure the user has already retried successfully', async () => {
    responses['/api/issuer/credentials'] = {
      status: 503,
      body: { statusCode: 503, message: 'Try later' },
    };
    let releasePresentations!: () => void;
    gates['/api/verifier/config'] = new Promise<void>(
      (resolve) => (releasePresentations = resolve)
    );
    const fixture = create(ALL_ROLES);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(retryCredentials(fixture)).toBeDefined();
    });

    responses['/api/issuer/credentials'] = { status: 200, body: [{ id: 'other-issuance' }] };
    retryCredentials(fixture)?.click();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.configLoadState.issuanceConfigs).toBe('loaded')
    );
    releasePresentations();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.configLoadState.presentationConfigs).toBe('loaded')
    );
    await settleRender(fixture);

    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('does not request the config lists a role-limited caller cannot read and keeps the stored IDs', async () => {
    const fixture = await render(['clients:manage']);

    expect(requests).not.toContain('GET /api/verifier/config');
    expect(requests).not.toContain('GET /api/issuer/credentials');
    expect(snackBar.open).not.toHaveBeenCalled();
    expect(hint(fixture, PRESENTATION)).toBe(
      'Locked: listing presentation configurations needs presentation:manage or presentation:request. The client stays limited to stored-presentation.'
    );
    expect(hint(fixture, CREDENTIAL)).toBe(
      'Locked: listing credential configurations needs issuance:manage. The client stays limited to stored-issuance-a, stored-issuance-b.'
    );
    for (const label of [PRESENTATION, CREDENTIAL]) {
      expect(select(fixture, label).getAttribute('aria-disabled')).toBe('true');
    }
    expect(select(fixture, CREDENTIAL).textContent).toContain(
      'stored-issuance-a, stored-issuance-b'
    );
    expect(retryCredentials(fixture)).toBeUndefined();

    expect(await submit(fixture)).toMatchObject({
      description: 'Restricted',
      roles: ['clients:manage'],
      allowedPresentationConfigs: ['stored-presentation'],
      allowedIssuanceConfigs: ['stored-issuance-a', 'stored-issuance-b'],
    });
  });

  it('tells a role-limited caller that an unrestricted client stays unrestricted', async () => {
    responses['/api/client/restricted-client'] = {
      status: 200,
      body: { ...stored, allowedPresentationConfigs: null, allowedIssuanceConfigs: [] },
    };
    const fixture = await render(['clients:manage', 'presentation:request']);

    expect(requests).toContain('GET /api/verifier/config');
    expect(requests).not.toContain('GET /api/issuer/credentials');
    expect(hint(fixture, CREDENTIAL)).toBe(
      'Locked: listing credential configurations needs issuance:manage. The client may use all credential configurations.'
    );
    expect(select(fixture, PRESENTATION).getAttribute('aria-disabled')).toBe('false');
  });

  it('keeps both selects locked for a client with roles the caller may not manage', async () => {
    responses['/api/client/restricted-client'] = {
      status: 200,
      body: { ...stored, roles: ['tenant:admin'] },
    };
    // The lists answer after the client, so their loads must not unlock the locked form.
    let releaseLists!: () => void;
    const listGate = new Promise<void>((resolve) => (releaseLists = resolve));
    gates = { '/api/verifier/config': listGate, '/api/issuer/credentials': listGate };
    const fixture = create(ALL_ROLES);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.unmanageableRoles).toEqual(['tenant:admin'])
    );

    releaseLists();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.configLoadState).toEqual({
        presentationConfigs: 'loaded',
        issuanceConfigs: 'loaded',
      })
    );
    await settleRender(fixture);

    for (const label of [PRESENTATION, CREDENTIAL]) {
      expect(select(fixture, label).getAttribute('aria-disabled')).toBe('true');
    }
    // The role lock notice explains the lock; the hint only names what stays.
    expect(hint(fixture, CREDENTIAL)).toBe(
      'The client stays limited to stored-issuance-a, stored-issuance-b.'
    );
  });

  it('locks both selects and says so while their lists load', async () => {
    responses['/api/verifier/config'] = 'pending';
    responses['/api/issuer/credentials'] = 'pending';
    const fixture = create(ALL_ROLES, null);
    await settleRender(fixture);

    expect(hint(fixture, PRESENTATION)).toBe('Loading presentation configurations…');
    expect(hint(fixture, CREDENTIAL)).toBe('Loading credential configurations…');
    for (const label of [PRESENTATION, CREDENTIAL]) {
      expect(select(fixture, label).getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('says when a list loaded without any configs', async () => {
    responses['/api/issuer/credentials'] = { status: 200, body: [] };
    const fixture = create(ALL_ROLES, null);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.configLoadState.issuanceConfigs).toBe('loaded')
    );
    await settleRender(fixture);

    expect(hint(fixture, CREDENTIAL)).toBe(
      'No credential configurations exist yet. The client may use all of them, including those created later.'
    );
    expect(select(fixture, CREDENTIAL).getAttribute('aria-disabled')).toBe('false');
  });
});

describe('ClientCreateComponent back button', () => {
  async function backLabel(params: Record<string, string>): Promise<string | null> {
    await TestBed.configureTestingModule({
      imports: [ClientCreateComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(params) } },
        },
        { provide: ApiService, useValue: { getClientId: () => 'admin' } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        {
          provide: JwtService,
          useValue: {
            getRoles: () => ['clients:manage'],
            hasRole: () => false,
            grantHint: () => '',
            canUseConfigPortability: () => false,
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientCreateComponent);
    fixture.detectChanges();
    const back = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.querySelector('mat-icon')?.textContent?.trim() === 'arrow_back'
    );
    return back?.getAttribute('aria-label') ?? null;
  }

  it('names the client list it leads to when creating a client', async () => {
    expect(await backLabel({})).toBe('Back to Clients List');
  });

  it('names the client page it leads to when editing a client', async () => {
    expect(await backLabel({ id: 'some-client' })).toBe('Back to Client Details');
  });
});

describe('ClientCreateComponent Save', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };
  /** Requests other than GET, which change something. */
  let changes: string[];
  /** Set to keep changing requests unanswered, as while a save runs. */
  let changesPending: boolean;
  /** How often the stored record fails to load before it loads. */
  let loadFailures: number;
  /** Answers the pending load of the stored record, once set. */
  let finishLoad: (() => void) | undefined;
  /** Set to keep the load of the stored record unanswered until `finishLoad`. */
  let loadPending: boolean;

  beforeEach(async () => {
    snackBar = { open: vi.fn() };
    changes = [];
    changesPending = false;
    loadFailures = Infinity;
    loadPending = false;
    finishLoad = undefined;
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const path = new URL(request.url).pathname;
        if (request.method !== 'GET') {
          changes.push(`${request.method} ${path}`);
          if (changesPending) return new Promise<Response>(() => undefined);
        }
        if (path === '/api/client/stored') {
          const answer = () =>
            new Response(JSON.stringify({ clientId: 'stored', roles: ['issuance:offer'] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          if (loadPending)
            return new Promise<Response>((resolve) => (finishLoad = () => resolve(answer())));
          if (loadFailures-- <= 0) return answer();
        }
        if (path === '/api/client/broken' || path === '/api/client/stored') {
          return new Response(JSON.stringify({ statusCode: 404, message: 'Client not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const body =
          path === '/api/client/locked'
            ? { clientId: 'locked', roles: ['tenants:manage'] }
            : path === '/api/client'
              ? {}
              : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients/create', component: ClientCreateComponent },
          { path: 'clients/:id', component: ClientCreateComponent },
        ]),
        { provide: MatSnackBar, useValue: snackBar },
        { provide: ApiService, useValue: {} },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        {
          provide: PresentationManagementService,
          useValue: { loadConfigurations: async () => [] },
        },
        {
          provide: JwtService,
          useValue: {
            getRoles: () => ['clients:manage', 'issuance:offer'],
            hasRole: () => false,
            grantHint: () => '',
            // The ownership notice of an existing client asks for it.
            canUseConfigPortability: () => false,
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  async function render(url: string) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, ClientCreateComponent);
    const page = harness.routeNativeElement as HTMLElement;
    const save = (label: string) =>
      [...page.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!;
    return { harness, page, save };
  }

  it('says which fields keep a new client from saving, focuses the first one and sends nothing', async () => {
    const { harness, page, save } = await render('/clients/create');
    const create = save('Create Client');
    expect(create.disabled).toBe(false);
    expect(create.getAttribute('aria-disabled')).toBeNull();

    create.focus();
    create.click();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('clientId');
    });
    expect(
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
    ).toEqual(['Client ID is required', 'Select at least one role']);
    expect(snackBar.open).toHaveBeenLastCalledWith(
      'Check the highlighted fields.',
      'Close',
      expect.anything()
    );
    expect(changes).toEqual([]);
  });

  it('keeps Save focusable and says why a client with roles the caller cannot grant stays as it is', async () => {
    const { harness, save } = await render('/clients/locked');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(harness.routeDebugElement!.componentInstance.unmanageableRoles).toEqual([
        'tenants:manage',
      ]);
    });
    harness.detectChanges();
    const update = save('Update Client');
    const tooltip = harness
      .routeDebugElement!.queryAll(By.directive(MatTooltip))
      .find((element) => element.nativeElement === update)!
      .injector.get(MatTooltip);

    expect(update.disabled).toBe(false);
    expect(update.getAttribute('aria-disabled')).toBe('true');
    expect(tooltip.message).toBe(
      'You cannot change this client: it has roles you neither hold nor may grant'
    );
    update.click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(changes).toEqual([]);
  });

  it('waits while the client is saved: a second click sends nothing and the tooltip says why', async () => {
    changesPending = true;
    const { harness, page, save } = await render('/clients/create');
    const component = harness.routeDebugElement!.componentInstance;
    component.clientForm.patchValue({ clientId: 'new-client', roles: ['issuance:offer'] });
    harness.detectChanges();
    const create = save('Create Client');

    create.click();
    harness.detectChanges();
    create.click();
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    harness.detectChanges();

    const saving = [...page.querySelectorAll('button')].find(
      (button) => button.getAttribute('type') === 'submit'
    )!;
    expect(saving.disabled).toBe(false);
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    expect(
      harness
        .routeDebugElement!.queryAll(By.directive(MatTooltip))
        .find((element) => element.nativeElement === saving)!
        .injector.get(MatTooltip).message
    ).toBe('Saving the client…');
    await new Promise((resolve) => setTimeout(resolve));
    expect(changes).toHaveLength(1);
  });

  it('says why a client that failed to load cannot be edited, instead of an empty form', async () => {
    const { harness, page } = await render('/clients/broken');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        'Failed to load client: Client not found'
      );
    });
    expect(page.querySelector('form')).toBeNull();
    expect([...page.querySelectorAll('button')].some((b) => b.textContent?.includes('Retry'))).toBe(
      true
    );
  });

  it('says it is loading the client and shows the form only once it has loaded', async () => {
    loadPending = true;
    const { harness, page } = await render('/clients/stored');
    harness.detectChanges();

    expect(page.querySelector('form')).toBeNull();
    expect(page.querySelector('output')?.textContent).toContain('Loading client…');

    finishLoad!();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
    });
    const field = page.querySelector<HTMLInputElement>('input[formcontrolname="clientId"]')!;
    expect(field.value).toBe('stored');
    expect(field.disabled).toBe(true);
  });

  it('shows the client once a retry after a failed load succeeds, and focuses the heading', async () => {
    loadFailures = 1;
    const { harness, page } = await render('/clients/stored');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('[role="alert"]')).not.toBeNull();
    });
    const retry = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Retry')
    )!;

    retry.focus();
    retry.click();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector<HTMLInputElement>('input[formcontrolname="clientId"]')?.value).toBe(
        'stored'
      );
    });
    expect(page.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(page.querySelector('h2')));
  });
});
