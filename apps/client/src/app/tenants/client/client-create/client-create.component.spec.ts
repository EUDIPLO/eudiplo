import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../../core';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { PresentationManagementService } from '../../../presentation/presentation-config/presentation-management.service';
import { JwtService } from '../../../services/jwt.service';
import { ClientCreateComponent } from './client-create.component';

describe('ClientCreateComponent Save', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };
  /** Requests other than GET, which change something. */
  let changes: string[];

  beforeEach(async () => {
    snackBar = { open: vi.fn() };
    changes = [];
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const path = new URL(request.url).pathname;
        if (request.method !== 'GET') changes.push(`${request.method} ${path}`);
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
});
