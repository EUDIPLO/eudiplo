import { Injectable, type OnDestroy } from '@angular/core';
import { OAuth2Client, OAuth2HttpError } from '@badgateway/oauth2-client';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs/internal/firstValueFrom';
import { Subject } from 'rxjs';
import { client } from '@eudiplo/sdk-core';
import type { Client } from '@eudiplo/sdk-core/api/client/index';
import { environment } from '../../environments/environment';
import { OidcService, oidcProviderOf } from './oidc.service';

/**
 * Base URL used before a session is restored. The runtime value from env.js
 * (API_BASE_URL of the container) wins over the build-time default.
 */
export function defaultApiUrl(runtimeApiUrl?: string, buildApiUrl?: string): string {
  return runtimeApiUrl || buildApiUrl || 'http://localhost:3000';
}

/** Statuses with which a token endpoint refuses client credentials (RFC 6749, section 5.2). */
const rejectedCredentialStatuses = new Set([400, 401]);
/** Delay before retrying a failed refresh; it doubles after each failure up to the maximum. */
const refreshRetryMinMs = 5_000;
const refreshRetryMaxMs = 60_000;

/**
 * Storage key of the client secret written by earlier versions. The secret is no
 * longer stored, so a script injected into the page cannot read it; entries left
 * by earlier versions are removed on startup.
 */
const legacyClientSecretKey = 'oauth_client_secret';

/**
 * A session that ended without a logout, handed to the login page so it can say
 * why and prefill the client and instance. It never holds the client secret.
 * `expired`: its token expired and could not be renewed, for example after a
 * reload, which keeps only the token. `rejected`: the token endpoint rejected
 * its credentials.
 */
export interface EndedSession {
  clientId: string;
  baseUrl?: string;
  reason: 'expired' | 'rejected';
}

/** Storage key of the instance this browser last signed in to, kept after logout. */
const signedInInstanceKey = 'signed_in_instance';

/** OAuth settings stored for a reload. The client secret is kept in memory only. */
interface StoredOAuthConfig {
  server?: string;
  clientId?: string;
  baseUrl?: string;
  tokenEndpoint?: string;
}

/**
 * True when the token endpoint answered 400 or 401, the statuses with which it
 * refuses client credentials, for example after the client was deleted or its
 * secret rotated. The response body is not checked. Any other failure, such as no
 * response, a 5xx or a proxy's 404 while the backend restarts, is retried.
 */
function isCredentialRejection(error: unknown): boolean {
  return error instanceof OAuth2HttpError && rejectedCredentialStatuses.has(error.httpCode);
}

@Injectable({
  providedIn: 'root',
})
export class ApiService implements OnDestroy {
  private _localAccessToken = '';
  private oauth2Client?: OAuth2Client;
  private _localIsAuthenticated = false;
  private tokenExpirationTime?: number;
  private baseUrl?: string;
  client!: Client;
  private refreshTimerId?: ReturnType<typeof setTimeout>;
  private refreshInProgress?: Promise<void> | null = null;
  /** The current credentials got a token, so a refresh that fails for another reason than rejection keeps the session. */
  private sessionStarted = false;
  private refreshRetries = 0;
  /** Changes when the credentials change or the session ends; a refresh started before is ignored. */
  private refreshGeneration = 0;
  private readonly renewed = new Subject<void>();
  /** Emits after each new token, for example when a kept session resumes after an outage. */
  readonly tokenRenewed$ = this.renewed.asObservable();
  private readonly ended = new Subject<void>();
  /**
   * Emits when the client forgets its credentials: on logout, when the token
   * endpoint rejects them, and when the first token request of a sign-in fails.
   */
  readonly sessionEnded$ = this.ended.asObservable();
  /** The token endpoint rejected the credentials of this session. */
  private credentialsRejected = false;
  /** A session that expired or whose credentials were rejected, until the login page reports it. */
  private endedSession?: EndedSession;
  /** OAuth settings of the current sign-in, stored with each new token. */
  private sessionConfig?: StoredOAuthConfig;

