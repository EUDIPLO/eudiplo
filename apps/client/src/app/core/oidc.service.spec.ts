import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcService } from './oidc.service';

/** A keycloak-js instance that records what the service asks of it. */
function fakeKeycloak() {
  return {
    init: vi.fn().mockResolvedValue(false),
    updateToken: vi.fn(),
  };
}

describe('OidcService under a base href', () => {
  let base: HTMLBaseElement;
  let keycloak: ReturnType<typeof fakeKeycloak>;
  let service: OidcService;

  beforeEach(() => {
    // The web client served under CLIENT_BASE_HREF, whose pages Keycloak redirects to.
    base = document.createElement('base');
    base.href = `${location.origin}/eudiplo-client/`;
    document.head.append(base);
    keycloak = fakeKeycloak();
    // createKeycloakInstance is private; the spy replaces keycloak-js.
    const prototype = OidcService.prototype as unknown as {
      createKeycloakInstance: () => unknown;
    };
    vi.spyOn(prototype, 'createKeycloakInstance').mockReturnValue(keycloak);
    localStorage.setItem(
      'oidc_config',
      JSON.stringify({ issuerUrl: 'https://idp.test/realms/r', uiClientId: 'ui', apiUrl: 'x' })
    );
    service = TestBed.inject(OidcService);
  });

  afterEach(() => {
    base.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('checks the single sign-on session with the page under the base href', async () => {
    await service.initialize();

    expect(keycloak.init).toHaveBeenCalledWith(
      expect.objectContaining({
        silentCheckSsoRedirectUri: `${location.origin}/eudiplo-client/silent-check-sso.html`,
      })
    );
  });
});
