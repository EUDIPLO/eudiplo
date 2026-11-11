import { Injectable } from '@angular/core';
import Keycloak, { type KeycloakConfig } from 'keycloak-js';
import { Subject } from 'rxjs';

/** How keycloak-js reaches the identity provider (`oidc_provider` of the backend's discovery). */
export type OidcProvider = 'keycloak' | 'generic';

/** The provider a discovery's `oidc_provider` names; older backends, which leave it out, use Keycloak. */
export function oidcProviderOf(oidcProvider: unknown): OidcProvider {
  return oidcProvider === 'generic' ? 'generic' : 'keycloak';
}

export interface OidcConfig {
  /** Issuer URL, e.g. http://localhost:8080/realms/eudiplo */
  issuerUrl: string;
  /** Public client ID of the Angular UI at the provider, e.g. eudiplo-ui */
  uiClientId: string;
  /** EUDIPLO backend base URL */
  apiUrl: string;
  /** Keycloak realm or any provider by its discovery document; stored configs without it are Keycloak. */
  provider?: OidcProvider;
}

/**
 * The page the identity provider returns to after a sign-in: the login page under the
 * web client's base href, `<web client URL>/login`. Operators register it as redirect URI.
 */
function oidcRedirectUri(): string {
  return new URL('login', document.baseURI).href;
}

const STORAGE_CONFIG_KEY = 'oidc_config';
const STORAGE_TOKENS_KEY = 'oidc_tokens';

@Injectable({ providedIn: 'root' })
export class OidcService {
  private keycloak?: Keycloak;
  private _mode: 'local' | 'oidc' = 'local';
  private _config?: OidcConfig;
  private readonly refreshed = new Subject<void>();
  /** Emits when keycloak-js got a new token, for example before the previous one expired. */
  readonly tokenRefreshed$ = this.refreshed.asObservable();

  get mode(): 'local' | 'oidc' {
    return this._mode;
  }

  get token(): string {
    return this.keycloak?.token ?? '';
  }

  get authenticated(): boolean {
    return this.keycloak?.authenticated ?? false;
  }

  get apiUrl(): string | undefined {
    return this._config?.apiUrl;
  }

  /**
   * Called from APP_INITIALIZER on every page load.
   * Restores an OIDC session (including handling the PKCE callback code) if config is stored.
   */
  async initialize(): Promise<void> {
    const config = this.getStoredConfig();
    if (!config) return;

    try {
      await this.restoreSession(config);
    } catch (e) {
      console.warn('OidcService: Failed to restore OIDC session', e);
      this.clearStorage();
    }
  }

  /**
   * Redirects the browser to the Keycloak login page (Authorization Code + PKCE).
   * Saves the OIDC config to storage so the session can be restored on return.
   */
  async redirectToLogin(config: OidcConfig): Promise<void> {
    this.saveConfig(config);
    this._config = config;
    this._mode = 'oidc';

    const keycloak = this.createKeycloakInstance(config);
    this.keycloak = keycloak;

    // init() with login-required will redirect the browser to the identity provider.
    // This function will not return in the normal case. It throws when the
    // provider's discovery document does not load; no session is kept then.
    try {
      await keycloak.init({
        onLoad: 'login-required',
        pkceMethod: 'S256',
        checkLoginIframe: false,
        // One fixed page, without the query of the login page, so providers that compare
        // redirect URIs exactly accept it.
        redirectUri: oidcRedirectUri(),
      });
    } catch (error) {
      this.clearStorage();
      throw error;
    }
  }

