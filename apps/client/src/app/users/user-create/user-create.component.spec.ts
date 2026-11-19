import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtService } from '../../services/jwt.service';
import { UserCreateComponent } from './user-create.component';
import { userRoutes } from '../users.routes';

describe('UserCreateComponent Save', () => {
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
        if (path === '/api/user/stored') {
          const answer = () =>
            new Response(
              JSON.stringify({
                id: 'stored',
                username: 'stored',
                enabled: true,
                roles: ['issuance:offer'],
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          if (loadPending)
            return new Promise<Response>((resolve) => (finishLoad = () => resolve(answer())));
          if (loadFailures-- <= 0) return answer();
        }
        if (path === '/api/user/broken' || path === '/api/user/stored') {
          return new Response(JSON.stringify({ statusCode: 404, message: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
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

  it('waits while the user is saved: a second click sends nothing and the tooltip says why', async () => {
    changesPending = true;
    const { harness, page, save } = await render('/users/create');
    const component = harness.routeDebugElement!.componentInstance;
    component.userForm.patchValue({ username: 'new-user', roles: ['issuance:offer'] });
    harness.detectChanges();
    const create = save('Create User');

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
    ).toBe('Saving the user…');
    await new Promise((resolve) => setTimeout(resolve));
    expect(changes).toHaveLength(1);
  });

  it('says why a user that failed to load cannot be edited, instead of an empty form', async () => {
    const { harness, page } = await render('/users/broken');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        'Failed to load user: User not found'
      );
    });
    expect(page.querySelector('form')).toBeNull();
    expect([...page.querySelectorAll('button')].some((b) => b.textContent?.includes('Retry'))).toBe(
      true
    );
  });

  it('says it is loading the user and shows the form only once it has loaded', async () => {
    loadPending = true;
    const { harness, page } = await render('/users/stored');
    harness.detectChanges();

    expect(page.querySelector('form')).toBeNull();
    expect(page.querySelector('output')?.textContent).toContain('Loading user…');

    finishLoad!();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
    });
    const field = page.querySelector<HTMLInputElement>('input[formcontrolname="username"]')!;
    expect(field.value).toBe('stored');
    expect(field.disabled).toBe(true);
  });

  it('shows the user once a retry after a failed load succeeds, and focuses the heading', async () => {
    loadFailures = 1;
    const { harness, page } = await render('/users/stored');
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
      expect(page.querySelector<HTMLInputElement>('input[formcontrolname="username"]')?.value).toBe(
        'stored'
      );
    });
    expect(page.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(page.querySelector('h1')));
  });
});

describe('UserCreateComponent back link and Cancel', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  /** Opens the form at `url` under the real user routes and says where its exits lead. */
  async function exitsFrom(
    url: string
  ): Promise<{ label: string; name: string | null; backLink: string; afterCancel: string }> {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ id: 'u-1', username: 'alice', enabled: true, roles: ['audit:read'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ),
    });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, UserCreateComponent);
    const page = harness.routeNativeElement as HTMLElement;
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
    });
    const back = page.querySelector('a.back-link')!;
    const label = back.textContent!.replace('arrow_back', '').trim();
    const name = back.getAttribute('aria-label');
    const backLink = back.getAttribute('href')!;
    const cancel = [...page.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    )!;
    cancel.click();
    const router = TestBed.inject(Router);
    await vi.waitFor(() => expect(router.url).not.toBe(url));
    return { label, name, backLink, afterCancel: router.url };
  }

  it('returns from creating to the list on Cancel and by the back link', async () => {
    expect(await exitsFrom('/users/create')).toEqual({
      label: 'Users',
      name: 'Back to Users',
      backLink: '/users',
      afterCancel: '/users',
    });
  });

  it('returns from editing to the user, named by username, on Cancel and by the back link', async () => {
    expect(await exitsFrom('/users/u-1/edit')).toEqual({
      label: 'alice',
      name: 'Back to alice',
      backLink: '/users/u-1',
      afterCancel: '/users/u-1',
    });
  });

  it('names the user page while the user is still loading', async () => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users/u-1/edit', UserCreateComponent);
    const back = harness.routeNativeElement!.querySelector('a.back-link')!;

    expect(back.textContent?.replace('arrow_back', '').trim()).toBe('User');
    expect(back.getAttribute('href')).toBe('/users/u-1');
    expect(back.getAttribute('aria-label')).toBe('Back to user');
  });
});

describe('UserCreateComponent change state', () => {
  it('says when the form has unsaved changes', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ id: 'u-1', username: 'alice', enabled: true, roles: ['audit:read'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ),
    });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users/u-1/edit', UserCreateComponent);
    const page = harness.routeNativeElement!;
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
    });
    const state = () => page.querySelector('.action-bar output')?.textContent?.trim();
    expect(state()).toBe('No changes');

    page.querySelector<HTMLInputElement>('mat-checkbox input')!.click();
    harness.detectChanges();

    expect(state()).toBe('Unsaved changes');
  });

  it('says nothing about changes on a new form until something is entered', async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users/create', UserCreateComponent);
    const page = harness.routeNativeElement!;
    const state = () => page.querySelector('.action-bar output')?.textContent?.trim();
    expect(state()).toBe('');

    const field = page.querySelector<HTMLInputElement>('input[formcontrolname="username"]')!;
    field.value = 'dave';
    field.dispatchEvent(new Event('input'));
    harness.detectChanges();

    expect(state()).toBe('Unsaved changes');
  });

  it('takes a username of only spaces as missing', async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'users', children: userRoutes }]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['tenant:admin'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/users/create', UserCreateComponent);

    component.userForm.controls['username'].setValue('   ');

    expect(component.userForm.controls['username'].invalid).toBe(true);
  });
});
