import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OidcConfig, OidcService } from './oidc.service';

/** A keycloak-js instance that records what the service asks of it. */
function fakeKeycloak() {
  return {
    init: vi.fn().mockResolvedValue(false),
    logout: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn().mockResolvedValue(true),
    authenticated: false,
    token: undefined as string | undefined,
    refreshToken: undefined as string | undefined,
    idToken: undefined as string | undefined,
    onAuthRefreshSuccess: undefined as (() => void) | undefined,
    onTokenExpired: undefined as (() => void) | undefined,
  };
}

describe('OidcService token expiry', () => {
  let keycloak: ReturnType<typeof fakeKeycloak>;
  let service: OidcService;

  beforeEach(async () => {
    keycloak = fakeKeycloak();
    keycloak.init.mockResolvedValue(true);
    const prototype = OidcService.prototype as unknown as {
      createKeycloakInstance: () => unknown;
    };
    vi.spyOn(prototype, 'createKeycloakInstance').mockReturnValue(keycloak);
    localStorage.setItem(
      'oidc_config',
      JSON.stringify({
        issuerUrl: 'https://auth.test/application/o/eudiplo/',
        uiClientId: 'ui',
        apiUrl: 'x',
        provider: 'generic',
      })
    );
    service = TestBed.inject(OidcService);
    await service.initialize();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('ends a session without a refresh token when its token expires, keeping its config for the next sign-in', () => {
    keycloak.token = 'expired-token';
    keycloak.authenticated = true;

    keycloak.onTokenExpired?.();

    expect(service.token).toBe('');
    expect(service.authenticated).toBe(false);
    expect(keycloak.updateToken).not.toHaveBeenCalled();
    // TokenExpiryService reports the expiry and, on "Log in", keeps the page for the SSO sign-in.
    expect(service.mode).toBe('oidc');
    expect(localStorage.getItem('oidc_config')).not.toBeNull();
  });

  it('starts a restored session as not expired', async () => {
    keycloak.token = 'token';
    keycloak.authenticated = true;
    keycloak.onTokenExpired?.();

    await service.initialize();

    expect(service.token).toBe('token');
  });

  it('renews an expired token with the refresh token', () => {
    keycloak.token = 'token';
    keycloak.refreshToken = 'refresh-token';

    keycloak.onTokenExpired?.();

    expect(keycloak.updateToken).toHaveBeenCalledWith(-1);
    expect(service.token).toBe('token');
  });

  it('does not try to renew a token without a refresh token', async () => {
    await expect(service.updateToken(30)).resolves.toBe(false);

    expect(keycloak.updateToken).not.toHaveBeenCalled();
  });

  it('renews a token with a refresh token', async () => {
    keycloak.refreshToken = 'refresh-token';

    await expect(service.updateToken(30)).resolves.toBe(true);

    expect(keycloak.updateToken).toHaveBeenCalledWith(30);
  });
});

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

  it('returns from the provider to the login page under the base href, without its query', async () => {
    const config = { issuerUrl: 'https://idp.test/realms/r', uiClientId: 'ui', apiUrl: 'x' };

    await service.redirectToLogin(config);

    expect(keycloak.init).toHaveBeenCalledWith(
      expect.objectContaining({
        onLoad: 'login-required',
        redirectUri: `${location.origin}/eudiplo-client/login`,
      })
    );
  });

  it("keeps no session when the provider's sign-in settings do not load", async () => {
    const failure = new TypeError('Failed to fetch');
    keycloak.init.mockRejectedValue(failure);
    const config = { issuerUrl: 'https://idp.test/realms/r', uiClientId: 'ui', apiUrl: 'x' };

    await expect(service.redirectToLogin(config)).rejects.toBe(failure);

    expect(localStorage.getItem('oidc_config')).toBeNull();
    expect(service.mode).toBe('local');
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

  it('ends the session at Keycloak with a POST, keeping the ID token out of the address', () => {
    keycloak.idToken = 'id-token';

    service.logout('https://console.test/');

    expect(keycloak.logout).toHaveBeenCalledWith({
      redirectUri: 'https://console.test/',
      logoutMethod: 'POST',
    });
    expect(localStorage.getItem('oidc_config')).toBeNull();
  });

  it('ends the session at Keycloak with a GET when there is no ID token to send', () => {
    service.logout('https://console.test/');

    expect(keycloak.logout).toHaveBeenCalledWith({ redirectUri: 'https://console.test/' });
  });

  it('ends the session at another provider with a GET, which all of them accept', async () => {
    localStorage.setItem(
      'oidc_config',
      JSON.stringify({
        issuerUrl: 'https://idp.test/application/o/eudiplo/',
        uiClientId: 'ui',
        apiUrl: 'x',
        provider: 'generic',
      })
    );
    await service.initialize();
    keycloak.idToken = 'id-token';

    service.logout('https://console.test/');

    expect(keycloak.logout).toHaveBeenCalledWith({ redirectUri: 'https://console.test/' });
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
