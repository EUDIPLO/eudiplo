import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JwtService } from '../../services/jwt.service';
import { userRoutes } from '../users.routes';
import { UserShowComponent } from './user-show.component';

describe('UserShowComponent', () => {
  const user = {
    id: 'u-1',
    username: 'alice',
    email: 'alice@example.com',
    enabled: true,
    roles: ['issuance:offer', 'audit:read', 'issuance:offer'],
  };
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  /** Opens the user's page under the real user routes; `answer` is the user, or none to wait. */
  async function render(
    answer: object | null,
    callerRoles = ['tenant:admin'],
    deleteAnswer: Response | null = null
  ) {
    const requests: string[] = [];
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === 'DELETE') {
          return deleteAnswer ?? new Promise<Response>(() => undefined);
        }
        if (!answer) return new Promise<Response>(() => undefined);
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => callerRoles } },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users/u-1', UserShowComponent);
    const page = harness.routeNativeElement as HTMLElement;
    if (answer) {
      await vi.waitFor(() => {
        harness.detectChanges();
        expect(page.querySelector('h1')).not.toBeNull();
      });
    }
    return { harness, page, requests };
  }

  /** Whether the button is turned off, also while it stays focusable to say why. */
  const off = (b: HTMLButtonElement) => b.disabled || b.getAttribute('aria-disabled') === 'true';

  function button(page: HTMLElement, label: string): HTMLButtonElement {
    return [...page.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      text(b)?.endsWith(label)
    )!;
  }

  it('leads back to the list while the user is still loading', async () => {
    const { page } = await render(null);

    expect(page.querySelector('a.back-link')?.getAttribute('href')).toBe('/users');
    expect(page.querySelector('mat-spinner')?.getAttribute('aria-label')).toBe('Loading user');
  });

  it('shows the username, status, e-mail address and roles by area', async () => {
    const { page } = await render(user);

    expect(text(page.querySelector('h1'))).toBe('alice');
    expect([...page.querySelectorAll('.hero-meta .badge')].map(text)).toEqual([
      'Enabled',
      '2 roles',
    ]);
    expect(text(page.querySelector('.hero-description'))).toBe('alice@example.com');
    expect(
      [...page.querySelectorAll('.role-group')].map((group) => [
        text(group.querySelector('h3'))?.replace(/^\S+ /, ''),
        [...group.querySelectorAll('.role-badge')].map(text),
      ])
    ).toEqual([
      ['Issuance', ['issuance:offer']],
      ['Sessions and audit', ['audit:read']],
    ]);
  });

  it('keeps Edit and Delete from a caller who may not grant all of the roles', async () => {
    const { page } = await render(user, ['issuance:offer']);

    expect(button(page, 'Edit').disabled).toBe(true);
    expect(off(button(page, 'Delete'))).toBe(true);
    expect(page.querySelector('app-role-lock-notice')?.textContent).toContain('audit:read');
  });

  it('deletes once and keeps Edit and Delete disabled while the delete runs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { harness, page, requests } = await render(user);
    const component = harness.routeDebugElement!.componentInstance as UserShowComponent;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const deletes = () => requests.filter((request) => request.startsWith('DELETE'));
    button(page, 'Delete').click();
    await vi.waitFor(() => expect(deletes()).toEqual(['DELETE /api/user/u-1']));
    // The guard itself, not only the disabled button, keeps a second delete from starting
    await component.deleteUser();
    harness.detectChanges();

    expect(deletes()).toEqual(['DELETE /api/user/u-1']);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(button(page, 'Edit').disabled).toBe(true);
    expect(off(button(page, 'Delete'))).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says why a delete failed and offers Edit and Delete again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const failure = new Response(JSON.stringify({ statusCode: 500, message: 'Keycloak down' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
    // The component's MatSnackBarModule provides its own snackbar service.
    const open = vi.spyOn(MatSnackBar.prototype, 'open');
    const { harness, page } = await render(user, ['tenant:admin'], failure);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    button(page, 'Delete').click();

    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'Failed to delete user: Keycloak down',
        'Close',
        expect.anything()
      )
    );
    harness.detectChanges();
    expect(button(page, 'Edit').disabled).toBe(false);
    expect(off(button(page, 'Delete'))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves out the e-mail line for a user without one', async () => {
    const { page } = await render({ ...user, email: undefined });

    expect(page.querySelector('.hero-description')).toBeNull();
  });

  it('does not delete for a caller who may not grant all of the roles', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { harness, page, requests } = await render(user, ['issuance:offer']);
    const component = harness.routeDebugElement!.componentInstance as UserShowComponent;

    button(page, 'Delete').click();
    await component.deleteUser();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.startsWith('DELETE'))).toEqual([]);
  });

  it('says when the user has no roles', async () => {
    const { page } = await render({ ...user, roles: [] });

    expect(text(page.querySelector('.role-group'))).toBeUndefined();
    expect(page.textContent).toContain('This user has no roles.');
  });

  it('stays on the page and offers Retry when the user cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    const fetchStub = vi.fn<typeof fetch>(async () =>
      fail
        ? new Response(JSON.stringify({ statusCode: 503, message: 'Keycloak down' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify(user), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
    );
    client.setConfig({ fetch: fetchStub });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users/u-1', UserShowComponent);
    const page = harness.routeNativeElement as HTMLElement;
    const router = TestBed.inject(Router);

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('app-load-error')).not.toBeNull();
    });
    expect(router.url).toBe('/users/u-1');
    const error = page.querySelector('app-load-error')!;
    expect(text(error)).toContain('Failed to load user: Keycloak down');
    expect(error.querySelector('a')?.getAttribute('href')).toBe('/users');

    fail = false;
    button(page, 'Retry').click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(text(page.querySelector('h1'))).toBe('alice');
    });
    expect(page.querySelector('app-load-error')).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
