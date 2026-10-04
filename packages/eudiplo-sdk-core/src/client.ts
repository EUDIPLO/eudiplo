import { client } from './api/client.gen';
import {
  credentialOfferControllerGetOffer,
  sessionControllerGetSession,
  sessionEventsControllerSubscribeToSessionEvents,
  verifierOfferControllerGetOffer,
} from './api/sdk.gen';
import type {
  OfferRequestDto,
  PresentationRequest,
  Session,
} from './api/types.gen';

// ============================================================================
// Digital Credentials API Types
// ============================================================================

/**
 * Digital Credential response from the browser API
 */
export interface DigitalCredentialResponse {
  data: {
    response?: string;
    error?: string;
    error_description?: string;
  };
}

type DcApiWalletResponse = DigitalCredentialResponse['data'];

/**
 * Result of a DC API presentation
 */
export interface DcApiPresentationResult {
  /** The verified credentials from the presentation */
  credentials?: Array<Record<string, unknown>>;
  /** The raw response from the verifier */
  response: unknown;
  /** Redirect URI if provided by the verifier */
  redirectUri?: string;
}

/**
 * Options for DC API presentation
 */
export interface DcApiPresentationOptions {
  /** Whether to return the full credential data in the response (default: true) */
  sendResponse?: boolean;
}

/**
 * Check if the Digital Credentials API is available in the current browser
 */
export function isDcApiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'credentials' in navigator &&
    'get' in navigator.credentials &&
    typeof window !== 'undefined' &&
    'DigitalCredential' in window
  );
}

/**
 * Decode a JWT payload without verification (for extracting response_uri)
 */
function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = parts[1];
  // Handle base64url encoding
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = atob(base64);
  return JSON.parse(jsonPayload) as T;
}

function extractResponseUriFromRequestObject(requestObject: string): string {
  const requestPayload = decodeJwtPayload<{ response_uri?: string }>(requestObject);

  if (!requestPayload.response_uri) {
    throw new Error('No response_uri found in request object');
  }

  return requestPayload.response_uri;
}

function mapDcApiPresentationResult(result: any): DcApiPresentationResult {
  let resolvedCredentials: Array<Record<string, unknown>> | undefined;
  if (Array.isArray(result)) {
    resolvedCredentials = result;
  } else if (Array.isArray(result?.credentials)) {
    resolvedCredentials = result.credentials;
  }

  return {
    credentials: resolvedCredentials,
    response: result,
    redirectUri: result?.redirect_uri,
  };
}

/** Statuses after which a session no longer changes; its event stream ends. */
function isTerminalStatus(status: SessionStatusEvent['status']): boolean {
  return status === 'completed' || status === 'expired' || status === 'failed';
}

/**
 * Configuration options for the EudiploClient
 */
export interface EudiploClientConfig {
  /** Base URL of the EUDIPLO server (e.g., 'https://eudiplo.example.com') */
  baseUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** Optional: Auto-refresh token before expiry (default: true) */
  autoRefresh?: boolean;
  /** Optional: Custom fetch implementation (useful for Cloudflare Workers) */
  fetch?: typeof fetch;
}

/**
 * Options for session polling
 */
export interface SessionPollingOptions {
  /** Polling interval in milliseconds (default: 1000) */
  interval?: number;
  /** Maximum time to wait in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Callback on each poll */
  onUpdate?: (session: Session) => void;
  /** AbortSignal to cancel polling */
  signal?: AbortSignal;
}

/**
 * Event payload received from SSE subscription
 */
export interface SessionStatusEvent {
  /** Session ID */
  id: string;
  /** Current session status */
  status: 'active' | 'fetched' | 'completed' | 'expired' | 'failed';
  /** Timestamp of the status update */
  updatedAt: string;
}

/**
 * Options for SSE session subscription
 */
export interface SessionSubscriptionOptions {
  /** Callback invoked when session status changes */
  onStatusChange?: (event: SessionStatusEvent) => void;
  /** Callback invoked when an error occurs */
  onError?: (error: Error) => void;
  /** Callback invoked when connection is established */
  onOpen?: () => void;
}

