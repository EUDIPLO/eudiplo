import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { type ActivatedRouteSnapshot, Router, type RouterStateSnapshot } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../core';
import { RoleGuard } from './roles.guard';

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
        { provide: Router, useValue: { navigate } },
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
