import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { ApiService } from '../../../core';
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
