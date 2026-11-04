import { Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { authControllerGetCaller, type CallerResponseDto } from '@eudiplo/sdk-core';
import { ApiService } from '../core';
import { asSentence, getApiErrorMessage, hasHttpStatus } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import {
  canManageRoles,
  grantableRoles,
  grantHint,
  TENANT_ADMIN_ROLES,
  type Role,
} from './role-grants';

export { type Role, roles, TENANT_ADMIN_ROLES } from './role-grants';

export function getRole(role: Role) {
  return role;
}

/** The caller as the backend resolved it from the access token. */
export type Caller = CallerResponseDto;

/** How long the guards wait for the caller before they go on without it. */
const CALLER_TIMEOUT_MS = 10_000;

/** Why the caller could not be loaded, and what the user can do about it. */
export function callerFailureMessage(error: unknown): string {
  const failure = 'Could not load your roles';
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `${failure}: the backend did not answer within ${CALLER_TIMEOUT_MS / 1000} seconds.`;
  }
  if (hasHttpStatus(error, 404)) {
    return `${failure}: the backend does not offer GET /api/auth/me. Run the Web Client with a backend of the same release.`;
  }
  return asSentence(getApiErrorMessage(error, failure));
}

/**
 * Roles and tenant of the signed-in caller. They come from the backend
 * (`GET /api/auth/me`), which resolves them from the access token the same way
 * it checks requests, so menus show what the backend allows whatever claims
 * the identity provider uses. The route guards load the caller once per access
 * token; until a new token's caller is loaded, the previous one of the same
 * client stands in. A logout forgets it.
 */
@Injectable({
  providedIn: 'root',
})
export class JwtService {
  private caller?: { token: string; value: Caller };
  private loading?: { token: string; promise: Promise<void> };

  constructor(
    private apiService: ApiService,
    private snackBar: MatSnackBar,
    private router: Router
  ) {
    apiService.sessionEnded$.subscribe(() => {
      this.caller = undefined;
      this.loading = undefined;
    });
  }

  /**
   * Loads the caller of the current access token, unless it is loaded or
   * loading; `reload` loads it again for the same token, for example after
   * the backend refused a request for missing roles. A failed request keeps
   * the stand-in caller and is retried with the next call. Without one, it
   * tells the user why the pages of their roles are missing and offers to
   * try again and open `url`, the page the user asked for.
   */
  loadCaller({ reload = false, url }: { reload?: boolean; url?: string } = {}): Promise<void> {
    const token = this.apiService.accessToken;
    if (!token || (!reload && this.caller?.token === token)) {
      return Promise.resolve();
    }
    if (this.loading?.token === token) {
      return this.loading.promise;
    }
    const promise = authControllerGetCaller({ signal: AbortSignal.timeout(CALLER_TIMEOUT_MS) })
      .then((response) => {
        // A newer token's caller may be loading, or the session ended.
        if (response.data && this.loading?.promise === promise) {
          this.caller = { token, value: response.data };
        }
      })
      .catch((error) => {
        console.error('Failed to load the caller:', error);
        if (this.loading?.promise === promise && !this.getCaller()) {
          openErrorSnackBar(this.snackBar, callerFailureMessage(error), 'Retry', { duration: 0 })
            .onAction()
            .subscribe(() => void this.retry(url));
        }
      })
      .finally(() => {
        if (this.loading?.promise === promise) {
          this.loading = undefined;
        }
      });
    this.loading = { token, promise };
    return promise;
  }

  /** Loads the caller again and opens the page whose guard could not load it. */
  private async retry(url: string | undefined): Promise<void> {
    await this.loadCaller({ reload: true, url });
    if (url && this.getCaller()) {
      await this.router.navigateByUrl(url);
    }
  }

  /**
   * The caller of the current access token. Until it is loaded, the caller of
   * the previous token stands in, as long as the same client is signed in;
   * undefined before the first one and without an access token.
   */
  getCaller(): Caller | undefined {
    const token = this.apiService.accessToken;
    if (!token || !this.caller) {
      return undefined;
    }
    if (this.caller.token === token) {
      return this.caller.value;
    }
    // With OIDC there is no client ID; a sign-in there starts with a logout.
    const clientId = this.apiService.getClientId();
    return !clientId || clientId === this.caller.value.subject ? this.caller.value : undefined;
  }

  /**
   * Checks if the caller has one of the roles.
   * @param role
   * @returns
   */
  hasRole(role: Role | Role[]): boolean {
    const requiredRoles = Array.isArray(role) ? role : [role];
    const callerRoles = this.getRoles();
    return requiredRoles.some((requiredRole) => callerRoles.includes(requiredRole));
  }

  /** Roles of the signed-in caller, as the backend grants them. */
  getRoles(): string[] {
    return this.getCaller()?.roles ?? [];
  }

  /** Roles the signed-in caller may grant to clients and users. */
  grantableRoles(): Role[] {
    return grantableRoles(this.getRoles());
  }

  /** Explains to the signed-in caller which roles it can grant. */
  grantHint(): string {
    return grantHint(this.getRoles());
  }

  /** Whether the signed-in caller may change a client or user with these roles. */
  canManageRoles(targetRoles: string[]): boolean {
    return canManageRoles(this.getRoles(), targetRoles);
  }

  hasTenantContext(): boolean {
    return this.getTenantId() !== null;
  }

  /** Config Portability (bundles, detach, reset) needs a tenant and `tenant:admin` or `tenants:manage`. */
  canUseConfigPortability(): boolean {
    return this.hasTenantContext() && this.hasRole(TENANT_ADMIN_ROLES);
  }

  /** Tenant of the signed-in caller, or null without one. */
  getTenantId(): string | null {
    return this.getCaller()?.tenantId ?? null;
  }
}
