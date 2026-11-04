import { NEVER } from 'rxjs';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from 'vitest';

import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { ApiService } from '../../../core';
import { JwtService } from '../../../services/jwt.service';
import { ClientShowComponent } from './client-show.component';
import { errorSnackBarDuration } from '../../../utils/error-snackbar';

describe('ClientShowComponent', () => {
  let component: ClientShowComponent;
  let fixture: ComponentFixture<ClientShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClientShowComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { getClientId: () => 'admin', sessionEnded$: NEVER } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ClientShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('names the back button for assistive technology', () => {
    const back = (fixture.nativeElement as HTMLElement).querySelector('button[routerLink="../"]');
    expect(back?.getAttribute('aria-label')).toBe('Back to Clients List');
  });
});

describe('ClientShowComponent delete', () => {
  const shown = { clientId: 'offer-client', description: 'Offers', roles: ['issuance:offer'] };

  let requests: string[];
  let deleteResponse: { status: number; body?: unknown };
  /** While set, the DELETE request waits for it, as a slow backend would. */
  let deleteGate: Promise<void> | undefined;
  let logout: Mock<() => void>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let confirm: Mock<(message?: string) => boolean>;
  let navigate: MockInstance<Router['navigate']>;
  let route: ActivatedRoute;

  async function render(
    options: { callerRoles?: string[]; managed?: boolean; signedInClientId?: string } = {}
  ): Promise<ComponentFixture<ClientShowComponent>> {
    const {
      callerRoles = ['clients:manage', 'issuance:offer'],
      managed = false,
      signedInClientId = 'admin',
    } = options;
    TestBed.overrideProvider(ApiService, {
      useValue: { getClientId: () => signedInClientId, logout },
    });
    TestBed.overrideProvider(JwtService, {
      useValue: { getRoles: () => callerRoles, canUseConfigPortability: () => false },
    });
    TestBed.overrideProvider(ConfigOwnershipService, {
      useValue: {
        get: async (kind: string, resourceId: string) =>
          managed ? { kind, resourceId, ownership: 'file-managed', generation: 1 } : undefined,
      },
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const fixture = TestBed.createComponent(ClientShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.client).toBeDefined());
    fixture.detectChanges();
    // Let the ownership lookup settle, so the button no longer holds clicks back.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(deleteButton(fixture).getAttribute('aria-busy')).toBeNull();
    });
    return fixture;
  }

  /** Lets a handler that ignored the guard reach `fetch`, so a missing request means none was sent. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
  }

  function button(
    fixture: ComponentFixture<ClientShowComponent>,
    label: string
  ): HTMLButtonElement {
    const found = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!found) throw new Error(`No ${label} button`);
    return found;
  }

  function deleteButton(fixture: ComponentFixture<ClientShowComponent>): HTMLButtonElement {
    return button(fixture, 'Delete');
  }

  beforeEach(async () => {
    requests = [];
    deleteResponse = { status: 204 };
    deleteGate = undefined;
    logout = vi.fn();
    snackBar = { open: vi.fn() };
    confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const key = `${request.method} ${new URL(request.url).pathname}`;
        requests.push(key);
        if (request.method === 'DELETE') await deleteGate;
        const { status, body } =
          request.method === 'DELETE' ? deleteResponse : { status: 200, body: shown };
        return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    route = { snapshot: { paramMap: convertToParamMap({ id: shown.clientId }) } } as ActivatedRoute;
    await TestBed.configureTestingModule({
      imports: [ClientShowComponent],
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: route }],
    })
      // The component imports MatSnackBarModule, whose provider wins over a root provider.
      .overrideProvider(MatSnackBar, { useValue: snackBar })
      .compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deletes the client after confirmation and returns to the list', async () => {
    const fixture = await render();

    deleteButton(fixture).click();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['../'], { relativeTo: route }));
    expect(confirm.mock.lastCall?.[0]).toMatch(
      /^Are you sure you want to delete client "offer-client"\?\n\nServices can no longer sign in/
    );
    expect(confirm.mock.lastCall?.[0]).not.toContain('You are signed in with this client');
    expect(requests).toContain('DELETE /api/client/offer-client');
    expect(snackBar.open).toHaveBeenCalledWith('Client deleted successfully', 'Close', {
      duration: 3000,
    });
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    confirm.mockReturnValue(false);
    const fixture = await render();

    deleteButton(fixture).click();
    await settle();

    expect(confirm).toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/client/offer-client');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('warns before the caller deletes the client they are signed in with and then signs out', async () => {
    const fixture = await render({ signedInClientId: shown.clientId });

    deleteButton(fixture).click();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/login']));
    expect(confirm.mock.lastCall?.[0]).toContain('You are signed in with this client.');
    // Signed out first, or the login page would send the still signed-in caller back into the app.
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Client deleted. You have been signed out.',
      'Close',
      { duration: 5000 }
    );
    expect(snackBar.open).not.toHaveBeenCalledWith('Client deleted successfully', 'Close', {
      duration: 3000,
    });
  });

  it('disables Edit and Delete and sends one request while the delete is running', async () => {
    let release!: () => void;
    deleteGate = new Promise((resolve) => (release = resolve));
    const fixture = await render();

    deleteButton(fixture).click();
    await settle();
    fixture.detectChanges();
    expect(deleteButton(fixture).disabled).toBe(true);
    expect(button(fixture, 'Edit').disabled).toBe(true);
    void fixture.componentInstance.deleteClient();
    release();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.startsWith('DELETE'))).toHaveLength(1);
  });

  it('does not pull the user back to the list when they left before the delete finished', async () => {
    let release!: () => void;
    deleteGate = new Promise((resolve) => (release = resolve));
    const fixture = await render();

    deleteButton(fixture).click();
    await settle();
    fixture.destroy();
    release();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith('Client deleted successfully', 'Close', {
        duration: 3000,
      })
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the backend message and stays on the page when the delete fails', async () => {
    deleteResponse = {
      status: 403,
      body: {
        statusCode: 403,
        message:
          'Cannot manage client offer-client: it has issuance:offer, which you neither hold nor may grant',
      },
    };
    const fixture = await render();

    deleteButton(fixture).click();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Failed to delete client: Cannot manage client offer-client: it has issuance:offer, which you neither hold nor may grant',
        'Close',
        {
          duration: errorSnackBarDuration(
            'Failed to delete client: Cannot manage client offer-client: it has issuance:offer, which you neither hold nor may grant'
          ),
        }
      )
    );
    expect(navigate).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(deleteButton(fixture).disabled).toBe(false);
  });

  it('keeps Delete disabled for a client with a role the caller lacks', async () => {
    const fixture = await render({ callerRoles: ['clients:manage'] });

    const button = deleteButton(fixture);
    button.click();
    await settle();

    expect(button.disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/client/offer-client');
  });

  it('blocks Delete for a file-managed client', async () => {
    const fixture = await render({ managed: true });

    const button = deleteButton(fixture);
    button.click();
    await settle();

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/client/offer-client');
  });
});
