import { Injectable } from '@angular/core';
import { CanActivate, ActivatedRouteSnapshot, Router, RouterStateSnapshot } from '@angular/router';
import { JwtService } from '../services/jwt.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { openErrorSnackBar } from '../utils/error-snackbar';

/**
 * Says which page was refused and which role opens it, for example
 * "Access denied to /session-management: it needs the issuance:offer or sessions:read role."
 */
export function accessDeniedMessage(url: string, role: string | string[]): string {
  const roles = [role].flat();
  const names =
    roles.length > 1 ? `${roles.slice(0, -1).join(', ')} or ${roles.at(-1)}` : (roles[0] ?? '');
  return `Access denied to ${url.split(/[?#]/)[0]}: it needs the ${names} role.`;
}

@Injectable({
  providedIn: 'root',
})
export class RoleGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private router: Router,
    private snackBar: MatSnackBar
  ) {}

  /**
   * Waits for the caller of the current token, so the roles are the backend's.
   * Without a caller, loading it failed and a notice offers to try again and
   * open the page, so the user stays where they are.
   */
  async canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): Promise<boolean> {
    await this.jwtService.loadCaller({ url: state.url });
    if (!this.jwtService.getCaller()) {
      return false;
    }
    const requiredRole = route.data['role'];
    if (this.jwtService.hasRole(requiredRole)) {
      return true;
    }
    this.router.navigate(['/']);
    openErrorSnackBar(this.snackBar, accessDeniedMessage(state.url, requiredRole));
    return false;
  }
}
