import { Injectable, inject } from '@angular/core';

import { ApiService } from '../core';
import { OidcService } from '../core/oidc.service';
import { JwtService } from './jwt.service';

/**
 * Who is signed in and for which tenant, for the account menu and Connection Settings. A client
 * credentials sign-in is named by its client ID; an SSO sign-in has none, so it is named by the
 * user name in the access token, else by the token's subject.
 */
@Injectable({ providedIn: 'root' })
export class SignedInAccountService {
  private readonly apiService = inject(ApiService);
  private readonly oidcService = inject(OidcService);
  private readonly jwtService = inject(JwtService);

  /** Whether this tab signed in through SSO. */
  get isSso(): boolean {
    return this.oidcService.mode === 'oidc';
  }

  /** The name of the signed-in client or user; undefined until it is known. */
  get name(): string | undefined {
    const subject = this.subject;
    if (this.isSso) return this.oidcService.userName ?? subject;
    return this.apiService.getClientId() || subject;
  }

  /** Subject of the access token as the backend resolved it; undefined until it is loaded. */
  get subject(): string | undefined {
    return this.jwtService.getCaller()?.subject ?? undefined;
  }

  /** ID of the signed-in caller's tenant; undefined without one or until the caller is loaded. */
  get tenantId(): string | undefined {
    return this.jwtService.getTenantId() ?? undefined;
  }

  /**
   * The tenant the signed-in caller acts in: its ID, `No tenant` for a caller without one, such
   * as the root client, and undefined until the caller is loaded.
   */
  get tenant(): string | undefined {
    const caller = this.jwtService.getCaller();
    if (!caller) return undefined;
    return caller.tenantId ?? 'No tenant';
  }
}