  constructor(
    private readonly httpClient: HttpClient,
    private readonly oidcService: OidcService
  ) {
    // Set default base URL from the runtime env.js or the build environment first
    const runtimeEnv = globalThis as { env?: { apiUrl?: string } };
    this.setClient(defaultApiUrl(runtimeEnv.env?.apiUrl, environment.api?.baseUrl));
    // Then try to load stored config (may override the default)
    this.loadTokenFromStorage();
    globalThis.addEventListener?.('storage', this.onStorage);
  }

  ngOnDestroy(): void {
    globalThis.removeEventListener?.('storage', this.onStorage);
  }

  private readonly onStorage = (event: StorageEvent) => this.adoptTokenOfOtherTab(event);

  /** This tab holds the client secret in memory, so it can request tokens. */
  private holdsSecret(): boolean {
    return !!this.oauth2Client?.settings.clientSecret;
  }

  /** True after the token endpoint rejected the credentials, for example of a deleted client. */
  areCredentialsRejected(): boolean {
    return this.credentialsRejected;
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
    // The instance may come from a link, and the page address can hold an authorization code.
    return firstValueFrom(
      this.httpClient.get(`${baseUrl}/.well-known/oauth-authorization-server`, {
        referrerPolicy: 'no-referrer',
      })
    );
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
        provider: oidcProviderOf(discovery.oidc_provider),
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
    // New credentials start a new session, even if discovery fails: the previous
    // session stops renewing, and a failure of the first token request ends the new one.
    this.resetRefresh();
    this.credentialsRejected = false;
    this.endedSession = undefined;
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

    const safeConfig: StoredOAuthConfig = {
      server: oidcUrl,
      clientId,
      baseUrl: baseUrl,
      tokenEndpoint: resolvedTokenEndpoint,
    };
    this.sessionConfig = safeConfig;
    // Persist the OAuth settings without the secret, so a reload keeps the session until its token expires.
    try {
      localStorage.setItem('oauth_config', JSON.stringify(safeConfig));
    } catch (e) {
      console.warn('Failed to persist oauth config:', e);
    }

    // Set up the client immediately
    this.setClient(baseUrl);
  }

  /**
   * Continues the session with a new secret of the signed-in client. The
   * built-in server refuses the tokens issued with the old secret once it is
   * rotated, so a new token is requested at once. The new secret stays in
   * memory: after a reload, the session lasts until its token expires.
   */
  async useRotatedSecret(clientSecret: string): Promise<void> {
    // A reloaded tab has only the stored settings; with the new secret it renews its token again.
    const config = this.sessionConfig ?? this.storedConfigOfThisSession();
    const settings = this.clientFromStoredConfig(config ?? null)?.settings;
    if (!config || !settings) {
      throw new Error('OAuth2 client not properly configured. Please log in again.');
    }
    this.resetRefresh();
    this.credentialsRejected = false;
    this.sessionConfig = config;
    this.oauth2Client = new OAuth2Client({ ...settings, clientSecret });
    await this.refreshAccessToken();
  }

  /**
   * The stored settings of a reloaded tab, which has no settings of its own,
   * as long as they still name its client and backend: another tab may have
   * signed in with another client since.
   */
  private storedConfigOfThisSession(): StoredOAuthConfig | undefined {
    const stored = this.getOAuthConfiguration();
    const clientId = this.oauth2Client?.settings.clientId;
    if (!stored || !clientId || stored.clientId !== clientId || stored.baseUrl !== this.baseUrl) {
      return undefined;
    }
    return stored;
  }

  /**
   * Points the client at the backend of a restored OIDC session.
   * Called after OidcService.initialize(); no-op when no OIDC session was restored.
   */
  syncWithOidcSession(): void {
    if (this.oidcService.mode === 'oidc' && this.oidcService.apiUrl) {
      this.setClient(this.oidcService.apiUrl);
      this.rememberSignedInInstance(this.oidcService.apiUrl);
    }
  }

