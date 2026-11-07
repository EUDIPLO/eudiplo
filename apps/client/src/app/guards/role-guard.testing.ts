import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  type ActivatedRouteSnapshot,
  type Route,
  Router,
  type RouterStateSnapshot,
} from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { expect, vi } from 'vitest';

import { ApiService } from '../core';
import type { Caller, Role } from '../services/jwt.service';
import { RoleGuard } from './roles.guard';

/**
 * Answers `GET /api/auth/me` of the SDK with a caller that has the given roles
 * and claims, for the rest of the spec file; `test-setup.ts` starts each file
 * with a `fetch` that never settles.
 */
export function respondWithCaller(caller: () => Partial<Caller> & { roles: string[] }): void {
  client.setConfig({
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ subject: null, tenantId: null, ...caller() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
  });
}

/**
 * Runs the real RoleGuard and JwtService of a route for a caller with the given roles.
 * Call it in beforeEach; `navigate` and `openSnackBar` record where a denied user is sent.
 */
export function roleGuardHarness() {
  let token = '';
  let tokenCount = 0;
  let roles: Role[] = [];
  const navigate = vi.fn();
  const openSnackBar = vi.fn();
  respondWithCaller(() => ({ roles }));
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ApiService,
        useValue: {
          get accessToken() {
            return token;
          },
          getClientId: () => undefined,
          sessionEnded$: new Subject<void>(),
        },
      },
      { provide: Router, useValue: { navigate } },
      { provide: MatSnackBar, useValue: { open: openSnackBar } },
    ],
  });

  return {
    navigate,
    openSnackBar,
    /** Whether the route's RoleGuard lets a caller with these roles in. */
    canOpen(route: Route, callerRoles: Role[]): Promise<boolean> {
      expect(route.canActivate).toContain(RoleGuard);
      // A new token, so the guard loads its caller.
      tokenCount += 1;
      token = `token-${tokenCount}`;
      roles = callerRoles;
      const snapshot = { data: route.data } as unknown as ActivatedRouteSnapshot;
      return TestBed.inject(RoleGuard).canActivate(snapshot, { url: '/' } as RouterStateSnapshot);
    },
  };
}
