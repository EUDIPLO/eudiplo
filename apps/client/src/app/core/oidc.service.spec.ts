import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OidcConfig, OidcService } from './oidc.service';

/** A keycloak-js instance that records what the service asks of it. */
function fakeKeycloak() {
  return {
    init: vi.fn().mockResolvedValue(false),
    logout: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn(),
    token: undefined as string | undefined,
    onAuthRefreshSuccess: undefined as (() => void) | undefined,
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

  it('says when keycloak-js renewed the token, after keeping the new one', async () => {
    await service.initialize();
    const stored: (string | null)[] = [];
    service.tokenRefreshed$.subscribe(() => stored.push(localStorage.getItem('oidc_tokens')));

    keycloak.token = 'token-b';
    keycloak.onAuthRefreshSuccess?.();

    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0] ?? '{}')).toMatchObject({ token: 'token-b' });
  });
});

describe('OidcService logout', () => {
  let keycloak: ReturnType<typeof fakeKeycloak>;
  let leaveTo: ReturnType<typeof vi.fn<(url: string) => void>>;
  let service: OidcService;

  beforeEach(async () => {
    keycloak = fakeKeycloak();
    keycloak.init.mockResolvedValue(true);
    const prototype = OidcService.prototype as unknown as {
      createKeycloakInstance: () => unknown;
      leaveTo: (url: string) => void;
    };
    vi.spyOn(prototype, 'createKeycloakInstance').mockReturnValue(keycloak);
    leaveTo = vi.fn<(url: string) => void>();
    vi.spyOn(prototype, 'leaveTo').mockImplementation(leaveTo);
    localStorage.setItem(
      'oidc_config',
      JSON.stringify({ issuerUrl: 'https://idp.test/realms/r', uiClientId: 'ui', apiUrl: 'x' })
    );
    service = TestBed.inject(OidcService);
    await service.initialize();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('ends the session at the provider, too', () => {
    service.logout('https://console.test/');

    expect(keycloak.logout).toHaveBeenCalledWith({ redirectUri: 'https://console.test/' });
    expect(localStorage.getItem('oidc_config')).toBeNull();
  });

  it('still leaves when the provider has no end_session_endpoint', async () => {
    keycloak.logout.mockRejectedValue(new Error('Not supported by the OIDC server'));

    service.logout('https://console.test/');

    await vi.waitFor(() => expect(leaveTo).toHaveBeenCalledWith('https://console.test/'));
  });
});

describe('OidcService provider', () => {
  const create = (config: OidcConfig) =>
    (
      TestBed.inject(OidcService) as unknown as {
        createKeycloakInstance: (config: OidcConfig) => unknown;
      }
    ).createKeycloakInstance(config);

  let keycloakConfigs: unknown[];

  beforeEach(() => {
    keycloakConfigs = [];
    const prototype = OidcService.prototype as unknown as {
      newKeycloak: (config: unknown) => unknown;
    };
    vi.spyOn(prototype, 'newKeycloak').mockImplementation((config) => {
      keycloakConfigs.push(config);
      return {};
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('signs in through the Keycloak realm, also with a config stored before providers existed', () => {
    create({ issuerUrl: 'https://kc.test/realms/eudiplo', uiClientId: 'ui', apiUrl: 'x' });

    expect(keycloakConfigs).toEqual([
      { url: 'https://kc.test/', realm: 'eudiplo', clientId: 'ui' },
    ]);
  });

  it("signs in to another provider through its issuer's discovery document", () => {
    create({
      issuerUrl: 'https://auth.test/application/o/eudiplo/',
      uiClientId: 'eudiplo-console',
      apiUrl: 'x',
      provider: 'generic',
    });

    expect(keycloakConfigs).toEqual([
      { oidcProvider: 'https://auth.test/application/o/eudiplo/', clientId: 'eudiplo-console' },
    ]);
  });
});
