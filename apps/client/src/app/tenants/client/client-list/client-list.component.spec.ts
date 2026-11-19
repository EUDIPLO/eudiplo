import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter, Router } from '@angular/router';
import { client, type ClientEntity } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { ApiService } from '../../../core';
import { JwtService } from '../../../services/jwt.service';
import { FrontendConfigService } from '../../../services/frontend-config.service';
import { ClientListComponent } from './client-list.component';
import { errorSnackBarDuration } from '../../../utils/error-snackbar';

/** Skips the request on init: each test puts the clients on the list itself. */
function stubLoad() {
  return vi.spyOn(ClientListComponent.prototype, 'loadItems').mockImplementation(async function (
    this: ClientListComponent
  ) {
    this.loading = false;
  });
}

/** Puts clients on the list as if they had loaded. */
function showClients(component: ClientListComponent, clients: ClientEntity[]): void {
  Object.assign(component, { items: clients });
}

describe('ClientListComponent role limits', () => {
  let fixture: ComponentFixture<ClientListComponent>;
  let component: ClientListComponent;

  beforeEach(async () => {
    stubLoad();
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage', 'issuance:offer'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ClientListComponent);
    component = fixture.componentInstance;
    showClients(component, [
      { clientId: 'offer', roles: ['issuance:offer'] },
      { clientId: 'registrar', roles: ['registrar:manage'] },
    ] as ClientEntity[]);
    fixture.detectChanges();
  });

  afterEach(() => vi.restoreAllMocks());

  function actions(row: number): HTMLButtonElement[] {
    const rows = fixture.nativeElement.querySelectorAll('tr.mat-mdc-row');
    return [...rows[row].querySelectorAll('td:last-child button')] as HTMLButtonElement[];
  }

  /** Disabled, or (Delete) disabled but focusable so its tooltip can say why. */
  const disabled = (button: HTMLButtonElement) =>
    button.disabled || button.getAttribute('aria-disabled') === 'true';

  it('enables edit, rotate and delete for a client whose roles the caller holds', () => {
    // Edit, rotate secret, delete; the client ID links to the client's page
    expect(actions(0).map(disabled)).toEqual([false, false, false]);
  });

  it('disables edit, rotate and delete for a client with a role the caller lacks', () => {
    expect(actions(1).map(disabled)).toEqual([true, true, true]);
  });

  it('sends nothing when a disabled action is clicked', () => {
    const rotate = vi.spyOn(component, 'rotateSecret');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    actions(1)[1].click();
    actions(1)[2].click();
    expect(rotate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('ClientListComponent delete', () => {
  let fixture: ComponentFixture<ClientListComponent>;
  let requests: string[];
  let confirm: Mock<(message?: string) => boolean>;
  let logout: Mock<() => void>;
  let snackBar: { open: Mock };
  /** Error body the backend answers DELETE with, or none for a 204. */
  let deleteFailure: { statusCode: number; message: string } | undefined;

  beforeEach(async () => {
    requests = [];
    deleteFailure = undefined;
    confirm = vi.fn<(message?: string) => boolean>(() => true);
    logout = vi.fn();
    snackBar = { open: vi.fn() };
    vi.stubGlobal('confirm', confirm);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubLoad();
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        if (!deleteFailure) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(deleteFailure), {
          status: deleteFailure.statusCode,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage', 'issuance:offer'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
        { provide: ApiService, useValue: { getClientId: () => 'offer', logout } },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ClientListComponent);
    showClients(fixture.componentInstance, [
      { clientId: 'offer', roles: ['issuance:offer'] },
      { clientId: 'other', roles: ['issuance:offer'] },
    ] as ClientEntity[]);
    fixture.detectChanges();
    // Let the ownership lookups settle, so the buttons no longer hold clicks back.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function deleteButton(row: number): HTMLButtonElement {
    const rows = fixture.nativeElement.querySelectorAll('tr.mat-mdc-row');
    return rows[row].querySelector('td:last-child button[aria-label^="Delete Client"]');
  }

  it('warns and signs out when the caller deletes the client they are signed in with', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const reload = vi.mocked(fixture.componentInstance.loadItems);
    reload.mockClear();

    deleteButton(0).click();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/login']));
    expect(confirm.mock.lastCall?.[0]).toContain('You are signed in with this client.');
    expect(requests).toContain('DELETE /api/client/offer');
    // Signed out first, or the login page would send the still signed-in caller back into the app.
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Client deleted. You have been signed out.',
      'Close',
      {
        duration: 3000,
      }
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the caller signed in and the list as it is when the delete fails', async () => {
    deleteFailure = { statusCode: 403, message: 'Cannot manage client offer' };
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const reload = vi.mocked(fixture.componentInstance.loadItems);
    reload.mockClear();

    deleteButton(0).click();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Failed to delete client: Cannot manage client offer',
        'Close',
        { duration: errorSnackBarDuration('Failed to delete client: Cannot manage client offer') }
      )
    );
    expect(logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(snackBar.open).toHaveBeenCalledTimes(1);
  });

  it('takes the row out of the list after deleting another client', async () => {
    const reload = vi.mocked(fixture.componentInstance.loadItems);
    reload.mockClear();

    deleteButton(1).click();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith('Client deleted successfully', 'Close', {
        duration: 3000,
      })
    );
    fixture.detectChanges();
    expect(confirm.mock.lastCall?.[0]).not.toContain('You are signed in');
    expect(requests).toContain('DELETE /api/client/other');
    expect(fixture.componentInstance.clients.map(({ clientId }) => clientId)).toEqual(['offer']);
    // The focused Delete left with its row: focus continues on the row now in its place.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(fixture.nativeElement.querySelector('a.client-link'))
    );
    expect(reload).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('ClientListComponent loading', () => {
  // The suite above stubs loadItems on the prototype.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('says why the clients could not be loaded instead of an empty list', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ statusCode: 403, message: 'Forbidden resource' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
      ],
    }).compileComponents();
    const component = TestBed.createComponent(ClientListComponent).componentInstance;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await component.loadItems();

    expect(component.loadError).toBe('Failed to load clients: Forbidden resource');
  });
});

describe('ClientListComponent rotate secret', () => {
  let fixture: ComponentFixture<ClientListComponent>;
  let confirm: Mock<(message?: string) => boolean>;
  let useRotatedSecret: Mock<(secret: string) => Promise<void>>;
  let dialog: { open: Mock };

  beforeEach(async () => {
    confirm = vi.fn<(message?: string) => boolean>(() => true);
    useRotatedSecret = vi.fn(async () => undefined);
    dialog = { open: vi.fn() };
    vi.stubGlobal('confirm', confirm);
    stubLoad();
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ secret: 'new-secret' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage', 'issuance:offer'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
        {
          provide: ApiService,
          useValue: {
            getClientId: () => 'offer',
            getBaseUrl: () => 'http://backend.test',
            useRotatedSecret,
          },
        },
      ],
    })
      .overrideProvider(MatDialog, { useValue: dialog })
      .compileComponents();

    fixture = TestBed.createComponent(ClientListComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('moves the own session to the new secret after showing it', async () => {
    await fixture.componentInstance.rotateSecret({
      clientId: 'offer',
      roles: ['issuance:offer'],
    } as ClientEntity);

    expect(confirm.mock.lastCall?.[0]).toContain('You are signed in with this client.');
    expect(dialog.open.mock.lastCall?.[1].data.secret).toBe('new-secret');
    expect(useRotatedSecret).toHaveBeenCalledWith('new-secret');
  });

  it('keeps the session for another client', async () => {
    await fixture.componentInstance.rotateSecret({
      clientId: 'other',
      roles: ['issuance:offer'],
    } as ClientEntity);

    expect(confirm.mock.lastCall?.[0]).not.toContain('You are signed in');
    expect(dialog.open).toHaveBeenCalled();
    expect(useRotatedSecret).not.toHaveBeenCalled();
  });
});

describe('ClientListComponent with another identity provider', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('explains that the identity provider manages the clients instead of offering a retry', async () => {
    vi.restoreAllMocks();
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 501,
              message: 'Clients are managed in the identity provider (OIDC_PROVIDER=generic).',
            }),
            { status: 501, headers: { 'Content-Type': 'application/json' } }
          )
      ),
    });
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: 'generic' } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('Client management is unavailable');
    });
    expect(page.textContent).toContain(
      'Clients are managed in the identity provider (OIDC_PROVIDER=generic).'
    );
    expect(page.querySelector('app-load-error')).toBeNull();
    expect(page.querySelector('.create-client')).toBeNull();
  });

  it('offers no new secret for a record left from an earlier mode', async () => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: { getRoles: () => ['clients:manage'], getTenantId: () => 'acme' },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: 'generic' } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientListComponent);
    fixture.componentRef.setInput('loadedClients', [
      { clientId: 'acme-admin', tenantId: 'acme', roles: [] } as unknown as ClientEntity,
    ]);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('acme-admin');
    });
    expect(page.querySelector('[aria-label^="Rotate Secret"]')).toBeNull();
  });
});

