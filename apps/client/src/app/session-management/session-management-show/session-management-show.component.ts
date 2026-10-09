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
import { Session, isDcApiAvailable, type DigitalCredentialResponse } from '@eudiplo/sdk-core';
import {
  CancelSessionDialogComponent,
  CancelSessionDialogData,
  CancelSessionDialogResult,
} from '../cancel-session-dialog/cancel-session-dialog.component';
import {
  isCancelConflict,
  isCancellable,
  SessionManagementService,
  type SessionLogEntry,
} from '../session-management.service';
import { GrafanaLinkService } from '../../services/grafana-link.service';
import { JwtService } from '../../services/jwt.service';
import { CredentialStatusCardComponent } from '../credential-status/credential-status-card.component';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { decodeJwt } from 'jose';
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

  /** Changing credential status is an issuer action, like on the backend. */
  canManageCredentialStatus(): boolean {
    return (
      this.isIssuanceSession() && this.jwtService.hasRole(['issuance:offer', 'issuance:manage'])
    );
  }

  cancelling = false;

  /** Only offers and requests a wallet has neither redeemed nor finished can be cancelled. */
  canCancel(): boolean {
    return !!this.session && isCancellable(this.session);
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
          this.snackBar.open('Offer cancelled', 'Close', { duration: 3000 });
        } catch (error) {
          console.error('Error cancelling session:', error);
          this.snackBar.open(
            isCancelConflict(error)
              ? 'The session could not be cancelled, it is no longer pending'
              : 'The session could not be cancelled, please try again',
            'Close',
            {
              duration: 4000,
              panelClass: ['error-snackbar'],
            }
          );
          await this.loadSession(session.id);
        } finally {
          this.cancelling = false;
        }
      });
  }

  async ngOnInit(): Promise<void> {
    const sessionId = this.route.snapshot.params['id'];
    await this.loadSession(sessionId);
    this.loadSessionLogs(sessionId);
    await this.startPolling(sessionId);
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
      this.snackBar.open('Failed to load session', 'Close', {
        duration: 3000,
      });
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
    if (typeof status === 'string') return status;
    if (typeof status === 'object') {
      return Object.entries(status)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    }
    return JSON.stringify(status);
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
      this.snackBar.open(
        `DC API error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'Close',
        { duration: 5000 }
      );
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

  copyToClipboard(text: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        this.snackBar.open('Copied to clipboard', 'Close', {
          duration: 2000,
        });
      })
      .catch(() => {
        this.snackBar.open('Failed to copy to clipboard', 'Close', {
          duration: 3000,
        });
      });
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
      const previousStatus = this.session ? this.getSessionStatusValue(this.session) : null;
      const updatedSession = await this.sessionManagementService.getSession(sessionId);
      const currentStatus = this.getSessionStatusValue(updatedSession);

      this.session = updatedSession;
      this.loadSessionLogs(sessionId);

      // Notify user of status changes
      if (previousStatus && previousStatus !== currentStatus) {
        this.snackBar.open(`Session status: ${currentStatus}`, 'Close', {
          duration: 4000,
          panelClass: this.getStatusSnackbarClass(currentStatus),
        });

        // Stop polling if session is in a final state
        if (['completed', 'expired', 'failed', 'cancelled'].includes(currentStatus)) {
          this.stopPolling();
        }
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

  getStatusSnackbarClass(status: string): string[] {
    switch (status) {
      case 'completed':
        return ['success-snackbar'];
      case 'failed':
      case 'expired':
      case 'cancelled':
        return ['error-snackbar'];
      default:
        return [];
    }
  }

  isPolling(): boolean {
    return this.pollingInterval !== null;
  }

  // Helper to check if this is an issuance session that might have a QR code
  isIssuanceSession(): boolean {
    return !this.session?.requestId;
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
