import { Injectable, OnDestroy } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiRefusalService, ApiService } from '../core';
import { JwtService, type Role } from './jwt.service';

interface SeenCaller {
  client?: string;
  roles: string[];
}

/**
 * Tells the user when the API client lost roles while signed in. The menu shows
 * the roles the backend returned for the current token, so the caller of each
 * new token of the same client is compared with the one the menu showed. A page that needs
 * a lost role is left only on request, so unsaved changes can be copied first.
 * A tab without the client secret cannot get a new token; when the backend's
 * role check refuses a request, it loads the caller of its token again, which
 * with the built-in server carries the client's current roles.
 */
@Injectable({ providedIn: 'root' })
export class RoleChangeService implements OnDestroy {
  private subscription?: Subscription;

  constructor(
    private readonly apiService: ApiService,
    private readonly refusals: ApiRefusalService,
    private readonly jwtService: JwtService,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar
  ) {}

  start(): void {
    if (this.subscription) return;
    this.subscription = this.apiService.tokenRenewed$.subscribe(() => void this.recheck());
    this.subscription.add(
      this.refusals.rolesRefusedWithoutRenewal$.subscribe(() => void this.recheck(true))
    );
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  ngOnDestroy(): void {
    this.stop();
  }

  /**
   * Loads the caller of the current token, again with `reload`, and compares
   * it with the one the menu showed before. Callers that only the route guards
   * load, as with OIDC after keycloak-js renewed the token, are not compared:
   * a notice would refer to the page the navigation is leaving. After a
   * refusal on a page whose role was lost before, the page's own error may
   * have replaced the notice, so it comes back.
   */
  private async recheck(reload = false): Promise<void> {
    if (reload && this.router.url.startsWith('/login')) return;
    const before = this.current();
    await this.jwtService.loadCaller({ reload });
    if (!this.subscription || this.compare(before) || !reload) return;
    if (this.current() && this.pageNeedsMissingRole()) {
      this.offerToLeave(
        'Your API client lacks a role this page needs. Copy unsaved changes before you leave it.'
      );
    }
  }

  /** Names the roles the client lost since `before`; true when it opened a notice. */
  private compare(before: SeenCaller | undefined): boolean {
    const now = this.current();
    // A sign-in, also with another client, starts over; a logout forgets the caller.
    if (!before || !now || before.client !== now.client || this.router.url.startsWith('/login')) {
      return false;
    }
    const lost = before.roles.filter((role) => !now.roles.includes(role));
    if (lost.length === 0) return false;

    const named = lost.length === 1 ? `the role ${lost[0]}` : `the roles ${lost.join(', ')}`;
    if (this.pageNeedsMissingRole()) {
      this.offerToLeave(
        `Your API client no longer has ${named}, which this page needs. Copy unsaved changes before you leave it.`
      );
      return true;
    }
    this.snackBar.open(
      `Your API client no longer has ${named}; the pages that need ${lost.length === 1 ? 'it' : 'them'} are hidden.`,
      'OK',
      { duration: 10_000, panelClass: ['warning-snackbar'] }
    );
    return true;
  }

  private pageNeedsMissingRole(): boolean {
    return this.requiredRoles().some((required) => !this.jwtService.hasRole(required));
  }

  /** A page that needs a lost role is left only on request, so unsaved changes can be copied. */
  private offerToLeave(message: string): void {
    this.snackBar
      .open(message, 'Leave page', { duration: 0, panelClass: ['warning-snackbar'] })
      .onAction()
      .subscribe(() => void this.router.navigate(['/']));
  }

  private current(): SeenCaller | undefined {
    const caller = this.jwtService.getCaller();
    if (!caller) return undefined;
    return { client: caller.subject ?? undefined, roles: caller.roles };
  }

  /** The `data.role` of the current page and the routes above it, as RoleGuard checks it. */
  private requiredRoles(): (Role | Role[])[] {
    const required: (Role | Role[])[] = [];
    let route: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    while (route) {
      const role = route.data['role'] as Role | Role[] | undefined;
      if (role) required.push(role);
      route = route.firstChild;
    }
    return required;
  }
}
