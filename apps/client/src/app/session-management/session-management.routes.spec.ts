import { beforeEach, describe, expect, it } from 'vitest';

import { roleGuardHarness } from '../guards/role-guard.testing';
import type { Role } from '../services/jwt.service';
import { sessionManagementRoutes } from './session-management.routes';

describe('Session management routes', () => {
  let guard: ReturnType<typeof roleGuardHarness>;

  beforeEach(() => {
    guard = roleGuardHarness();
  });

  function canOpen(path: string, roles: Role[]): Promise<boolean> {
    return guard.canOpen(
      sessionManagementRoutes.find((r) => r.path === path)!,
      roles
    );
  }

  // Matches the backend (session-config.controller.ts) and the nav entry in app.component.html:
  // either read role opens the settings; saving needs a manage role.
  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage']],
    ['verification', ['presentation:manage']],
    ['issuance read-only', ['issuance:read']],
    ['verification read-only', ['presentation:read']],
    // issuance:offer and presentation:request include the read roles.
    ['session starting', ['issuance:offer', 'presentation:request']],
  ])('opens Session Settings for %s callers', async (_, roles) => {
    expect(await canOpen('config', roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it('denies Session Settings to clients that only read sessions or manage keys', async () => {
    expect(await canOpen('config', ['sessions:read', 'keys:manage'])).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
    expect(guard.openSnackBar).toHaveBeenCalledWith(
      expect.stringMatching(/^Access denied to \/: it needs the /),
      'Close',
      expect.anything()
    );
  });

  // Matches the backend (session.controller.ts) and the All Sessions entry in app.component.html.
  it.each<[string, Role[]]>([
    ['', ['issuance:offer']],
    ['', ['presentation:request']],
    [':id', ['issuance:offer']],
    [':id', ['presentation:request']],
    // The manage roles include issuance:offer and presentation:request.
    ['', ['issuance:manage']],
    [':id', ['presentation:manage']],
    ['', ['sessions:read']],
  ])('opens the session route "%s" for %j', async (path, roles) => {
    expect(await canOpen(path, roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it.each(['', ':id'])(
    'denies the session route "%s" to clients that only read configs or manage keys',
    async (path) => {
      expect(await canOpen(path, ['issuance:read', 'presentation:read', 'keys:manage'])).toBe(
        false
      );
      expect(guard.navigate).toHaveBeenCalledWith(['/']);
      expect(guard.openSnackBar).toHaveBeenCalledWith(
        expect.stringMatching(/^Access denied to \/: it needs the /),
        'Close',
        expect.anything()
      );
    }
  );
});
