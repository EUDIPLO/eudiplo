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
    ['issuance read-only', ['issuance:read']],
    ['verification read-only', ['presentation:read']],
    // issuance:offer and presentation:request include the read roles.
    ['session starting', ['issuance:offer', 'presentation:request']],
  ])(`opens ${page} for %s callers`, async (_, roles) => {
    expect(await canOpen(roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it(`denies ${page} to clients that only read sessions or manage keys`, async () => {
    expect(await canOpen(['sessions:read', 'keys:manage'])).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
    expect(guard.openSnackBar).toHaveBeenCalledWith(
      expect.stringMatching(/^Access denied to \/: it needs the /),
      'Close',
      expect.anything()
    );
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
    // Reading the configuration needs the read role of its side, which the other roles of the
    // side include; writing is checked by the routes of the forms.
    ['issuance-config', ['issuance:read'], ['presentation:manage', 'credentials:status']],
    ['credential-config', ['issuance:offer'], ['presentation:manage', 'credentials:status']],
    ['attribute-providers', ['issuance:read'], ['presentation:manage']],
    ['status-lists', ['issuance:read'], ['presentation:manage']],
    ['status-list-config', ['issuance:read'], ['presentation:manage']],
    ['presentation-config', ['presentation:read'], ['issuance:manage', 'sessions:read']],
    ['oidc-clients', ['presentation:request'], ['issuance:manage', 'sessions:read']],
    ['webhook-endpoints', ['issuance:read'], ['sessions:read', 'keys:manage']],
    ['webhook-endpoints', ['presentation:read'], ['sessions:read', 'keys:manage']],
    // Key chains and KMS providers are read with issuance:read, presentation:read or
    // keys:manage, and the roles that include them.
    ['keys', ['issuance:read'], ['credentials:status', 'sessions:read']],
    ['keys', ['presentation:read'], ['credentials:status', 'sessions:read']],
    ['keys', ['keys:manage'], ['credentials:status', 'sessions:read']],
    ['keys', ['issuance:offer'], ['registrar:manage', 'audit:read']],
    ['keys', ['presentation:manage'], ['registrar:manage', 'audit:read']],
    ['kms', ['issuance:read'], ['credentials:status', 'sessions:read']],
    ['kms', ['presentation:read'], ['credentials:status', 'sessions:read']],
    ['kms', ['keys:manage'], ['credentials:status', 'sessions:read']],
    ['kms', ['issuance:manage'], ['registrar:manage', 'audit:read']],
  ])('opens %s for %j and denies %j', async (path, allowed, denied) => {
    expect(await canOpen(path, allowed)).toBe(true);
    expect(await canOpen(path, denied)).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
  });
});

describe('Form routes', () => {
  let guard: ReturnType<typeof roleGuardHarness>;

  beforeEach(() => {
    guard = roleGuardHarness();
  });

  /** The child route at `path` below the top-level route `parent`, with the parent's data. */
  function canOpen(parent: string, path: string, roles: Role[]): Promise<boolean> {
    const top = routes.find((r) => r.path === parent)!;
    const child = top.children!.find((r) => r.path === path)!;
    expect(child.canActivate).toEqual([RoleGuard]);
    return guard.canOpen({ ...child, data: { ...top.data, ...child.data } }, roles);
  }

  // Creating and changing needs the role the backend checks for writes.
  it.each<[string, string, Role[], Role[]]>([
    ['credential-config', 'create', ['issuance:manage'], ['issuance:offer']],
    ['credential-config', ':id/edit', ['issuance:manage'], ['issuance:read']],
    ['credential-config', ':id/copy', ['issuance:manage'], ['issuance:read']],
    ['issuance-config', 'edit', ['issuance:manage'], ['issuance:offer']],
    ['issuance-config', 'edit', ['tenant:admin'], ['issuance:read']],
    ['attribute-providers', 'create', ['issuance:manage'], ['issuance:read']],
    ['attribute-providers', ':id/edit', ['issuance:manage'], ['issuance:read']],
    ['status-lists', 'create', ['issuance:manage'], ['issuance:read']],
    ['presentation-config', 'create', ['presentation:manage'], ['presentation:request']],
    ['presentation-config', ':id/edit', ['presentation:manage'], ['presentation:read']],
    ['presentation-config', ':id/copy', ['presentation:manage'], ['presentation:read']],
    ['oidc-clients', 'create', ['presentation:manage'], ['presentation:request']],
    ['oidc-clients', ':id/edit', ['presentation:manage'], ['presentation:read']],
    ['trust-list', 'create', ['issuance:manage'], ['issuance:read', 'presentation:read']],
    ['trust-list', ':id/edit', ['presentation:manage'], ['presentation:request']],
    ['federation-trust-anchor', 'create', ['presentation:manage'], ['issuance:offer']],
    ['federation-trust-anchor', ':id/edit', ['issuance:manage'], ['presentation:read']],
    ['webhook-endpoints', 'create', ['presentation:manage'], ['issuance:read']],
    ['webhook-endpoints', ':id/edit', ['issuance:manage'], ['presentation:read']],
    // Key chains are created and changed with keys:manage only.
    ['keys', 'create', ['keys:manage'], ['issuance:manage', 'presentation:manage']],
    ['keys', ':id/edit', ['keys:manage'], ['issuance:manage', 'presentation:manage']],
  ])('opens %s/%s for %j and denies %j', async (parent, path, allowed, denied) => {
    expect(await canOpen(parent, path, allowed)).toBe(true);
    expect(await canOpen(parent, path, denied)).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
  });
});

describe('Pages of the removed sandbox registrar integration', () => {
  it.each([
    ['registrar', 'full'],
    ['schema', 'prefix'],
    ['schema-metadata', 'prefix'],
  ])('redirects /%s to the dashboard', (path, pathMatch) => {
    expect(routes.find((route) => route.path === path)).toEqual({
      path,
      redirectTo: '/dashboard',
      pathMatch,
    });
  });
});

describe('Unknown addresses', () => {
  it('end in the not-found page, after every other route, and only when signed in', async () => {
    const last = routes.at(-1)!;

    expect(last.path).toBe('**');
    expect(routes.filter((route) => route.path === '**')).toHaveLength(1);
    expect(last.canActivate).toEqual([AuthGuard]);
    const { NotFoundComponent } = await import('./common/not-found.component');
    expect(await (last.loadComponent as () => Promise<unknown>)()).toBe(NotFoundComponent);
  });
});