describe('ClientListComponent embedded in a tenant page', () => {
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  async function render(embedded: boolean) {
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenants:manage'], getTenantId: () => 'acme' },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientListComponent);
    fixture.componentInstance.loadedClients = [
      {
        clientId: 'acme-admin',
        description: 'First client',
        // Stored records may name a role twice
        roles: [
          'clients:manage',
          'issuance:offer',
          'issuance:manage',
          'presentation:request',
          'clients:manage',
          'audit:read',
          'keys:manage',
        ],
      },
    ] as ClientEntity[];
    fixture.componentInstance.embedded = embedded;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('leaves the heading to the page and shows the description under the client ID', async () => {
    const page = await render(true);

    expect(page.querySelector('h2')).toBeNull();
    expect(page.querySelector('th.mat-column-description')).toBeNull();
    expect(text(page.querySelector('.client-copy code'))).toBe('acme-admin');
    expect(text(page.querySelector('.client-copy small'))).toBe('First client');
  });

  it('shows four roles once each and names the others in "+N more"', async () => {
    const page = await render(true);

    expect(Array.from(page.querySelectorAll('.role-badge:not(.more)'), text)).toEqual([
      'clients:manage',
      'issuance:offer',
      'issuance:manage',
      'presentation:request',
    ]);
    const more = page.querySelector('.role-badge.more');
    expect(text(more)).toBe('+2 more');
    expect(more?.getAttribute('aria-label')).toBe('2 more roles: audit:read, keys:manage');
  });
});

describe('ClientListComponent page', () => {
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  async function render(clients: object[]) {
    stubLoad();
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        { provide: JwtService, useValue: { getRoles: () => ['clients:manage', 'tenant:admin'] } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientListComponent);
    showClients(fixture.componentInstance, clients as ClientEntity[]);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const ids = () => Array.from(page.querySelectorAll('tr.mat-mdc-row .client-copy code'), text);
    return { fixture, component: fixture.componentInstance, page, ids };
  }

  afterEach(() => vi.restoreAllMocks());

  const clients = [
    { clientId: 'shop-10', description: 'Web shop', roles: ['issuance:offer'] },
    { clientId: 'shop-2', roles: ['presentation:request'] },
    { clientId: 'audit', description: 'Reads the log', roles: ['audit:read'] },
  ];

  it('heads the page, offers to create a client and links each client by ID, sorted', async () => {
    const { page, ids } = await render(clients);

    expect(text(page.querySelector('h1'))).toBe('API Clients');
    expect(page.querySelector('.create-client')).not.toBeNull();
    expect(text(page.querySelector('.table-title output'))).toBe('3 clients');
    // Numbers sort by value: shop-2 before shop-10
    expect(ids()).toEqual(['audit', 'shop-2', 'shop-10']);
    expect(page.querySelector('a.client-link')?.getAttribute('href')).toBe('/audit');
    expect(page.querySelector('th.mat-column-description')).toBeNull();
  });

  it('finds clients by ID, description or role', async () => {
    const { fixture, component, page, ids } = await render(clients);

    component.search = 'shop';
    fixture.detectChanges();
    expect(ids()).toEqual(['shop-2', 'shop-10']);
    expect(text(page.querySelector('.table-title output'))).toBe('2 of 3 clients');

    component.search = 'log';
    fixture.detectChanges();
    expect(ids()).toEqual(['audit']);

    component.search = 'presentation:';
    fixture.detectChanges();
    expect(ids()).toEqual(['shop-2']);
  });

  it('says when no client matches and clears the search on request', async () => {
    const { fixture, component, page, ids } = await render(clients);
    component.search = 'nothing';
    fixture.detectChanges();

    expect(text(page.querySelector('.no-match'))).toContain('No client matches "nothing".');
    (
      Array.from(page.querySelectorAll('.no-match button')).find(
        (button) => text(button) === 'Clear search'
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(component.search).toBe('');
    expect(ids()).toHaveLength(3);
  });

  it('invites to create the first client instead of showing an empty table', async () => {
    const { page } = await render([]);

    expect(page.querySelector('table')).toBeNull();
    expect(text(page.querySelector('.empty-state'))).toContain('No clients yet');
  });

  it('shows a spinner while the clients load', async () => {
    const { fixture, component, page } = await render([]);
    component.loading = true;
    fixture.detectChanges();

    expect(page.querySelector('mat-spinner[aria-label="Loading clients"]')).not.toBeNull();
  });
});

describe('ClientListComponent Config Portability lock', () => {
  let get: Mock;

  /** Shows `clients`, from the tenant page when `tenantPage` is set, to a caller of `callerTenant`. */
  async function render(
    callerTenant: string | null,
    clients: Partial<ClientEntity>[],
    tenantPage: boolean
  ): Promise<{ fixture: ComponentFixture<ClientListComponent>; rotate: HTMLButtonElement }> {
    stubLoad();
    get = vi.fn(async (_kind: string, id: string) =>
      id === 'acme-admin' ? { ownership: 'file-managed', source: 'folder:acme' } : undefined
    );
    await TestBed.configureTestingModule({
      imports: [ClientListComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenants:manage'], getTenantId: () => callerTenant },
        },
        { provide: ConfigOwnershipService, useValue: { get } },
        { provide: FrontendConfigService, useValue: { authMode: null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClientListComponent);
    if (tenantPage) {
      fixture.componentRef.setInput('loadedClients', clients);
    } else {
      showClients(fixture.componentInstance, clients as ClientEntity[]);
    }
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const rotate = await vi.waitFor(() => {
      fixture.detectChanges();
      const button = page.querySelector<HTMLButtonElement>('[aria-label^="Rotate Secret"]');
      expect(button).not.toBeNull();
      return button!;
    });
    return { fixture, rotate };
  }

  afterEach(() => vi.restoreAllMocks());

  it('locks Rotate Secret of a file-managed client on the Clients page', async () => {
    const { fixture, rotate } = await render(
      'acme',
      [{ clientId: 'acme-admin', tenantId: 'acme', roles: [] }],
      false
    );
    const rotateSecret = vi.spyOn(fixture.componentInstance, 'rotateSecret');

    expect(get).toHaveBeenCalledWith('Client', 'acme-admin');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(rotate.getAttribute('aria-disabled')).toBe('true');
    });
    rotate.click();
    expect(rotateSecret).not.toHaveBeenCalled();
  });

  it("locks Rotate Secret of a file-managed client on the page of the caller's tenant", async () => {
    const { fixture, rotate } = await render(
      'acme',
      [{ clientId: 'acme-admin', tenantId: 'acme', roles: [] }],
      true
    );

    expect(get).toHaveBeenCalledWith('Client', 'acme-admin');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(rotate.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it.each([
    ['another tenant', 'root'],
    ['a caller without a tenant', null],
  ])('looks up no ownership on the tenant page for %s', async (_, callerTenant) => {
    const { rotate } = await render(
      callerTenant,
      [{ clientId: 'acme-admin', tenantId: 'acme', roles: [] }],
      true
    );

    expect(get).not.toHaveBeenCalled();
    expect(rotate.getAttribute('aria-disabled')).toBeNull();
    expect(rotate.getAttribute('aria-busy')).toBeNull();
  });
});