  /** Remembers `url` as the instance this browser last signed in to. */
  rememberSignedInInstance(url: string): void {
    try {
      localStorage.setItem(signedInInstanceKey, url);
    } catch {
      // Without storage, the login page asks again about an instance a link chose.
    }
  }

  /** The instance this browser last signed in to, also after a logout. */
  lastSignedInInstance(): string | undefined {
    try {
      return localStorage.getItem(signedInInstanceKey) ?? undefined;
    } catch {
      return undefined;
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
   *
   * When the token endpoint rejects the credentials, the session ends and the
   * stored settings are removed. Any other failure of a started session, such as
   * the backend being down, keeps the token (and `isAuthenticated`) until it
   * expires, keeps it stored for a reload, and retries with a backoff.
   */
  async refreshAccessToken(): Promise<void> {
    // Prevent concurrent refresh attempts
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    const refresh = this.requestToken().finally(() => {
      if (this.refreshInProgress === refresh) {
        this.refreshInProgress = null;
      }
    });
    this.refreshInProgress = refresh;
    return refresh;
  }

  /** One token request; its outcome is ignored when the credentials changed or the session ended meanwhile. */
  private async requestToken(): Promise<void> {
    const generation = this.refreshGeneration;
    try {
      if (!this.oauth2Client || !this.holdsSecret()) {
        throw new Error('OAuth2 client not properly configured. Please log in again.');
      }
      const token = await this.oauth2Client.clientCredentials();
      if (generation !== this.refreshGeneration) {
        return;
      }
      this._localAccessToken = token.accessToken;
      this.isAuthenticated = true;
      this.sessionStarted = true;
      this.refreshRetries = 0;

      const expirationTime = token.expiresAt as number;
      this.tokenExpirationTime = expirationTime;

      // Save token to storage (without client secret), with the settings of this sign-in.
      // Not after a logout in another tab removed them: a reload stays logged out.
      if (this.sessionConfig && localStorage.getItem('oauth_config')) {
        this.saveTokenToStorage(token.accessToken, expirationTime, this.sessionConfig);
      }

      // Schedule next refresh only if we have valid credentials
      this.scheduleTokenRefresh(expirationTime);
      this.renewed.next();
    } catch (error) {
      if (generation !== this.refreshGeneration) {
        throw error;
      }
      const rejected = isCredentialRejection(error);
      if (this.keepsCredentials() && !rejected) {
        const delay = this.scheduleRefreshRetry();
        console.warn(`Failed to refresh access token, retrying in ${delay / 1000} s:`, error);
      } else {
        console.error('Failed to refresh access token:', error);
        // Before forgetCredentials announces the end, so listeners see why it ended.
        this.credentialsRejected = rejected;
        const clientId = this.oauth2Client?.settings.clientId;
        if (rejected && this.sessionStarted && clientId) {
          this.endedSession = { clientId, baseUrl: this.baseUrl, reason: 'rejected' };
        }
        this.forgetCredentials();
      }
      throw error;
    }
  }

  /**
   * True while a started session cannot renew its token for another reason than
   * rejected credentials, for example because the backend is down, and retries.
   */
  isReconnecting(): boolean {
    return this.refreshRetries > 0;
  }

  /**
   * True when a session has no valid token but keeps its credentials and renews
   * itself, for example when its token expired while the backend was down. The
   * login page waits for it instead of asking for credentials again. A reload
   * ends this: the credentials are kept in memory only.
   */
  hasKeptSession(): boolean {
    return this.keepsCredentials() && !this.getAuthenticationStatus();
  }

  /**
   * Returns the session that expired or whose credentials the token endpoint
   * rejected, once, so the login page can say why it ended and prefill its client
   * and instance even when it opens afterwards, for example after a logout from
   * the expired notice. A new sign-in clears it.
   */
  takeEndedSession(): EndedSession | undefined {
    const session = this.endedSession;
    this.endedSession = undefined;
    return session;
  }

  /** True while an ended session waits for the login page to report it. */
  hasEndedSession(): boolean {
    return !!this.endedSession;
  }

  /** Whether the user signed in with SSO at the identity provider. */
  usesSso(): boolean {
    return this.oidcService.mode === 'oidc';
  }

  /**
   * Logs out after the token expired and could not be renewed, and keeps the
   * client ID and instance URL, never the secret, for the login page. A session
   * whose credentials were rejected keeps that reason.
   */
  logoutExpired(): void {
    if (this.oidcService.mode === 'oidc') {
      // Only here: the provider's session, if it still has one, signs the user in again,
      // and the in-app login page opens instead of the provider's logout.
      this.resetRefresh();
      this.oidcService.clearStorage();
      return;
    }
    const clientId = this.getClientId();
    const baseUrl = this.baseUrl;
    this.logout();
    if (clientId && !this.endedSession) {
      this.endedSession = { clientId, baseUrl, reason: 'expired' };
    }
  }

  /** A started session keeps its credentials through failures other than rejection, and retries. */
  private keepsCredentials(): boolean {
    return this.sessionStarted && this.holdsSecret();
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
   * Returns false without a client secret: after a reload, which keeps only the token,
   * and after the credentials were rejected
   */
  canRefreshToken(): boolean {
    if (this.oidcService.mode === 'oidc') {
      return true;
    }
    return this.holdsSecret();
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
  getOAuthConfiguration(): StoredOAuthConfig | null {
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

  /**
   * Builds the OAuth2 client for stored settings, or undefined when they are incomplete.
   * It has no secret, so it names the signed-in client; only `useRotatedSecret` adds one.
   */
  private clientFromStoredConfig(oauthConfig: StoredOAuthConfig | null): OAuth2Client | undefined {
    if (!oauthConfig?.server || !oauthConfig.clientId) {
      return undefined;
    }
    // Without a token endpoint the library would run discovery, and it keeps a failed
    // discovery for good; settings stored by older versions may lack one.
    return new OAuth2Client({
      discoveryEndpoint: `${oauthConfig.server}/.well-known/oauth-authorization-server`,
      tokenEndpoint:
        oauthConfig.tokenEndpoint ??
        (oauthConfig.baseUrl ? `${oauthConfig.baseUrl}/api/oauth2/token` : undefined),
      clientId: oauthConfig.clientId,
    });
  }

  /**
   * Logs out the user by clearing the access token
   */
  logout(): void {
    if (this.oidcService.mode === 'oidc') {
      this.resetRefresh();
      this.oidcService.logout();
      return;
    }

    this.forgetCredentials();
    this.credentialsRejected = false;
    this.oauth2Client = undefined;
    this.sessionConfig = undefined;
    this._localAccessToken = '';
    this.tokenExpirationTime = undefined;
    this.baseUrl = undefined;
  }

  /**
   * Restores the session of a stored token that is still valid. Without the client
   * secret, which is never stored, it cannot be renewed: it lasts until the token
   * expires, and then the user logs in again. An expired one is removed, and its
   * client and instance are handed to the login page.
   */
  private loadTokenFromStorage(): void {
    try {
      localStorage.removeItem(legacyClientSecretKey);
      const storedToken = localStorage.getItem('access_token');
      const storedExpiration = localStorage.getItem('token_expiration');
      const storedOAuthConfig = localStorage.getItem('oauth_config');

      if (storedToken && storedExpiration && storedOAuthConfig) {
        const expirationTime = Number.parseInt(storedExpiration, 10);
        const oauthConfig: StoredOAuthConfig = JSON.parse(storedOAuthConfig);

        // Check if token is still valid (with 1 minute buffer)
        if (expirationTime > Date.now() + 60000) {
          this._localAccessToken = storedToken;
          this.tokenExpirationTime = expirationTime;
          this.isAuthenticated = true;
          this.oauth2Client = this.clientFromStoredConfig(oauthConfig);

          // Set up the client with the stored base URL
          if (oauthConfig.baseUrl) {
            this.setClient(oauthConfig.baseUrl);
          }
        } else {
          this.clearTokenFromStorage();
          if (oauthConfig.clientId) {
            this.endedSession = {
              clientId: oauthConfig.clientId,
              baseUrl: oauthConfig.baseUrl,
              reason: 'expired',
            };
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load token from storage:', error);
      this.clearTokenFromStorage();
    }
  }

  /**
   * Takes the token that another tab of this browser renewed and stored, when this
   * tab cannot renew its own: after a reload, or in a tab opened later, it has no
   * client secret. Only a newer token of the same client and backend is taken.
   */
  private adoptTokenOfOtherTab(event: StorageEvent): void {
    if (event.key !== 'access_token' && event.key !== 'token_expiration') return;
    const clientId = this.oauth2Client?.settings.clientId;
    if (this.oidcService.mode === 'oidc' || this.holdsSecret() || !clientId) {
      return;
    }
    const stored = this.getOAuthConfiguration();
    if (stored?.clientId !== clientId || stored.baseUrl !== this.baseUrl) return;
    const token = localStorage.getItem('access_token');
    const expirationTime = Number.parseInt(localStorage.getItem('token_expiration') ?? '', 10);
    // A missing or unreadable expiry parses to NaN.
    if (
      !token ||
      Number.isNaN(expirationTime) ||
      expirationTime <= (this.tokenExpirationTime ?? 0)
    ) {
      return;
    }
    this._localAccessToken = token;
    this.tokenExpirationTime = expirationTime;
    this.isAuthenticated = true;
    // Another tab signed in again, for example with the new secret of this client.
    this.credentialsRejected = false;
    this.endedSession = undefined;
    this.renewed.next();
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
   * Ends the local session, on logout or after the token endpoint rejected the
   * credentials, forgets the credentials so they are not sent again, and removes
   * the stored token so a reload does not restore the session. The client ID stays
   * on display and the access token stays usable until it expires; logout clears both.
   */
  private forgetCredentials(): void {
    this.resetRefresh();
    this.isAuthenticated = false;
    if (this.oauth2Client) {
      this.oauth2Client = new OAuth2Client({
        ...this.oauth2Client.settings,
        clientSecret: undefined,
      });
    }
    this.clearTokenFromStorage();
    this.ended.next();
  }

  /** Stops refreshing for the current credentials, including a refresh still in flight. */
  private resetRefresh(): void {
    this.refreshGeneration++;
    this.refreshInProgress = null;
    this.clearRefreshTimer();
    this.sessionStarted = false;
    this.refreshRetries = 0;
  }

  /** Schedules the next attempt after a failed refresh, 5 s and then doubling up to a minute, and returns the delay. */
  private scheduleRefreshRetry(): number {
    const delay = Math.min(refreshRetryMaxMs, refreshRetryMinMs * 2 ** this.refreshRetries);
    this.refreshRetries++;
    this.setRefreshTimer(delay);
    return delay;
  }

  /** Runs a refresh after the delay, replacing any refresh scheduled before. */
  private setRefreshTimer(delayMs: number): void {
    this.clearRefreshTimer();
    this.refreshTimerId = setTimeout(() => {
      this.refreshTimerId = undefined;
      // refreshAccessToken logs the failure.
      this.refreshAccessToken().catch(() => undefined);
    }, delayMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimerId) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = undefined;
    }
  }

  /**
   * Schedules token refresh before expiration
   * NOTE: Will not schedule if client secret is not available
   */
  private scheduleTokenRefresh(expirationTime: number): void {
    // Don't schedule refresh if we don't have client credentials
    if (!this.holdsSecret()) {
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
      this.setRefreshTimer(timeUntilRefresh);
    } else {
      // Token is very close to expiration, refresh immediately
      this.setRefreshTimer(1000);
    }
  }
}
