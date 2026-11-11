import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { JwtService } from '../../services/jwt.service';
import { UserListComponent } from './user-list.component';

describe('UserListComponent', () => {
  afterEach(() => {
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
      } as never
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
      { getRoles: () => ['users:manage'] } as never
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
    expect(page.querySelector('[aria-label="Create New User"]')).toBeNull();
    expect(page.querySelector('app-unavailable-card')?.hasAttribute('title')).toBe(false);
  });
});
