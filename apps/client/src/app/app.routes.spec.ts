import { beforeEach, describe, expect, it } from 'vitest';

import { routes } from './app.routes';
import { AuthGuard } from './guards/auth.guard';
import { RoleGuard } from './guards/roles.guard';
import { roleGuardHarness } from './guards/role-guard.testing';
import type { Role } from './services/jwt.service';

// Match the backends (trustlist.controller.ts, federation-trust-anchor.controller.ts) and the
// nav entries in app.component.html.
describe.each([
  ['Trust Lists', 'trust-list'],
  ['Federation Trust Anchors', 'federation-trust-anchor'],
])('%s route', (page, path) => {
  let guard: ReturnType<typeof roleGuardHarness>;

  beforeEach(() => {
    guard = roleGuardHarness();
  });

  function canOpen(roles: Role[]): Promise<boolean> {
    const route = routes.find((r) => r.path === path)!;
    expect(route.canActivate).toEqual([AuthGuard, RoleGuard]);
    return guard.canOpen(route, roles);
  }

  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage']],
    ['verification', ['presentation:manage']],
    ['issuance and verification', ['issuance:manage', 'presentation:manage']],
  ])(`opens ${page} for %s admins`, async (_, roles) => {
    expect(await canOpen(roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it(`denies ${page} to clients that can only start sessions`, async () => {
    expect(await canOpen(['issuance:offer', 'presentation:request'])).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
    expect(guard.openSnackBar).toHaveBeenCalledWith('Access denied', 'Close', { duration: 3000 });
  });
});

describe('Configuration routes', () => {
  let guard: ReturnType<typeof roleGuardHarness>;

  beforeEach(() => {
    guard = roleGuardHarness();
  });

  function canOpen(path: string, roles: Role[]): Promise<boolean> {
    const route = routes.find((r) => r.path === path)!;
    expect(route.canActivate).toEqual([AuthGuard, RoleGuard]);
    return guard.canOpen(route, roles);
  }

  // Matches the backend's @Secured roles and the nav entries in app.component.html.
  it.each<[string, Role[], Role[]]>([
    ['issuance-config', ['issuance:manage'], ['presentation:manage', 'issuance:offer']],
    ['credential-config', ['issuance:manage'], ['presentation:manage', 'issuance:offer']],
    ['presentation-config', ['presentation:manage'], ['issuance:manage', 'presentation:request']],
    ['webhook-endpoints', ['issuance:manage'], ['issuance:offer', 'presentation:request']],
    ['webhook-endpoints', ['presentation:manage'], ['issuance:offer', 'presentation:request']],
    ['keys', ['issuance:manage'], ['issuance:offer', 'presentation:request']],
    ['keys', ['presentation:manage'], ['issuance:offer', 'presentation:request']],
    ['kms', ['issuance:manage'], ['issuance:offer', 'presentation:request']],
    ['kms', ['presentation:manage'], ['issuance:offer', 'presentation:request']],
  ])('opens %s for %j and denies %j', async (path, allowed, denied) => {
    expect(await canOpen(path, allowed)).toBe(true);
    expect(await canOpen(path, denied)).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
  });
});
