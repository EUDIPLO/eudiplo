import { Injectable } from '@angular/core';
import { CanActivate, ActivatedRouteSnapshot, Router, RouterStateSnapshot } from '@angular/router';
import { JwtService } from '../services/jwt.service';
import { MatSnackBar } from '@angular/material/snack-bar';

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
    this.snackBar.open('Access denied', 'Close', { duration: 3000 });
    return false;
  }
}
