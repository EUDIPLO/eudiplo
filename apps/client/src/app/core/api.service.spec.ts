import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService, defaultApiUrl } from './api.service';
import { OidcService } from './oidc.service';

describe('defaultApiUrl', () => {
  it('prefers the runtime API_BASE_URL over the build-time default', () => {
    expect(defaultApiUrl('https://eudiplo.example.com', 'https://your-api-prod.com')).toBe(
      'https://eudiplo.example.com'
    );
  });

  it('falls back to the build-time default without a runtime value', () => {
    expect(defaultApiUrl(undefined, 'https://your-api-prod.com')).toBe('https://your-api-prod.com');
  });

  it('falls back to localhost when nothing is configured', () => {
    expect(defaultApiUrl()).toBe('http://localhost:3000');
  });
});

describe('ApiService.syncWithOidcSession', () => {
  const oidcStub: { mode: 'local' | 'oidc'; apiUrl?: string } = { mode: 'local' };

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    oidcStub.mode = 'local';
    oidcStub.apiUrl = undefined;
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), { provide: OidcService, useValue: oidcStub }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('points the client at the backend of a restored OIDC session', () => {
    const service = TestBed.inject(ApiService);
    oidcStub.mode = 'oidc';
    oidcStub.apiUrl = 'https://eudiplo.example.com';

    service.syncWithOidcSession();

    expect(service.getBaseUrl()).toBe('https://eudiplo.example.com');
  });

  it('keeps the current base URL when no OIDC session was restored', () => {
    const service = TestBed.inject(ApiService);
    const before = service.getBaseUrl();
    oidcStub.apiUrl = 'https://eudiplo.example.com';

    service.syncWithOidcSession();

    expect(service.getBaseUrl()).toBe(before);
  });
});
