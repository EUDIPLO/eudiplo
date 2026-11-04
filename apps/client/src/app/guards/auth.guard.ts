import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, RouterStateSnapshot } from '@angular/router';
import { ApiService } from '../core';
import { JwtService } from '../services/jwt.service';

@Injectable({
  providedIn: 'root',
})
export class AuthGuard implements CanActivate {
  constructor(
    private apiService: ApiService,
    private jwtService: JwtService,
    private router: Router
  ) {}

  /**
   * Waits for the caller of the current token, so pages and menus see the
   * roles and tenant the backend resolved from it.
   */
  async canActivate(_route: ActivatedRouteSnapshot, state: RouterStateSnapshot): Promise<boolean> {
    if (this.apiService.getAuthenticationStatus()) {
      await this.jwtService.loadCaller({ url: state.url });
      return true;
    } else {
      // A kept session resumes on the login page, and signing in again as the client of an
      // ended session returns to this page.
      const returnsHere = this.apiService.hasKeptSession() || this.apiService.hasEndedSession();
      const queryParams = returnsHere ? { returnUrl: state.url } : undefined;
      this.router.navigate(['/login'], { queryParams });
      return false;
    }
  }
}
