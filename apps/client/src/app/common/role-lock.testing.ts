import { vi } from 'vitest';
import { JwtService, type Role } from '../services/jwt.service';
import { effectiveRoles } from '../services/role-grants';

/**
 * Gives the caller every role, for component tests about what an action does
 * rather than who may use it. Without a caller, `appRequiresRole` locks every
 * action that needs a role.
 */
export function grantEveryRole(): void {
  vi.spyOn(JwtService.prototype, 'hasRole').mockReturnValue(true);
}

/** Gives the caller these roles and the roles they include, for tests of a reader's view. */
export function grantRoles(roles: string[]): void {
  vi.spyOn(JwtService.prototype, 'hasRole').mockImplementation((role: Role | Role[]) =>
    [role].flat().some((r) => effectiveRoles(roles).includes(r))
  );
}
