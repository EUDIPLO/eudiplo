import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { ApiService } from '../core';
import { JwtService } from '../services/jwt.service';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  const api = { authenticated: false, kept: false, ended: false };
  const route = {} as ActivatedRouteSnapshot;
  const state = { url: '/issuance/offers?page=2' } as RouterStateSnapshot;
  let navigate: MockInstance<Router['navigate']>;
  let loadCaller: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let guard: AuthGuard;

  beforeEach(() => {
    api.authenticated = false;
    api.kept = false;
    api.ended = false;
    loadCaller = vi.fn(() => Promise.resolve());
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            getAuthenticationStatus: () => api.authenticated,
            hasKeptSession: () => api.kept,
            hasEndedSession: () => api.ended,
          },
        },
        { provide: JwtService, useValue: { loadCaller } },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    guard = TestBed.inject(AuthGuard);
  });

  it('lets a signed-in user through once its caller is loaded', async () => {
    api.authenticated = true;
    let loaded!: () => void;
    loadCaller.mockReturnValue(new Promise<void>((resolve) => (loaded = resolve)));

    let settled = false;
    const result = guard.canActivate(route, state).then((allowed) => {
      settled = true;
      return allowed;
    });
    await new Promise((resolve) => setTimeout(resolve));
    expect(loadCaller).toHaveBeenCalledExactlyOnceWith({ url: '/issuance/offers?page=2' });
    expect(settled).toBe(false);
    loaded();

    expect(await result).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends a kept session to the login page with the page to return to', async () => {
    api.kept = true;

    expect(await guard.canActivate(route, state)).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/issuance/offers?page=2' },
    });
  });

  it('sends an expired or rejected session to the login page with the page to return to', async () => {
    api.ended = true;

    expect(await guard.canActivate(route, state)).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/issuance/offers?page=2' },
    });
  });

  it('sends anyone else to the login page without a return path', async () => {
    expect(await guard.canActivate(route, state)).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: undefined });
    expect(loadCaller).not.toHaveBeenCalled();
  });
});