/**
 * Subscription handle returned by subscribeToSession.
 * Use to close the SSE connection.
 */
export interface SessionSubscription {
  /** Close the SSE connection */
  close: () => void;
}

/**
 * Simplified options for creating an issuance offer
 */
export interface IssuanceOfferOptions {
  /** Credential configuration IDs to issue */
  credentialConfigurationIds: string[];
  /** Claims to include in the credentials (keyed by config ID) */
  claims?: Record<string, Record<string, unknown>>;
  /** Response type: 'uri' returns the offer URI, 'dc-api' for Digital Credentials API */
  responseType?: 'uri' | 'dc-api';
  /** Transaction code for pre-authorized flow */
  txCode?: string;
  /** Flow type (default: 'pre_authorized_code') */
  flow?: 'authorization_code' | 'pre_authorized_code';
  /** Optional authorization server id from issuer configuration */
  authorizationServer?: string;
  /**
   * Your own reference (e.g. an order id) to find the session later.
   * Stored in plaintext: never put personal data here.
   */
  reference?: string;
}

/**
 * Simplified options for creating a presentation request
 */
export interface PresentationRequestOptions {
  /** ID of the presentation configuration */
  configId: string;
  /** Response type: 'uri' returns the request URI, 'dc-api' for Digital Credentials API */
  responseType?: 'uri' | 'dc-api';
  /** Optional redirect URI after presentation completes */
  redirectUri?: string;
  /** Optional clock skew tolerance for this presentation request, in seconds */
  skewSeconds?: number;
  /**
   * Your own reference (e.g. a case id) to find the session later.
   * Stored in plaintext: never put personal data here.
   */
  reference?: string;
  /**
   * Optional browser origin used for DC API audience binding.
   * For server-side flows, pass the caller origin explicitly.
   */
  origin?: string;
}

type DcApiRequestOptions = Omit<PresentationRequestOptions, 'responseType'>;

/**
 * Result of creating an offer or request
 */
export interface OfferResult {
  /**
   * URI for same-device flow.
   * Use when the wallet is on the same device as the browser.
   * For presentation requests: After presentation, the wallet will redirect the user back to the verifier.
   * For issuance offers: The wallet opens and receives the credential.
   */
  uri: string;
  /**
   * URI for cross-device flow (e.g., QR code scanned by another device).
   * Use when the wallet is on a different device than the browser.
   * No redirect happens after presentation - poll the session for status updates.
   *
   * Only available for presentation requests. For issuance, use `uri` for both flows.
   */
  crossDeviceUri?: string;
  /** Session ID for polling status updates */
  sessionId: string;
}

/** Removes trailing slashes in linear time (a `/\/+$/` regex can backtrack). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * Framework-agnostic EUDIPLO client for demos and integrations.
 *
 * @example
 * ```typescript
 * import { EudiploClient } from '@eudiplo/sdk-core';
 *
 * const client = new EudiploClient({
 *   baseUrl: 'https://eudiplo.example.com',
 *   clientId: 'my-demo',
 *   clientSecret: 'secret123'
 * });
 *
 * // Create a presentation request for age verification
 * const { uri, sessionId } = await client.createPresentationRequest({
 *   configId: 'age-over-18'
 * });
 *
 * // Display QR code with `uri`, then wait for completion
 * const session = await client.waitForSession(sessionId);
 * console.log('Verified:', session.credentials);
 * ```
 */
export class EudiploClient {
  private readonly config: EudiploClientConfig;
  private accessToken?: string;
  private tokenExpiresAt?: number;
  private refreshPromise?: Promise<void>;

  constructor(config: EudiploClientConfig) {
    this.config = {
      autoRefresh: true,
      ...config,
      // Hand-written URLs append paths with a leading slash.
      baseUrl: withoutTrailingSlashes(config.baseUrl),
    };

    // Configure the underlying API client
    client.setConfig({
      baseUrl: this.config.baseUrl,
      fetch: config.fetch,
    });
  }

