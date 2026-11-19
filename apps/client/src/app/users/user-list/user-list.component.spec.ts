import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { JwtService } from '../../services/jwt.service';
import { UserListComponent } from './user-list.component';

describe('UserListComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('says why the users could not be loaded instead of an empty list', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ statusCode: 500, message: 'Internal server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    const component = new UserListComponent(
      { open: vi.fn() } as never,
      {
        getRoles: () => ['users:manage'],
      } as never,
      {} as never
    );

    await component.loadUsers();

    expect(component.isUnavailable).toBe(false);
    expect(component.loadError).toBe('Failed to load users: Internal server error');
  });

  it('explains that the identity provider manages people when the backend answers 501', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 501,
              message: 'Users are managed in the identity provider (OIDC_PROVIDER=generic).',
            }),
            { status: 501, headers: { 'Content-Type': 'application/json' } }
          )
      ),
    });
    const component = new UserListComponent(
      { open: vi.fn() } as never,
      { getRoles: () => ['users:manage'] } as never,
      {} as never
    );

    await component.loadUsers();

    expect(component.isUnavailable).toBe(true);
    expect(component.unavailableMessage).toContain('managed in the identity provider');
    expect(component.loadError).toBe('');
  });

  it('shows why people are managed elsewhere and offers no Create button', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ statusCode: 501 }), {
            status: 501,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => ['users:manage'] } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('User management is unavailable');
    });
    expect(page.textContent).toContain('This instance does not manage people.');
    expect(
      [...page.querySelectorAll('a')].some((a) => a.textContent?.includes('Create user'))
    ).toBe(false);
    expect(page.querySelector('app-unavailable-card')?.hasAttribute('title')).toBe(false);
  });

  describe('with users', () => {
    const users = [
      {
        id: 'u-2',
        username: 'bob',
        email: 'bob@example.com',
        enabled: false,
        roles: ['audit:read'],
      },
      {
        id: 'u-1',
        username: 'alice',
        enabled: true,
        roles: ['issuance:offer', 'issuance:offer', 'audit:read'],
      },
    ];

    async function render() {
      client.setConfig({
        fetch: vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify(users), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ),
      });
      await TestBed.configureTestingModule({
        imports: [UserListComponent],
        providers: [
          provideRouter([]),
          { provide: MatSnackBar, useValue: { open: vi.fn() } },
          { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(UserListComponent);
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(page.querySelectorAll('a.user-link')).toHaveLength(2);
      });
      return { fixture, page };
    }

    it('lists the users by username, each linked to its page, with status and roles once', async () => {
      const { page } = await render();
      const rows = [...page.querySelectorAll('tr.mat-mdc-row')];

      expect(rows.map((row) => row.querySelector('a.user-link')?.textContent?.trim())).toEqual([
        'alice',
        'bob',
      ]);
      expect(rows[0].querySelector('a.user-link')?.getAttribute('href')).toBe('/u-1');
      expect(rows[1].querySelector('small')?.textContent).toBe('bob@example.com');
      expect(rows.map((row) => row.querySelector('.badge')?.textContent?.trim())).toEqual([
        'Enabled',
        'Disabled',
      ]);
      expect(
        [...rows[0].querySelectorAll('.role-badge')].map((badge) => badge.textContent?.trim())
      ).toEqual(['issuance:offer', 'audit:read']);
      expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('2 users');
    });

    it('finds users by e-mail address or role as typed and says when none matches', async () => {
      const { fixture, page } = await render();
      const field = page.querySelector<HTMLInputElement>('input[type="search"]')!;
      const type = (value: string) => {
        field.value = value;
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };
      const shown = () =>
        [...page.querySelectorAll('a.user-link')].map((link) => link.textContent?.trim());

      type('BOB@');
      expect(shown()).toEqual(['bob']);
      expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('1 of 2 users');

      type('audit');
      expect(shown()).toEqual(['alice', 'bob']);

      type('nobody');
      expect(page.querySelector('.no-match')?.textContent).toContain('No user matches "nobody".');

      [...page.querySelectorAll<HTMLButtonElement>('.no-match button')][0].click();
      fixture.detectChanges();
      expect(shown()).toEqual(['alice', 'bob']);
      expect(page.querySelector('button.clear-search')).toBeNull();

      type('bob');
      page.querySelector<HTMLButtonElement>('button.clear-search')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(field.value).toBe('');
      expect(shown()).toEqual(['alice', 'bob']);
    });
  });

  it('says that there are no users yet and offers to create one', async () => {
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      ),
    });
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('.empty-state strong')?.textContent).toBe('No users yet');
    });
    expect(page.querySelector('.empty-state a')?.getAttribute('href')).toBe('/create');
    expect(page.querySelector('table')).toBeNull();
  });

  it('shows four roles in a row and names the others on "+N more"', async () => {
    const roles = [
      'tenant:admin',
      'issuance:manage',
      'issuance:offer',
      'presentation:manage',
      'audit:read',
      'keys:manage',
    ];
    client.setConfig({
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify([{ id: 'u-1', username: 'alice', enabled: true, roles }]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('button.role-badge.more')).not.toBeNull();
    });
    expect(page.querySelectorAll('span.role-badge')).toHaveLength(4);
    const more = page.querySelector('button.role-badge.more')!;
    expect(more.textContent?.trim()).toBe('+2 more');
    expect(more.getAttribute('aria-label')).toBe('2 more roles: audit:read, keys:manage');
  });

  it('deletes a user from its row once while the delete runs', async () => {
    const requests: string[] = [];
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        requests.push(request.method);
        if (request.method === 'DELETE') return new Promise<Response>(() => undefined);
        return new Response(
          JSON.stringify([{ id: 'u-1', username: 'alice', enabled: true, roles: ['audit:read'] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('a.user-link')).not.toBeNull();
    });
    const component = fixture.componentInstance;
    const alice = component.users[0];

    void component.deleteUser(alice);
    void component.deleteUser(alice);
    fixture.detectChanges();

    await vi.waitFor(() => expect(requests.filter((m) => m === 'DELETE')).toHaveLength(1));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    const remove = page.querySelector<HTMLButtonElement>('button[aria-label="Delete User"]')!;
    // Stays focusable while it waits, so its tooltip can say why
    expect(remove.getAttribute('aria-disabled')).toBe('true');
  });

  /** Renders the list with `fetch` answering each request through `answer`. */
  async function renderWith(answer: (request: Request) => Promise<Response>) {
    client.setConfig({ fetch: vi.fn<typeof fetch>(async (input) => answer(input as Request)) });
    await TestBed.configureTestingModule({
      imports: [UserListComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: { getRoles: () => ['tenant:admin'] } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserListComponent);
    fixture.detectChanges();
    return { fixture, page: fixture.nativeElement as HTMLElement };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const alice = { id: 'u-1', username: 'alice', enabled: true, roles: ['audit:read'] };

  it('shows a labelled spinner, no table and no empty state while the users load', async () => {
    const { page } = await renderWith(() => new Promise<Response>(() => undefined));

    expect(page.querySelector('mat-spinner')?.getAttribute('aria-label')).toBe('Loading users');
    expect(page.querySelector('table')).toBeNull();
    expect(page.querySelector('.empty-state')).toBeNull();
  });

  it('says why a delete from a row failed and offers Delete again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fixture, page } = await renderWith(async (request) =>
      request.method === 'DELETE'
        ? json({ statusCode: 500, message: 'Keycloak down' }, 500)
        : json([alice])
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('a.user-link')).not.toBeNull();
    });
    const component = fixture.componentInstance;

    await component.deleteUser(component.users[0]);
    fixture.detectChanges();

    expect(TestBed.inject(MatSnackBar).open).toHaveBeenCalledWith(
      'Failed to delete user: Keycloak down',
      'Close',
      expect.anything()
    );
    expect(component.deletingId).toBeUndefined();
    expect(
      page.querySelector('button[aria-label="Delete User"]')?.getAttribute('aria-disabled')
    ).not.toBe('true');
  });

  it('moves focus to the heading once a retry after a failed load succeeds', async () => {
    let failures = 1;
    const { fixture, page } = await renderWith(async () =>
      failures-- > 0 ? json({ statusCode: 500, message: 'down' }, 500) : json([alice])
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('app-load-error')).not.toBeNull();
    });
    const retry = [...page.querySelectorAll<HTMLButtonElement>('app-load-error button')].find(
      (button) => button.textContent?.includes('Retry')
    )!;
    retry.focus();
    retry.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(page.querySelector('h1'));
    });
    expect(page.querySelector('a.user-link')?.textContent?.trim()).toBe('alice');
  });
});