  /**
   * Restores an OIDC session from stored config and tokens.
   * Also handles the PKCE callback (detects ?code= in the URL automatically).
   */
  private async restoreSession(config: OidcConfig): Promise<boolean> {
    this._config = config;

    const keycloak = this.createKeycloakInstance(config);
    this.keycloak = keycloak;

    keycloak.onAuthSuccess = () => this.persistTokens();
    keycloak.onAuthRefreshSuccess = () => {
      this.persistTokens();
      this.refreshed.next();
    };
    keycloak.onAuthLogout = () => this.clearStorage();
    keycloak.onTokenExpired = () => {
      keycloak
        .updateToken(-1)
        .catch(() => console.warn('OidcService: Token refresh after expiry failed'));
    };

    const storedTokens = this.getStoredTokens();

    const authenticated = await keycloak.init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      checkLoginIframe: false,
      // Under the base href: Keycloak redirects only to pages of the web client.
      silentCheckSsoRedirectUri: new URL('silent-check-sso.html', document.baseURI).href,
      token: storedTokens?.token,
      refreshToken: storedTokens?.refreshToken,
      idToken: storedTokens?.idToken,
    });

    if (authenticated) {
      this._mode = 'oidc';
      this.persistTokens();
      this.scheduleTokenRefresh();
    }

    return authenticated;
  }

  /**
   * Proactively refresh the token before it expires.
   * @param minValidity seconds of validity remaining before triggering a refresh
   */
  async updateToken(minValidity = 30): Promise<boolean> {
    if (!this.keycloak) return false;
    return this.keycloak.updateToken(minValidity);
  }

  /**
   * Ends the session here and at the provider, which then returns to the web
   * client's base URL, also when it is served under a path. A provider without
   * an `end_session_endpoint` keeps its session; the page still leaves.
   */
  logout(redirectUri?: string): void {
    const keycloak = this.keycloak;
    const target = redirectUri ?? document.baseURI;
    this.clearStorage();
    keycloak?.logout({ redirectUri: target }).catch(() => this.leaveTo(target));
  }

  /** Opens `url` in place of the web client. */
  protected leaveTo(url: string): void {
    globalThis.location.assign(url);
  }

  saveConfig(config: OidcConfig): void {
    try {
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
    } catch {
      console.warn('OidcService: Failed to save OIDC config to storage');
    }
  }

  getStoredConfig(): OidcConfig | null {
    try {
      const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
      return raw ? (JSON.parse(raw) as OidcConfig) : null;
    } catch {
      return null;
    }
  }

  clearStorage(): void {
    localStorage.removeItem(STORAGE_CONFIG_KEY);
    localStorage.removeItem(STORAGE_TOKENS_KEY);
    this._mode = 'local';
    this._config = undefined;
    this.keycloak = undefined;
  }

  private createKeycloakInstance(config: OidcConfig): Keycloak {
    if (config.provider === 'generic') {
      // keycloak-js loads the provider's discovery document from the issuer.
      return this.newKeycloak({ oidcProvider: config.issuerUrl, clientId: config.uiClientId });
    }
    const parts = config.issuerUrl.split('/realms/');
    const baseUrl = parts[0] + '/';
    const realm = parts[1] ?? 'master';
    return this.newKeycloak({ url: baseUrl, realm, clientId: config.uiClientId });
  }

  protected newKeycloak(config: KeycloakConfig): Keycloak {
    return new Keycloak(config);
  }

  private scheduleTokenRefresh(): void {
    const exp = this.keycloak?.tokenParsed?.exp;
    if (!exp) return;
    const delay = Math.max(0, exp * 1000 - Date.now() - 30_000);
    setTimeout(() => {
      this.keycloak
        ?.updateToken(30)
        .then((refreshed) => {
          if (refreshed) this.scheduleTokenRefresh();
        })
        .catch(() => console.warn('OidcService: Scheduled token refresh failed'));
    }, delay);
  }

  private persistTokens(): void {
    if (!this.keycloak) return;
    try {
      localStorage.setItem(
        STORAGE_TOKENS_KEY,
        JSON.stringify({
          token: this.keycloak.token,
          refreshToken: this.keycloak.refreshToken,
          idToken: this.keycloak.idToken,
        })
      );
    } catch {
      console.warn('OidcService: Failed to persist OIDC tokens to storage');
    }
  }

  private getStoredTokens(): {
    token?: string;
    refreshToken?: string;
    idToken?: string;
  } | null {
    try {
      const raw = localStorage.getItem(STORAGE_TOKENS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
