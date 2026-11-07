import { Injectable } from '@angular/core';
import Keycloak from 'keycloak-js';
import { Subject } from 'rxjs';

export interface OidcConfig {
  /** Keycloak issuer URL, e.g. http://localhost:8080/realms/eudiplo */
  issuerUrl: string;
  /** Public client ID registered for the Angular UI, e.g. eudiplo-ui */
  uiClientId: string;
  /** EUDIPLO backend base URL */
  apiUrl: string;
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

    // init() with login-required will redirect the browser to Keycloak.
    // This function will not return in the normal case.
    await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    });
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

  logout(redirectUri?: string): void {
    this.clearStorage();
    // The web client's base URL, also when it is served under a path.
    this.keycloak?.logout({ redirectUri: redirectUri ?? document.baseURI });
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
    const parts = config.issuerUrl.split('/realms/');
    const baseUrl = parts[0] + '/';
    const realm = parts[1] ?? 'master';
    return new Keycloak({ url: baseUrl, realm, clientId: config.uiClientId });
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
