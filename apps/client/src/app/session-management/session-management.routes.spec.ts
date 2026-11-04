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

  // Matches the backend (session-config.controller.ts) and the nav entry in app.component.html.
  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage']],
    ['verification', ['presentation:manage']],
    ['issuance and verification', ['issuance:manage', 'presentation:manage']],
  ])('opens Session Settings for %s admins', async (_, roles) => {
    expect(await canOpen('config', roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it('denies Session Settings to clients that can only start sessions', async () => {
    expect(await canOpen('config', ['issuance:offer', 'presentation:request'])).toBe(false);
    expect(guard.navigate).toHaveBeenCalledWith(['/']);
    expect(guard.openSnackBar).toHaveBeenCalledWith('Access denied', 'Close', { duration: 3000 });
  });

  // Matches the backend (session.controller.ts) and the All Sessions entry in app.component.html.
  it.each<[string, Role[]]>([
    ['', ['issuance:offer']],
    ['', ['presentation:request']],
    [':id', ['issuance:offer']],
    [':id', ['presentation:request']],
  ])('opens the session route "%s" for %j', async (path, roles) => {
    expect(await canOpen(path, roles)).toBe(true);
    expect(guard.navigate).not.toHaveBeenCalled();
  });

  it.each(['', ':id'])(
    'denies the session route "%s" to clients that only manage configs',
    async (path) => {
      expect(await canOpen(path, ['issuance:manage', 'presentation:manage'])).toBe(false);
      expect(guard.navigate).toHaveBeenCalledWith(['/']);
      expect(guard.openSnackBar).toHaveBeenCalledWith('Access denied', 'Close', {
        duration: 3000,
      });
    }
  );
});
