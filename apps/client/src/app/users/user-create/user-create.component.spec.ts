import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtService } from '../../services/jwt.service';
import { UserCreateComponent } from './user-create.component';

describe('UserCreateComponent Save', () => {
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
          path === '/api/user/locked'
            ? { id: 'locked', username: 'locked', enabled: true, roles: ['tenants:manage'] }
            : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'users/create', component: UserCreateComponent },
          { path: 'users/:id', component: UserCreateComponent },
        ]),
        { provide: MatSnackBar, useValue: snackBar },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  async function render(url: string) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, UserCreateComponent);
    const page = harness.routeNativeElement as HTMLElement;
    const save = (label: string) =>
      [...page.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!;
    return { harness, page, save };
  }

  it('says which fields keep a new user from saving, focuses the first one and sends nothing', async () => {
    const { harness, page, save } = await render('/users/create');
    const create = save('Create User');
    expect(create.disabled).toBe(false);
    expect(create.getAttribute('aria-disabled')).toBeNull();

    create.focus();
    create.click();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('username');
    });
    expect(
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
    ).toEqual(['Username is required', 'Select at least one role']);
    expect(snackBar.open).toHaveBeenLastCalledWith(
      'Check the highlighted fields.',
      'Close',
      expect.anything()
    );
    expect(changes).toEqual([]);
  });

  it('keeps Save focusable and says why a user with roles the caller cannot grant stays as it is', async () => {
    const { harness, save } = await render('/users/locked');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(harness.routeDebugElement!.componentInstance.unmanageableRoles).toEqual([
        'tenants:manage',
      ]);
    });
    harness.detectChanges();
    const update = save('Update User');
    const tooltip = harness
      .routeDebugElement!.queryAll(By.directive(MatTooltip))
      .find((element) => element.nativeElement === update)!
      .injector.get(MatTooltip);

    expect(update.disabled).toBe(false);
    expect(update.getAttribute('aria-disabled')).toBe('true');
    expect(tooltip.message).toBe(
      'You cannot change this user: it has roles you neither hold nor may grant'
    );
    update.click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(changes).toEqual([]);
  });
});