  /**
   * Authenticate and obtain an access token.
   * Called automatically by other methods, but can be called explicitly.
   */
  async authenticate(): Promise<void> {
    // Prevent concurrent authentication attempts
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this._doAuthenticate();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async _doAuthenticate(): Promise<void> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const res = await fetchFn(`${this.config.baseUrl}/api/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Authentication failed: ${res.status} ${error}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;    

    // Update client with auth header
    client.setConfig({
      baseUrl: this.config.baseUrl,
      fetch: this.config.fetch,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
  }

  /**
   * Ensure we have a valid access token, refreshing if necessary.
   */
  private async ensureAuthenticated(): Promise<void> {
    const bufferMs = 60000; // 1 minute buffer

    if (!this.accessToken || !this.tokenExpiresAt) {
      await this.authenticate();
      return;
    }

    if (this.config.autoRefresh && Date.now() > this.tokenExpiresAt - bufferMs) {
      await this.authenticate();
    }
  }

  /**
   * Create a credential issuance offer.
   *
   * @example
   * ```typescript
   * const { uri, sessionId } = await client.createIssuanceOffer({
   *   credentialConfigurationIds: ['PID'],
   *   claims: {
   *     PID: { given_name: 'John', family_name: 'Doe' }
   *   }
   * });
   * ```
   */
  async createIssuanceOffer(options: IssuanceOfferOptions): Promise<OfferResult> {
    await this.ensureAuthenticated();

    const body: OfferRequestDto = {
      response_type: options.responseType ?? 'uri',
      credentialConfigurationIds: options.credentialConfigurationIds,
      flow: options.flow ?? 'pre_authorized_code',
      tx_code: options.txCode,
      authorization_server: options.authorizationServer,
      reference: options.reference,
    };

    // Build credential claims if provided
    if (options.claims) {
      const credentialClaims: NonNullable<OfferRequestDto['credentialClaims']> = {};
      // For simplicity, we use inline claims
      for (const [configId, claims] of Object.entries(options.claims)) {
        // The API expects a specific structure
        credentialClaims[configId] = {
          type: 'inline',
          claims,
        };
      }
      body.credentialClaims = credentialClaims;
    }

    const response = await credentialOfferControllerGetOffer({
      body,
    });

    if (!response.data) {
      throw new Error('Failed to create issuance offer');
    }

    return {
      uri: response.data.uri,
      sessionId: response.data.session,
    };
  }

  /**
   * Create a presentation request (for verification).
   *
   * Returns two URIs:
   * - `uri`: For same-device flow (wallet on same device, redirect after completion)
   * - `crossDeviceUri`: For cross-device flow (QR code, no redirect, poll for status)
   *
   * @example Same-device flow (wallet app on user's device)
   * ```typescript
   * const { uri, sessionId } = await client.createPresentationRequest({
   *   configId: 'age-over-18',
   *   redirectUri: 'https://example.com/callback'
   * });
   * // Redirect user to uri - wallet will redirect back after completion
   * window.location.href = uri;
   * ```
   *
   * @example Cross-device flow (QR code scanned by separate device)
   * ```typescript
   * const { crossDeviceUri, sessionId } = await client.createPresentationRequest({
   *   configId: 'age-over-18'
   * });
   * // Display crossDeviceUri as QR code, then poll for completion
   * const session = await client.waitForSession(sessionId);
   * ```
   */
  async createPresentationRequest(options: PresentationRequestOptions): Promise<OfferResult> {
    await this.ensureAuthenticated();

    const inferredOrigin =
      options.origin ??
      (typeof globalThis.location === 'object'
        ? globalThis.location.origin
        : undefined);

    const body: PresentationRequest = {
      response_type: options.responseType ?? 'uri',
      requestId: options.configId,
      redirectUri: options.redirectUri,
      skewSeconds: options.skewSeconds,
      reference: options.reference,
      expected_origin:
        options.responseType === 'dc-api' ? inferredOrigin : undefined,
    };

    const response = await verifierOfferControllerGetOffer({
      body,
    });

    if (!response.data) {
      throw new Error('Failed to create presentation request');
    }

    return {
      uri: response.data.uri,
      crossDeviceUri: response.data.crossDeviceUri ?? response.data.uri,
      sessionId: response.data.session,
    };
  }

  /**
   * Get the current health of the EUDIPLO connector.
   * The status in the response is `ok`/`error`.
   * The health of the components is listed in the response under `info`/`error`/`details`.
   * If the EUDIPLO connector itself is unreachable, no components are listed.
   */
  async getHealth(): Promise<Record<string, unknown>> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const res = await fetchFn(`${this.config.baseUrl}/health`);

    if (!res.ok) {
      return { status: 'error' };
    }

    return res.json();
  }

  /**
   * Get the current status of a session.
   */
  async getSession(sessionId: string): Promise<Session> {
    await this.ensureAuthenticated();

    const response = await sessionControllerGetSession({
      path: { id: sessionId },
    });

    if (!response.data) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return response.data;
  }

  /**
   * Wait for a session to complete (polling).
   *
   * @example
   * ```typescript
   * const session = await client.waitForSession(sessionId, {
   *   interval: 1000,
   *   timeout: 60000,
   *   onUpdate: (s) => console.log('Status:', s.status)
   * });
   * ```
   */
  async waitForSession(
    sessionId: string,
    options: SessionPollingOptions = {}
  ): Promise<Session> {
    const {
      interval = 1000,
      timeout = 300000,
      onUpdate,
      signal,
    } = options;

    const startTime = Date.now();

    while (true) {
      // Check for abort
      if (signal?.aborted) {
        throw new Error('Session polling aborted');
      }

      // Check for timeout
      if (Date.now() - startTime > timeout) {
        throw new Error(`Session polling timed out after ${timeout}ms`);
      }

      const session = await this.getSession(sessionId);

      if (onUpdate) {
        onUpdate(session);
      }

      // Check terminal states
      if (session.status === 'completed') {
        return session;
      }

      if (session.status === 'expired' || session.status === 'failed') {
        throw new Error(`Session ${session.status}: ${sessionId}`);
      }

      // Wait before next poll
      await this.sleep(interval, signal);
    }
  }

  /**
   * Helper to sleep with abort support
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(resolve, ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          reject(new Error('Aborted'));
        }, { once: true });
      }
    });
  }

  /**
   * Subscribe to real-time session status updates via Server-Sent Events.
   *
   * The stream is read with `fetch` and the client's access token in the
   * `Authorization` header, so it works in browsers and in Node.js 18+. The
   * first event carries the current status; the stream ends after a terminal
   * status. Failed connections are retried up to three times in total.
   *
   * @example
   * ```typescript
   * const subscription = await client.subscribeToSession(sessionId, {
   *   onStatusChange: (event) => {
   *     console.log(`Status: ${event.status}`);
   *   },
   *   onError: (error) => console.error('SSE error:', error)
   * });
   *
   * // Later, to close the connection:
   * subscription.close();
   * ```
   */
  async subscribeToSession(
    sessionId: string,
    options: SessionSubscriptionOptions = {}
  ): Promise<SessionSubscription> {
    const abort = new AbortController();
    const report = (error: unknown) => {
      if (!abort.signal.aborted) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const stream = await this.sessionEvents(sessionId, abort.signal, report);

    void (async () => {
      let opened = false;
      try {
        for await (const event of stream) {
          if (!opened) {
            opened = true;
            options.onOpen?.();
          }
          options.onStatusChange?.(event);
          if (isTerminalStatus(event.status)) return;
        }
        report(new Error(`Session event stream for ${sessionId} ended before a final status`));
      } catch (error) {
        report(error);
      }
    })();

    return {
      close: () => abort.abort(),
    };
  }

  /**
   * Subscribe to session and wait for completion via SSE.
   *
   * Returns a Promise that resolves when the session completes,
   * or rejects if it fails/expires or the stream cannot be read.
   *
   * @example
   * ```typescript
   * try {
   *   const finalStatus = await client.waitForSessionWithSse(sessionId);
   *   console.log('Session completed:', finalStatus);
   * } catch (error) {
   *   console.error('Session failed:', error);
   * }
   * ```
   */
  async waitForSessionWithSse(
    sessionId: string,
    options: Pick<SessionSubscriptionOptions, 'onStatusChange'> = {}
  ): Promise<SessionStatusEvent> {
    let lastError: unknown;
    const stream = await this.sessionEvents(sessionId, undefined, (error) => {
      lastError = error;
    });
    for await (const event of stream) {
      options.onStatusChange?.(event);
      if (event.status === 'completed') return event;
      if (isTerminalStatus(event.status)) {
        throw new Error(`Session ${event.status}: ${sessionId}`);
      }
    }
    throw new Error(
      `Session event stream for ${sessionId} ended before a final status` +
        (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '')
    );
  }

  /** Opens the event stream of a session with the current access token. */
  private async sessionEvents(
    sessionId: string,
    signal: AbortSignal | undefined,
    onError: (error: unknown) => void
  ): Promise<AsyncGenerator<SessionStatusEvent>> {
    await this.ensureAuthenticated();
    const { stream } = await sessionEventsControllerSubscribeToSessionEvents({
      path: { id: sessionId },
      signal,
      // The stream starts with the current status, so a reconnect misses
      // nothing. 401, 403 and 404 do not go away, so stop retrying soon.
      sseMaxRetryAttempts: 3,
      onSseError: onError,
    });
    return stream as unknown as AsyncGenerator<SessionStatusEvent>;
  }

  /**
   * Get the current access token (for advanced usage)
   */
  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  /**
   * Get the configured base URL
   */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  // ==========================================================================
  // Digital Credentials API Methods
  // ==========================================================================

  /**
   * Create a presentation request configured for DC API usage.
   * Returns a session with the signed request object needed for DC API.
   *
   * @example
   * ```typescript
   * const session = await client.createDcApiPresentationRequest({
   *   configId: 'age-over-18'
   * });
   *
   * // Use the requestObject with the DC API
   * const result = await client.submitDcApiPresentation(session);
   * ```
   */
  async createDcApiPresentationRequest(
    options: DcApiRequestOptions
  ): Promise<Session> {
    await this.ensureAuthenticated();

    const inferredOrigin =
      options.origin ??
      (typeof globalThis.location === 'object'
        ? globalThis.location.origin
        : undefined);

    const body = {
      response_type: 'dc-api' as const,
      requestId: options.configId,
      redirectUri: options.redirectUri,
      reference: options.reference,
      expected_origin: inferredOrigin,
    };

    const response = await verifierOfferControllerGetOffer({
      body,
    });

    if (!response.data) {
      throw new Error('Failed to create DC API presentation request');
    }

    // Fetch the full session and lazily resolve requestObject when needed.
    const session = await this.getSession(response.data.session);

    if (session.requestObject) {
      return session;
    }

    const nonceOrId = session.walletNonce ?? session.id;
    // Wallet-facing protocol endpoint: excluded from the /api prefix.
    const requestObjectUrl = `${this.config.baseUrl}/presentations/${encodeURIComponent(nonceOrId)}/oid4vp/request`;
    const fetchImpl = this.config.fetch ?? fetch;
    const requestObjectResponse = await fetchImpl(requestObjectUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/oauth-authz-req+jwt',
        ...(inferredOrigin ? { Origin: inferredOrigin } : {}),
      },
    });

    if (!requestObjectResponse.ok) {
      const errorText = await requestObjectResponse.text();
      throw new Error(
        `Failed to fetch DC API request object: ${requestObjectResponse.status} ${errorText}`
      );
    }

    const requestObject = (await requestObjectResponse.text()).trim();
    if (!requestObject) {
      throw new Error('DC API request endpoint returned an empty requestObject');
    }

    return {
      ...session,
      requestObject,
    };
  }

  /**
   * Submit a presentation using the Digital Credentials API.
   * This method handles the browser DC API call and submits the response to the verifier.
   *
   * @example
   * ```typescript
   * // Check if DC API is available
   * if (!isDcApiAvailable()) {
   *   throw new Error('DC API not supported in this browser');
   * }
   *
   * const session = await client.createDcApiPresentationRequest({
   *   configId: 'age-over-18'
   * });
   *
   * const result = await client.submitDcApiPresentation(session);
   * console.log('Verified credentials:', result.credentials);
   * ```
   */
  async submitDcApiPresentation(
    session: Session,
    options: DcApiPresentationOptions = {}
  ): Promise<DcApiPresentationResult> {
    if (!isDcApiAvailable()) {
      throw new Error(
        'Digital Credentials API is not available in this browser. ' +
          'Please use a supported browser or fall back to QR code flow.'
      );
    }

    if (!session.requestObject) {
      throw new Error(
        'Session does not contain a requestObject. ' +
          'Make sure to create the session with response_type: "dc-api"'
      );
    }

    const walletResponse = await invokeDcApi(session.requestObject);
    return submitDcApiResponse({
      responseUri: extractResponseUriFromRequestObject(session.requestObject),
      walletResponse,
      sendResponse: options.sendResponse,
      fetch: this.config.fetch,
    });
  }

  /**
   * Convenience method to create a presentation request and immediately
   * submit it using the Digital Credentials API.
   *
   * @example
   * ```typescript
   * const result = await client.verifyWithDcApi({
   *   configId: 'age-over-18'
   * });
   * console.log('Verified:', result.credentials);
   * ```
   */
  async verifyWithDcApi(
    options: DcApiRequestOptions,
    dcOptions: DcApiPresentationOptions = {}
  ): Promise<DcApiPresentationResult> {
    const session = await this.createDcApiPresentationRequest(options);
    return this.submitDcApiPresentation(session, dcOptions);
  }
}

// ============================================================================
// Simple Factory Functions - For the easiest possible integration
// ============================================================================

/**
 * Credentials for EUDIPLO authentication
 */
export interface EudiploCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

async function invokeDcApi(requestObject: string): Promise<DcApiWalletResponse> {
  if (!isDcApiAvailable()) {
    throw new Error(
      'Digital Credentials API is not available in this browser. ' +
        'Please use a supported browser or fall back to QR code flow.'
    );
  }

  const dcResponse = (await navigator.credentials.get({
    mediation: 'required',
    digital: {
      requests: [
        {
          protocol: 'openid4vp-v1-signed',
          data: { request: requestObject },
        },
      ],
    },
  } as CredentialRequestOptions)) as DigitalCredentialResponse | null;

  if (!dcResponse) {
    throw new Error('No response from Digital Credentials API');
  }

  if (dcResponse.data?.error) {
    throw new Error(
      `Wallet error: ${dcResponse.data.error}${
        dcResponse.data.error_description
          ? ` - ${dcResponse.data.error_description}`
          : ''
      }`
    );
  }

  return dcResponse.data;
}
async function submitDcApiResponse(options: {
  /** The response_uri from the request (from DcApiRequestData.responseUri) */
  responseUri: string;
  /** The wallet response from callDcApi() */
  walletResponse: DcApiWalletResponse;
  /** Whether to return full credential data (default: true) */
  sendResponse?: boolean;
  /** Custom fetch implementation (optional) */
  fetch?: typeof fetch;
}): Promise<DcApiPresentationResult> {
  const fetchImpl = options.fetch ?? fetch;

  const submitResponse = await fetchImpl(options.responseUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...options.walletResponse,
      sendResponse: options.sendResponse ?? true,
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    throw new Error(
      `Failed to submit presentation: ${submitResponse.status} ${errorText}`
    );
  }

  const result = await submitResponse.json();
  return mapDcApiPresentationResult(result);
}