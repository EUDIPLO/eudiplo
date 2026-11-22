import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ApiService } from '../core';
import { OidcService } from '../core/oidc.service';
import { JwtService } from './jwt.service';
import { SignedInAccountService } from './signed-in-account.service';

describe('SignedInAccountService', () => {
  function account(options: {
    mode: 'local' | 'oidc';
    clientId?: string;
    userName?: string;
    caller?: { subject: string | null; tenantId: string | null };
  }): SignedInAccountService {
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getClientId: () => options.clientId } },
        { provide: OidcService, useValue: { mode: options.mode, userName: options.userName } },
        {
          provide: JwtService,
          useValue: {
            getCaller: () => options.caller && { ...options.caller, roles: [] },
            getTenantId: () => options.caller?.tenantId ?? null,
          },
        },
      ],
    });
    return TestBed.inject(SignedInAccountService);
  }

  it('names a client credentials sign-in by its client ID, with its tenant', () => {
    const signedIn = account({
      mode: 'local',
      clientId: 'acme-admin',
      caller: { subject: 'acme-admin', tenantId: 'acme' },
    });

    expect(signedIn.isSso).toBe(false);
    expect(signedIn.name).toBe('acme-admin');
    expect(signedIn.tenant).toBe('acme');
    expect(signedIn.tenantId).toBe('acme');
  });

  it('names an SSO user by the user name in the token, else by the subject', () => {
    const caller = { subject: '3f2a9c1e-user', tenantId: 'acme' };

    expect(account({ mode: 'oidc', userName: 'alice', caller }).name).toBe('alice');
    TestBed.resetTestingModule();
    const withoutName = account({ mode: 'oidc', caller });
    expect(withoutName.name).toBe('3f2a9c1e-user');
    expect(withoutName.subject).toBe('3f2a9c1e-user');
  });

  it('says a caller without a tenant has none, and knows nothing before the caller loads', () => {
    expect(account({ mode: 'local', caller: { subject: 'root', tenantId: null } }).tenant).toBe(
      'No tenant'
    );
    TestBed.resetTestingModule();
    const loading = account({ mode: 'oidc' });
    expect(loading.tenant).toBeUndefined();
    expect(loading.name).toBeUndefined();
  });
});
