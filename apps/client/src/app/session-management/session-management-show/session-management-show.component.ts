import { Component, type OnDestroy, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import * as QRCode from 'qrcode';
import {
  Session,
  isDcApiAvailable,
  type DigitalCredentialResponse,
  type SessionOutcomeCredentialDto,
} from '@eudiplo/sdk-core';
import {
  CancelSessionDialogComponent,
  CancelSessionDialogData,
  CancelSessionDialogResult,
} from '../cancel-session-dialog/cancel-session-dialog.component';
import {
  isCancelConflict,
  isPresentationSession,
  isCancellable,
  SessionManagementService,
  type SessionLogEntry,
} from '../session-management.service';
import { GrafanaLinkService } from '../../services/grafana-link.service';
import { JwtService } from '../../services/jwt.service';
import { CredentialStatusCardComponent } from '../credential-status/credential-status-card.component';
import {
  CREDENTIAL_STATUS_CHANGER_ROLES,
  CREDENTIAL_STATUS_READER_ROLES,
  maySessionChange,
  sessionOfferRole,
} from '../session-roles';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { decodeJwt } from 'jose';
import { getApiErrorMessage, getHttpErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import {
  isFinishedSession,
  sessionResult,
  sessionStatusLabel,
  type SessionResultSummary,
} from '../session-outcome';
import { presentedCredentials, type PresentedCredential } from '../presented-claims';

@Component({
  selector: 'app-session-management-show',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    RouterModule,
    FlexLayoutModule,
    MatTabsModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    UpperCasePipe,
    CredentialStatusCardComponent,
  ],
  templateUrl: './session-management-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './session-management-show.component.scss',
})
export class SessionManagementShowComponent implements OnInit, OnDestroy {
  session: Session | null = null;
  loading = false;
  sessionLogs: SessionLogEntry[] = [];
  grafanaEnabled = false;

  // QR Code functionality
  qrCodeDataUrl: string | null = null;
  generatingQR = false;

  /**
   * Check if this session can be recreated as a new offer
   */
  canRecreateOffer(): boolean {
    if (!this.session || !this.jwtService.hasRole(sessionOfferRole(this.session))) return false;
    if (this.isIssuanceSession()) {
      return !!this.session?.credentialPayload;
    }
    return !!this.session?.requestId;
  }

  /**
   * Navigate to the appropriate offer page to recreate the offer
   */
  recreateOffer(): void {
    if (this.isIssuanceSession() && this.session?.credentialPayload) {
      this.router.navigate(['/offer/issuance'], {
        state: { offerRequest: this.session.credentialPayload },
      });
    } else if (!this.isIssuanceSession() && this.session?.requestId) {
      this.router.navigate(['/offer/presentation'], {
        state: { presentationRequest: { requestId: this.session.requestId } },
      });
    }
  }

  // Status polling properties
  pollingInterval: any = null;
  readonly POLLING_INTERVAL_MS = 3000; // Poll every 3 seconds
  readonly MAX_POLLING_DURATION_MS = 300000; // Stop polling after 5 minutes
  pollingStartTime: number | null = null;
  offerUri: string | null = null;

  constructor(
    private sessionManagementService: SessionManagementService,
    private route: ActivatedRoute,
    private snackBar: MatSnackBar,
    private router: Router,
    private httpClient: HttpClient,
    public grafanaLinkService: GrafanaLinkService,
    private dialog: MatDialog,
    private jwtService: JwtService
  ) {}

  /** Credential status is issuer data, like on the backend. */
  canReadCredentialStatus(): boolean {
    return this.isIssuanceSession() && this.jwtService.hasRole(CREDENTIAL_STATUS_READER_ROLES);
  }

  /** Revoking, suspending and reinstating needs credentials:status or issuance:manage. */
  canChangeCredentialStatus(): boolean {
    return this.jwtService.hasRole(CREDENTIAL_STATUS_CHANGER_ROLES);
  }

  /**
   * Whether the backend returns the session's offer or request: only to
   * callers that may cancel the session (see `maySessionChange`).
   */
  canSeeOffer(): boolean {
    return (
      !!this.session && maySessionChange((roles) => this.jwtService.hasRole(roles), this.session)
    );
  }

  cancelling = false;

  /** Only offers and requests a wallet has neither redeemed nor finished can be cancelled. */
  canCancel(): boolean {
    return !!this.session && isCancellable(this.session) && this.canSeeOffer();
  }

  cancelSession(): void {
    const session = this.session;
    if (!session || !this.canCancel()) return;

    this.dialog
      .open<CancelSessionDialogComponent, CancelSessionDialogData, CancelSessionDialogResult>(
        CancelSessionDialogComponent,
        { data: { count: 1 }, width: '480px' }
      )
      .afterClosed()
      .subscribe(async (result) => {
        if (!result) return;
        this.cancelling = true;
        try {
          await this.sessionManagementService.cancelSession(session.id, result.reason);
          this.stopPolling();
          await this.loadSession(session.id);
          this.loadSessionLogs(session.id);
          this.snackBar.open(
            isPresentationSession(session) ? 'Request cancelled' : 'Offer cancelled',
            'Close',
            { duration: 3000 }
          );
        } catch (error) {
          console.error('Error cancelling session:', error);
          openErrorSnackBar(this.snackBar, this.cancelErrorMessage(error), 'Close', {
            panelClass: ['error-snackbar'],
          });
          await this.loadSession(session.id);
        } finally {
          this.cancelling = false;
        }
      });
  }

  private cancelErrorMessage(error: unknown): string {
    return isCancelConflict(error)
      ? 'The session could not be cancelled, it is no longer pending'
      : getApiErrorMessage(error, 'The session could not be cancelled');
  }

  async ngOnInit(): Promise<void> {
    const sessionId = this.route.snapshot.params['id'];
    await this.loadSession(sessionId);
    this.loadSessionLogs(sessionId);
    // A finished session does not change any more.
    if (this.session && !isFinishedSession(this.getSessionStatusValue(this.session))) {
      this.startPolling(sessionId);
    }
    this.grafanaLinkService.getConfig().then(() => {
      this.grafanaEnabled = this.grafanaLinkService.isEnabled();
    });
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  async loadSession(sessionId: string): Promise<void> {
    this.loading = true;
    try {
      this.session = await this.sessionManagementService.getSession(sessionId);
      this.generateQRCode(this.session.offerUrl || this.session.requestUrl!);
    } catch (error) {
      console.error('Error loading session:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load session'));
      this.router.navigate(['../'], { relativeTo: this.route });
    } finally {
      this.loading = false;
    }
  }

  printJWT(jwt: string) {
    if (!jwt) return 'No JWT data available';

    try {
      // Decode and pretty-print the JWT payload
      const decodedPayload = decodeJwt(jwt);
      return JSON.stringify(decodedPayload, null, 2);
    } catch (error) {
      console.error('Error decoding JWT:', error);
      return `Error decoding JWT: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  getStatusDisplayText(status: any): string {
    if (!status) return 'Unknown';
    if (typeof status === 'string') return sessionStatusLabel(status);
    if (typeof status === 'object') {
      return Object.entries(status)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    }
    return JSON.stringify(status);
  }

  /** How the session ended, or null while it is pending. */
  result(): SessionResultSummary | null {
    return this.session ? sessionResult(this.session) : null;
  }

  private presentedFor: unknown = undefined;
  private presentedCache: PresentedCredential[] = [];

  /** The claims a completed presentation disclosed, one entry per presented credential. */
  presented(): PresentedCredential[] {
    const credentials = this.session?.status === 'completed' ? this.session.credentials : null;
    if (credentials !== this.presentedFor) {
      this.presentedFor = credentials;
      this.presentedCache = presentedCredentials(credentials);
    }
    return this.presentedCache;
  }

  /** The verification result of the credential presented for a query. */
  outcomeCredential(queryId: string): SessionOutcomeCredentialDto | null {
    return this.session?.outcome?.credentials?.find((c) => c.id === queryId) ?? null;
  }

  /** The trusted entity that matched the credential of a query, when verification recorded it. */
  trustedIssuer(queryId: string): string | null {
    return this.outcomeCredential(queryId)?.trust?.matchedIssuer ?? null;
  }

  /** Per-credential results explain a failure; on success only their warnings matter. */
  showCredentialResults(result: SessionResultSummary): boolean {
    return result.tone === 'success'
      ? result.credentials.some((c) => (c.warnings?.length ?? 0) > 0)
      : result.credentials.length > 0;
  }

  /** Session list filter for other sessions that failed with the same code. */
  failureCodeParams(code: string): Record<string, string> {
    return { status: 'failed', failureCode: code };
  }

  /** The presentation or credential configurations the session was created for. */
  configurationIds(): string[] {
    if (!this.session) return [];
    if (!this.isIssuanceSession()) return this.session.requestId ? [this.session.requestId] : [];
    return (
      this.session.credentialConfigurationIds ??
      this.session.credentialPayload?.credentialConfigurationIds ??
      []
    );
  }

  async getDcApiCall() {
    if (!this.session?.requestObject) {
      this.snackBar.open('No request object available for DC API', 'Close', { duration: 3000 });
      return;
    }

    if (!isDcApiAvailable()) {
      console.warn('Digital Credentials API not available — handing off via deep link.');
      this.snackBar.open('Digital Credentials API not available in this browser', 'Close', {
        duration: 3000,
      });
      return;
    }

    try {
      console.log('Calling Digital Credentials API (signed)…');

      // Call the Digital Credentials API
      const credential = (await navigator.credentials.get({
        mediation: 'required',
        digital: {
          requests: [
            {
              protocol: 'openid4vp-v1-signed',
              data: { request: this.session.requestObject },
            },
          ],
        },
      } as CredentialRequestOptions)) as DigitalCredentialResponse | null;

      console.log('Digital Credentials API response:', credential);

      if (!credential) {
        throw new Error('No response from Digital Credentials API');
      }

      if (credential.data?.error) {
        console.error('Wallet protocol error:', credential.data.error, credential.data);
        throw new Error(
          `${credential.data.error}${credential.data.error_description ? `: ${credential.data.error_description}` : ''}`
        );
      }

      // Extract response_uri from the request object and submit
      const responseUri = decodeJwt<{ response_uri?: string }>(
        this.session.requestObject
      ).response_uri;

      if (!responseUri) {
        throw new Error('No response_uri found in request object');
      }

      const submitRes = await firstValueFrom(
        this.httpClient.post(responseUri, { ...credential.data, sendResponse: true })
      );

      console.log('Verifier response:', submitRes);
      this.snackBar.open('Presentation submitted successfully!', 'Close', { duration: 3000 });

      // Refresh the session to show updated status
      await this.loadSession(this.session.id);
    } catch (error) {
      console.error('DC API error:', error);
      openErrorSnackBar(this.snackBar, dcApiErrorMessage(error));
      // A rejected response ends the session; its status says why.
      if (error instanceof HttpErrorResponse && error.status === 400) {
        await this.loadSession(this.session.id);
      }
    }
  }

  /**
   * Check if the Digital Credentials API is available
   */
  isDcApiAvailable(): boolean {
    return isDcApiAvailable();
  }

  getStatusClass(status: any): string {
    const statusStr = this.getStatusDisplayText(status).toLowerCase();
    if (statusStr.includes('completed') || statusStr.includes('success')) return 'status-success';
    if (statusStr.includes('pending') || statusStr.includes('processing')) return 'status-pending';
    if (statusStr.includes('failed') || statusStr.includes('error')) return 'status-error';
    return 'status-default';
  }

  formatDate(dateString: string): string {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString();
  }

  formatJson(obj: any): string {
    if (!obj) return 'N/A';
    return JSON.stringify(obj, null, 2);
  }

  goBack(): void {
    this.router.navigate(['../'], { relativeTo: this.route });
  }

  /** Copies a value the page shows as it is, so it can be copied by hand. */
  async copyValue(text: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      text,
      'Copied to clipboard',
      'Could not copy to the clipboard. Select the value on the page and copy it by hand.'
    );
  }

  /** The tab shows the decoded request, not the request object this copies. */
  async copyRequestObject(requestObject: unknown): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      this.formatJson(requestObject),
      'Copied to clipboard',
      'Could not copy the presentation request'
    );
  }

  // QR Code functionality
  async generateQRCode(uri: string): Promise<void> {
    if (!uri) return;

    this.offerUri = uri;

    this.generatingQR = true;
    try {
      this.qrCodeDataUrl = await QRCode.toDataURL(uri, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });
    } catch (error) {
      console.error('Error generating QR code:', error);
      this.qrCodeDataUrl = null;
      this.snackBar.open('Failed to generate QR code', 'Close', {
        duration: 3000,
      });
    } finally {
      this.generatingQR = false;
    }
  }

  // Status polling functionality
  startPolling(sessionId: string): void {
    this.stopPolling();
    this.pollingStartTime = Date.now();

    // Set up interval
    this.pollingInterval = setInterval(() => {
      const elapsed = Date.now() - (this.pollingStartTime || 0);

      if (elapsed >= this.MAX_POLLING_DURATION_MS) {
        this.stopPolling();
        return;
      }

      this.fetchSessionStatus(sessionId);
    }, this.POLLING_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.pollingStartTime = null;
    }
  }

  async fetchSessionStatus(sessionId: string): Promise<void> {
    try {
      const updatedSession = await this.sessionManagementService.getSession(sessionId);
      const currentStatus = this.getSessionStatusValue(updatedSession);

      this.session = updatedSession;
      this.loadSessionLogs(sessionId);

      // The result card says how the session ended; its live region announces it.
      if (isFinishedSession(currentStatus)) {
        this.stopPolling();
      }
    } catch (error) {
      console.error('Error fetching session status:', error);
      // Don't show error to user for polling failures, just log them
    }
  }

  getSessionStatusValue(session: Session): string {
    // Extract status from the session.status object or return a default
    if (typeof session.status === 'object' && session.status !== null) {
      const statusObj = session.status as any;
      if (
        statusObj.status &&
        ['active', 'completed', 'expired', 'failed', 'cancelled'].includes(statusObj.status)
      ) {
        return statusObj.status;
      }
      if (
        statusObj.state &&
        ['active', 'completed', 'expired', 'failed', 'cancelled'].includes(statusObj.state)
      ) {
        return statusObj.state;
      }
    } else if (
      typeof session.status === 'string' &&
      ['active', 'completed', 'expired', 'failed', 'cancelled'].includes(session.status)
    ) {
      return session.status;
    }
    return 'active';
  }

  isPolling(): boolean {
    return this.pollingInterval !== null;
  }

  // Helper to check if this is an issuance session that might have a QR code
  isIssuanceSession(): boolean {
    return !isPresentationSession(this.session);
  }

  // Get the offer URI if available in session data
  getOfferUri(): string | null {
    if (!this.session || this.session.status !== 'active') return null;
    return this.offerUri;
  }

  async loadSessionLogs(sessionId: string): Promise<void> {
    try {
      this.sessionLogs = await this.sessionManagementService.getSessionLogs(sessionId);
    } catch {
      // Logs may not be available if LOG_SESSION_STORE is off
      this.sessionLogs = [];
    }
  }

  getLogLevelClass(level: string): string {
    switch (level) {
      case 'error':
        return 'log-error';
      case 'warn':
        return 'log-warn';
      default:
        return 'log-info';
    }
  }

  openGrafanaLogs(): void {
    if (!this.session) return;
    const from = this.session.createdAt ? new Date(this.session.createdAt) : undefined;
    const url = this.grafanaLinkService.buildSessionLogsUrl(this.session.id, from);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  openGrafanaTraces(): void {
    if (!this.session) return;
    const url = this.grafanaLinkService.buildSessionTracesUrl(this.session.id);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  openGrafanaTrace(traceId: string): void {
    const url = this.grafanaLinkService.buildTraceUrl(traceId);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  getTraceIdFromDetail(detail: Record<string, unknown> | undefined): string | null {
    if (!detail) return null;
    const traceId = detail['traceId'] ?? detail['trace_id'];
    return typeof traceId === 'string' ? traceId : null;
  }
}

/**
 * Message for a failed Digital Credentials API presentation. When the verifier
 * rejects the wallet's response, it answers 400 with no message, or with a
 * redirect URI whose `error_description` says why.
 */
function dcApiErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse && error.status === 400) {
    const body = error.error as { redirect_uri?: unknown; message?: unknown } | null;
    const description =
      typeof body?.redirect_uri === 'string' ? errorDescription(body.redirect_uri) : null;
    if (description) return `The verifier rejected the presentation: ${description}`;
    if (typeof body?.message !== 'string') {
      return 'The verifier rejected the presentation; the session result shows why.';
    }
  }
  return getHttpErrorMessage(error, 'DC API error');
}

function errorDescription(redirectUri: string): string | null {
  try {
    return new URL(redirectUri, window.location.href).searchParams.get('error_description');
  } catch {
    return null;
  }
}
