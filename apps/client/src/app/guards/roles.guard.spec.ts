import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  Router,
  type RouterStateSnapshot,
} from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../core';
import { AuthGuard } from './auth.guard';
import { RoleGuard } from './roles.guard';

@Component({ template: '' })
class PageStub {}

describe('RoleGuard', () => {
  const route = { data: { role: 'issuance:manage' } } as unknown as ActivatedRouteSnapshot;
  const state = { url: '/issuance-config' } as RouterStateSnapshot;
  let status: number;
  let navigate: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    status = 200;
    navigate = vi.fn();
    open = vi.fn(() => ({ onAction: () => new Subject<void>() }));
    client.setConfig({
      fetch: async () =>
        new Response(
          JSON.stringify(
            status === 200
              ? { subject: 'shop', tenantId: 'acme', roles: ['issuance:offer'] }
              : { statusCode: status, message: 'Bad Gateway' }
          ),
          { status, headers: { 'Content-Type': 'application/json' } }
        ),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ApiService,
          useValue: {
            accessToken: 'token',
            getClientId: () => 'shop',
            sessionEnded$: new Subject<void>(),
          },
        },
        { provide: Router, useValue: { navigate, currentNavigation: () => null } },
        { provide: MatSnackBar, useValue: { open } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('denies a page whose role the caller lacks', async () => {
    expect(await TestBed.inject(RoleGuard).canActivate(route, state)).toBe(false);

    expect(navigate).toHaveBeenCalledWith(['/']);
    expect(open).toHaveBeenCalledWith('Access denied', 'Close', { duration: 3000 });
  });

  it('stays on the current page and only says why the roles could not be loaded', async () => {
    status = 502;

    expect(await TestBed.inject(RoleGuard).canActivate(route, state)).toBe(false);

    expect(navigate).not.toHaveBeenCalled();
    expect(open.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['Could not load your roles: Bad Gateway.', 'Retry'],
    ]);
  });
});

describe('RoleGuard below a route with AuthGuard', () => {
  let requests: number;
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requests = 0;
    open = vi.fn(() => ({ onAction: () => new Subject<void>(), dismiss: vi.fn() }));
    client.setConfig({
      fetch: async () => {
        requests++;
        return new Response(JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'offer',
            canActivate: [AuthGuard],
            children: [
              {
                path: 'issuance',
                component: PageStub,
                canActivate: [RoleGuard],
                data: { role: 'issuance:offer' },
              },
            ],
          },
        ]),
        {
          provide: ApiService,
          useValue: {
            accessToken: 'token',
            getAuthenticationStatus: () => true,
            getClientId: () => 'shop',
            sessionEnded$: new Subject<void>(),
          },
        },
        { provide: MatSnackBar, useValue: { open } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('asks for the caller once per navigation when it cannot be loaded', async () => {
    const router = TestBed.inject(Router);

    expect(await router.navigateByUrl('/offer/issuance')).toBe(false);
    expect(requests).toBe(1);
    expect(open).toHaveBeenCalledOnce();

    expect(await router.navigateByUrl('/offer/issuance')).toBe(false);
    expect(requests).toBe(2);
  });
});
