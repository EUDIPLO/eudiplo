import { Injectable, OnDestroy } from '@angular/core';
import { client } from '@eudiplo/sdk-core';
import { Subject } from 'rxjs';
import { ApiService } from './api.service';
import { OidcService } from './oidc.service';

/** Shortest time between two token renewals, or two reloads of the caller, after a `403`. */
export const ROLE_RENEWAL_INTERVAL_MS = 60_000;

/**
 * Reason of a `403` from the backend's role check, which the backend answers
 * with Nest's default text (pinned by the backend's
 * `read-and-status-roles.e2e-spec.ts`). Other `403`s give their own reason,
 * which a new token would not change.
 */
const roleRefusalReason = 'Forbidden resource';

/** The token of an `Authorization: Bearer` header. */
function bearerToken(header: string | null | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * Reacts to refused calls of the management API. The backend reads the client
 * behind a built-in token on every request: it answers `401` once the client is
 * deleted or has a new secret, and `403` for roles the client no longer has. A new token tells
 * whether the client still exists, and with each new token the client's current
 * roles are loaded (`GET /api/auth/me`). With OIDC, keycloak-js keeps the session.
 */
@Injectable({ providedIn: 'root' })
export class ApiRefusalService implements OnDestroy {
  /** Token the backend refused and that no new token replaced. */
  private refusedToken?: string;
  /** Token issued because the backend refused the one before. */
  private tokenAfterRefusal?: string;
  private rolesRenewedAt = 0;
  private readonly revoked = new Subject<void>();
  /** Emits when the backend refuses the token and no new one can be had. */
  readonly accessRevoked$ = this.revoked.asObservable();
  private readonly rolesRefused = new Subject<void>();
  /**
   * Emits when the backend's role check refuses the current token and the tab
   * has no secret to get a new one; the client's current roles are then loaded
   * for the same token (`GET /api/auth/me`).
   */
  readonly rolesRefusedWithoutRenewal$ = this.rolesRefused.asObservable();

  constructor(
    private readonly apiService: ApiService,
    private readonly oidcService: OidcService
  ) {
    client.interceptors.response.use(this.onSdkResponse);
  }

  ngOnDestroy(): void {
    client.interceptors.response.eject(this.onSdkResponse);
  }

  private readonly onSdkResponse = (response: Response, request: Request): Response => {
    const token = bearerToken(request.headers.get('Authorization'));
    if (response.status === 403) {
      void response
        .clone()
        .json()
        .catch(() => undefined)
        .then((body: unknown) => this.handleApiResponse(403, token, body));
    } else {
      this.handleApiResponse(response.status, token);
    }
    return response;
  };

  /** Reacts to an answer of the management API to a request sent with `token`, with its JSON `body`. */
  handleApiResponse(status: number, token: string | undefined, body?: unknown): void {
    if (this.oidcService.mode === 'oidc' || !token || token !== this.apiService.accessToken) {
      return;
    }
    if (status === 401) {
      void this.renewRefusedToken(token);
    } else if (status === 403) {
      if (this.apiService.canRefreshToken()) {
        void this.renewForRoles();
      } else if ((body as { message?: unknown } | undefined)?.message === roleRefusalReason) {
        this.rolesRefused.next();
      }
    }
  }

  /** True while the backend refuses the current token and no new one can be had. */
  isAccessRevoked(): boolean {
    return this.refusedToken !== undefined && this.refusedToken === this.apiService.accessToken;
  }

  private async renewRefusedToken(token: string): Promise<void> {
    if (token === this.refusedToken) return;
    // A token issued after a refusal is refused too: the client has no access.
    if (token !== this.tokenAfterRefusal && this.apiService.canRefreshToken()) {
      try {
        await this.apiService.refreshAccessToken();
        this.tokenAfterRefusal = this.apiService.accessToken;
        return;
      } catch {
        // While the backend is down, the session is kept and the refresh retried.
        if (!this.apiService.areCredentialsRejected()) return;
      }
    }
    // The backend refuses an expired token as it should; TokenExpiryService reports
    // the expiry, for example of a reloaded session, which cannot renew its token.
    if (this.apiService.getTokenTimeRemaining() === 0) return;
    // Concurrent refusals of the same token report it once.
    if (token !== this.apiService.accessToken || token === this.refusedToken) return;
    this.refusedToken = token;
    this.revoked.next();
  }

  /** With a new token, the client's current roles are loaded, so the menu follows them. */
  private async renewForRoles(): Promise<void> {
    const now = Date.now();
    if (now - this.rolesRenewedAt < ROLE_RENEWAL_INTERVAL_MS) return;
    this.rolesRenewedAt = now;
    // A failed refresh is reported like any other.
    await this.apiService.refreshAccessToken().catch(() => undefined);
  }
}
