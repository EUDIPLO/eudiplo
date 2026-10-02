import { Injectable } from '@angular/core';
import { OAuth2Client } from '@badgateway/oauth2-client';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs/internal/firstValueFrom';
import { client } from '@eudiplo/sdk-core';
import type { Client } from '@eudiplo/sdk-core/api/client/index';
import { environment } from '../../environments/environment';
import { OidcService } from './oidc.service';

/**
 * Base URL used before a session is restored. The runtime value from env.js
 * (API_BASE_URL of the container) wins over the build-time default.
 */
export function defaultApiUrl(runtimeApiUrl?: string, buildApiUrl?: string): string {
  return runtimeApiUrl || buildApiUrl || 'http://localhost:3000';
}

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private _localAccessToken = '';
  oauth2Client!: OAuth2Client;
  private _localIsAuthenticated = false;
  private tokenExpirationTime?: number;
  private baseUrl?: string;
  client!: Client;
  private refreshTimerId?: ReturnType<typeof setTimeout>;
  private refreshInProgress?: Promise<void> | null = null;

  constructor(
    private readonly httpClient: HttpClient,
    private readonly oidcService: OidcService
  ) {
    // Set default base URL from the runtime env.js or the build environment first
    const runtimeEnv = globalThis as { env?: { apiUrl?: string } };
    this.setClient(defaultApiUrl(runtimeEnv.env?.apiUrl, environment.api?.baseUrl));
    // Then try to load stored config (may override the default)
    this.loadTokenFromStorage();
  }

  /** Returns the access token, preferring the OIDC token in OIDC mode. */
  get accessToken(): string {
    if (this.oidcService.mode === 'oidc') {
      return this.oidcService.token;
    }
    return this._localAccessToken;
  }

  /** Returns true if the user is authenticated (local or OIDC mode). */
  get isAuthenticated(): boolean {
    if (this.oidcService.mode === 'oidc') {
      return this.oidcService.authenticated;
    }
    return this._localIsAuthenticated;
  }

  set isAuthenticated(value: boolean) {
    this._localIsAuthenticated = value;
  }

  /** Fetches the OIDC discovery document from the given base URL. */
  async fetchDiscovery(baseUrl: string): Promise<any> {
    return firstValueFrom(this.httpClient.get(`${baseUrl}/.well-known/oauth-authorization-server`));
  }

  async login(clientId: string, clientSecret: string, baseUrl: string) {
    // Get OIDC issuer URL (safe network call with error handling)
    let discovery: any;
    try {
      discovery = await this.fetchDiscovery(baseUrl);
      if (!discovery?.issuer) {
        throw new Error('Invalid OIDC discovery response');
      }
    } catch (err) {
      console.error('Failed to fetch OIDC discovery document', err);
      throw err;
    }

    // Human login in OIDC mode: use Authorization Code + PKCE via keycloak-js.
    if (discovery.ui_client_id) {
      this.setClient(baseUrl);
      await this.oidcService.redirectToLogin({
        issuerUrl: discovery.issuer,
        uiClientId: discovery.ui_client_id,
        apiUrl: baseUrl,
      });
      return;
    }

    await this.loginWithClientCredentials(
      clientId,
      clientSecret,
      baseUrl,
      discovery.issuer,
      discovery.token_endpoint
    );
  }

  async loginWithClientCredentials(
    clientId: string,
    clientSecret: string,
    baseUrl: string,
    issuerUrl?: string,
    tokenEndpoint?: string
  ) {
    const discovery = tokenEndpoint ? undefined : await this.fetchDiscovery(baseUrl);
    const oidcUrl = issuerUrl ?? discovery?.issuer;
    const resolvedTokenEndpoint = tokenEndpoint ?? discovery?.token_endpoint;

    if (!oidcUrl || !resolvedTokenEndpoint) {
      throw new Error('OIDC discovery response is missing an issuer or token endpoint.');
    }

    this.oauth2Client = new OAuth2Client({
      discoveryEndpoint: `${oidcUrl}/.well-known/oauth-authorization-server`,
      tokenEndpoint: resolvedTokenEndpoint,
      clientId,
      clientSecret,
    });

    const safeConfig = {
      server: oidcUrl,
      clientId,
      baseUrl: baseUrl,
      tokenEndpoint: resolvedTokenEndpoint,
    };
    // Persist oauth config (without secret) for rehydration
    try {
      localStorage.setItem('oauth_config', JSON.stringify(safeConfig));
    } catch (e) {
      console.warn('Failed to persist oauth config:', e);
    }

    // Persist client secret only if storage is available and caller opted in.
    try {
      localStorage.setItem('oauth_client_secret', clientSecret);
    } catch (e) {
      console.warn('Failed to persist client secret (storage may be unavailable):', e);
    }

    // Set up the client immediately
    this.setClient(baseUrl);
  }

  /**
   * Points the client at the backend of a restored OIDC session.
   * Called after OidcService.initialize(); no-op when no OIDC session was restored.
   */
  syncWithOidcSession(): void {
    if (this.oidcService.mode === 'oidc' && this.oidcService.apiUrl) {
      this.setClient(this.oidcService.apiUrl);
    }
  }

  setClient(url: string) {
    this.baseUrl = url;
    this.client = client;
    // Configure SDK client to ensure it requests a fresh token when needed.
    client.setConfig({
      baseUrl: url,
      auth: async () => {
        // Ensure token is valid or refreshed before providing it to the SDK
        try {
          await this.ensureAuthenticated();
        } catch (e) {
          // If ensureAuthenticated fails, return whatever token we have (may be empty)
          console.warn('Failed to ensure authentication for SDK auth callback', e);
        }
        return this.accessToken;
      },
    });
  }

  /**
   * Refreshes the access token for the registrar using client credentials.
   * This method is called periodically to ensure the access token is valid.
   * NOTE: This will fail if client secret is not available (after page reload)
   */
  async refreshAccessToken(): Promise<void> {
    // Prevent concurrent refresh attempts
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = (async () => {
      try {
        // Ensure oauth2Client exists, otherwise try to rehydrate from storage
        if (!this.oauth2Client?.settings.clientSecret) {
          const storedSecret = localStorage.getItem('oauth_client_secret');
          const oauthConfig = this.getOAuthConfiguration();
          if (storedSecret && oauthConfig?.server && oauthConfig?.clientId) {
            this.oauth2Client = new OAuth2Client({
              discoveryEndpoint: `${oauthConfig.server}/.well-known/oauth-authorization-server`,
              tokenEndpoint: this.getStoredTokenEndpoint(oauthConfig),
              clientId: oauthConfig.clientId,
              clientSecret: storedSecret,
            });
          } else {
            throw new Error('OAuth2 client not properly configured. Please log in again.');
          }
        }

        const token = await this.oauth2Client.clientCredentials();
        this._localAccessToken = token.accessToken;
        this.isAuthenticated = true;

        const expirationTime = token.expiresAt as number;
        this.tokenExpirationTime = expirationTime;

        // Save token to storage (without client secret)
        const storedOAuthConfig = localStorage.getItem('oauth_config');
        if (storedOAuthConfig) {
          this.saveTokenToStorage(token.accessToken, expirationTime, JSON.parse(storedOAuthConfig));
        }

        // Schedule next refresh only if we have valid credentials
        this.scheduleTokenRefresh(expirationTime);
      } catch (error) {
        console.error('Failed to refresh access token:', error);
        this.isAuthenticated = false;
        this.clearTokenFromStorage();
        throw error;
      } finally {
        this.refreshInProgress = null;
      }
    })();

    return this.refreshInProgress;
  }

  /**
   * Checks if the user is currently authenticated
   */
  getAuthenticationStatus(): boolean {
    if (this.oidcService.mode === 'oidc') {
      return this.oidcService.authenticated && !!this.oidcService.token;
    }
    return this.isAuthenticated && !!this.accessToken && this.isTokenValid();
  }

  /**
   * Checks if the user is authenticated or can auto-refresh the token
   */
  async ensureAuthenticated(): Promise<boolean> {
    if (this.oidcService.mode === 'oidc') {
      try {
        await this.oidcService.updateToken(30);
      } catch (error) {
        console.warn('Failed to update OIDC token:', error);
      }
      return this.getAuthenticationStatus();
    }

    // If we're already authenticated with a valid token, return true
    if (this.getAuthenticationStatus()) {
      return true;
    }

    // If token is expired but we have credentials, try to refresh
    if (this.canRefreshToken()) {
      try {
        await this.refreshAccessToken();
        return this.getAuthenticationStatus();
      } catch (error) {
        console.warn('Failed to refresh token:', error);
        return false;
      }
    }

    return false;
  }

  /**
   * Manually trigger a token refresh (useful for components)
   */
  async manualRefreshToken(): Promise<void> {
    if (this.oidcService.mode === 'oidc') {
      await this.oidcService.updateToken(30);
      return;
    }

    if (!this.canRefreshToken()) {
      throw new Error('Cannot refresh token: client credentials not available');
    }
    return this.refreshAccessToken();
  }

  /**
   * Checks if the current token is still valid
   */
  private isTokenValid(): boolean {
    if (!this.tokenExpirationTime) {
      return false;
    }
    const currentTime = Date.now();
    return this.tokenExpirationTime > currentTime + 60000; // 1 minute buffer
  }

  /**
   * Gets the time remaining until token expires (in milliseconds)
   */
  getTokenTimeRemaining(): number {
    if (!this.tokenExpirationTime) {
      return 0;
    }
    return Math.max(0, this.tokenExpirationTime - Date.now());
  }

  /**
   * Gets the current base URL
   */
  getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  /**
   * Checks if automatic token refresh is available
   * Returns false if client secret is not stored (after page reload)
   */
  canRefreshToken(): boolean {
    if (this.oidcService.mode === 'oidc') {
      return true;
    }
    return !!this.oauth2Client?.settings.clientSecret;
  }

  /**
   * Gets the current OAuth client ID
   */
  getClientId(): string | undefined {
    return this.oauth2Client?.settings.clientId;
  }

  getClientSecret(): string | undefined {
    return this.oauth2Client?.settings.clientSecret;
  }

  /**
   * Gets the current OAuth discovery URL
   */
  getoidcUrl(): string | undefined {
    return this.getOAuthConfiguration()?.server;
  }

  /**
   * Gets the current OAuth configuration for display purposes
   */
  getOAuthConfiguration(): {
    server?: string;
    clientId?: string;
    baseUrl?: string;
    tokenEndpoint?: string;
  } | null {
    const storedConfig = localStorage.getItem('oauth_config');
    if (storedConfig) {
      try {
        return JSON.parse(storedConfig);
      } catch {
        return null;
      }
    }
    return null;
  }

  private getStoredTokenEndpoint(oauthConfig: {
    baseUrl?: string;
    tokenEndpoint?: string;
  }): string | undefined {
    return (
      oauthConfig.tokenEndpoint ??
      (oauthConfig.baseUrl ? `${oauthConfig.baseUrl}/api/oauth2/token` : undefined)
    );
  }

  /**
   * Logs out the user by clearing the access token
   */
  logout(): void {
    // Clear any scheduled refresh first.
    if (this.refreshTimerId) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = undefined;
    }

    if (this.oidcService.mode === 'oidc') {
      this.oidcService.logout();
      return;
    }

    this._localAccessToken = '';
    this.isAuthenticated = false;
    this.tokenExpirationTime = undefined;
    this.baseUrl = undefined;
    this.clearTokenFromStorage();
    localStorage.removeItem('oauth_client_secret');
  }

  /**
   * Loads token from localStorage and validates it
   */
  private loadTokenFromStorage(): void {
    try {
      const storedToken = localStorage.getItem('access_token');
      const storedExpiration = localStorage.getItem('token_expiration');
      const storedOAuthConfig = localStorage.getItem('oauth_config');
      const storedSecret = localStorage.getItem('oauth_client_secret');

      if (storedToken && storedExpiration && storedOAuthConfig) {
        const expirationTime = Number.parseInt(storedExpiration, 10);
        const currentTime = Date.now();

        // Check if token is still valid (with 1 minute buffer)
        if (expirationTime > currentTime + 60000) {
          this._localAccessToken = storedToken;
          this.tokenExpirationTime = expirationTime;
          this.isAuthenticated = true;

          // Restore OAuth client configuration
          const oauthConfig = JSON.parse(storedOAuthConfig);

          if (oauthConfig.server && oauthConfig.clientId) {
            this.oauth2Client = new OAuth2Client({
              discoveryEndpoint: `${oauthConfig.server}/.well-known/oauth-authorization-server`,
              clientId: oauthConfig.clientId,
              clientSecret: storedSecret || '',
            });
          }

          // Set up the client with the stored base URL
          if (oauthConfig.baseUrl) {
            this.setClient(oauthConfig.baseUrl);
          }

          // Schedule token refresh
          this.scheduleTokenRefresh(expirationTime);
        } else {
          // Token expired - try to refresh automatically if we have credentials
          if (storedSecret) {
            const oauthConfig = JSON.parse(storedOAuthConfig);
            if (oauthConfig.server && oauthConfig.clientId) {
              console.log('Token expired on app refresh, attempting automatic renewal...');

              // Restore OAuth client configuration for refresh
              this.oauth2Client = new OAuth2Client({
                discoveryEndpoint: `${oauthConfig.server}/.well-known/oauth-authorization-server`,
                tokenEndpoint: oauthConfig.baseUrl
                  ? `${oauthConfig.baseUrl}/api/oauth2/token`
                  : undefined,
                clientId: oauthConfig.clientId,
                clientSecret: storedSecret,
              });

              // Set up the client with the stored base URL
              if (oauthConfig.baseUrl) {
                this.setClient(oauthConfig.baseUrl);
              }

              // Attempt to refresh the token automatically
              this.refreshAccessToken().catch((error) => {
                console.warn('Failed to auto-refresh expired token:', error);
                this.clearTokenFromStorage();
                localStorage.removeItem('oauth_client_secret');
              });

              return; // Don't clear storage yet, let refresh attempt complete
            }
          }

          // No credentials available for auto-refresh, clear everything
          console.log('Token expired and no credentials available for auto-refresh');
          this.clearTokenFromStorage();
          localStorage.removeItem('oauth_client_secret');
        }
      }
    } catch (error) {
      console.warn('Failed to load token from storage:', error);
      this.clearTokenFromStorage();
    }
  }

  /**
   * Saves token to localStorage
   */
  private saveTokenToStorage(token: string, expirationTime: number, oauthConfig: unknown): void {
    try {
      localStorage.setItem('access_token', token);
      localStorage.setItem('token_expiration', expirationTime.toString());
      localStorage.setItem('oauth_config', JSON.stringify(oauthConfig));
    } catch (error) {
      console.warn('Failed to save token to storage:', error);
    }
  }

  /**
   * Clears token from localStorage
   */
  private clearTokenFromStorage(): void {
    localStorage.removeItem('access_token');
    localStorage.removeItem('token_expiration');
    localStorage.removeItem('oauth_config');
  }

  /**
   * Schedules token refresh before expiration
   * NOTE: Will not schedule if client secret is not available
   */
  private scheduleTokenRefresh(expirationTime: number): void {
    // Don't schedule refresh if we don't have client credentials
    if (!this.oauth2Client?.settings.clientSecret) {
      console.warn('Cannot schedule token refresh: client secret not available');
      return;
    }

    const currentTime = Date.now();
    // Use an adaptive refresh buffer to support both short and long token lifetimes.
    // - For long-lived tokens, refresh up to 5 minutes before expiry.
    // - For short-lived tokens (e.g., 5 minutes), refresh at ~75% of lifetime.
    // - Never refresh with less than a 30-second safety buffer.
    const tokenLifetime = Math.max(0, expirationTime - currentTime);
    const minimumSafetyBuffer = 30000; // 30 seconds
    const maxSafetyBuffer = 300000; // 5 minutes
    const quarterLifetimeBuffer = Math.floor(tokenLifetime * 0.25);
    const refreshBuffer = Math.min(
      maxSafetyBuffer,
      Math.max(minimumSafetyBuffer, quarterLifetimeBuffer)
    );

    const refreshTime = expirationTime - refreshBuffer;
    const timeUntilRefresh = refreshTime - currentTime;

    if (timeUntilRefresh > 0) {
      console.log(`Token refresh scheduled in ${Math.floor(timeUntilRefresh / 60000)} minutes`);
      if (this.refreshTimerId) {
        clearTimeout(this.refreshTimerId);
      }
      this.refreshTimerId = setTimeout(() => {
        this.refreshTimerId = undefined;
        this.refreshAccessToken().catch((e) => console.warn('Scheduled refresh failed', e));
      }, timeUntilRefresh);
    } else {
      // Token is very close to expiration, refresh immediately
      console.log('Token close to expiration, refreshing immediately');
      if (this.refreshTimerId) {
        clearTimeout(this.refreshTimerId);
      }
      this.refreshTimerId = setTimeout(() => {
        this.refreshTimerId = undefined;
        this.refreshAccessToken().catch((e) =>
          console.warn('Immediate scheduled refresh failed', e)
        );
      }, 1000);
    }
  }
}
