import { ChangeDetectionStrategy, Component, OnInit, Optional } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { JwtService } from '../../../services/jwt.service';
import {
  EudiHubRegistrationDialogComponent,
  type EudiHubRegistrationDialogData,
} from '../../../registrar/eudi-hub-dialog/eudi-hub-registration-dialog.component';
import type { EudiHubRegistrationCertificate } from '../../../registrar/eudi-hub.service';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import {
  formatRegistrationCertExpiresIn,
  getIssuerRegistrationCertStatus,
  registrationCertStatusSentence,
  type RegistrationCertStatus,
} from '../../../utils/registration-cert-status';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { IssuanceConfig } from '@eudiplo/sdk-core';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import {
  defaultAccessTokenLifetimeSeconds,
  IssuanceConfigService,
  statusCheckModeLabel,
} from '../issuance-config.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../../utils/error-message';
import { copyToClipboard } from '../../../utils/copy-to-clipboard';
import { LoadErrorComponent } from '../../../common/load-error.component';

interface ChainedAuthorizationServerView {
  enabled: boolean;
  upstream?: {
    issuer?: string;
    clientId?: string;
    scopes?: string[];
  };
  token?: {
    lifetimeSeconds?: number;
    refreshTokenEnabled?: boolean;
    refreshTokenExpiresInSeconds?: number;
  };
  requireDPoP?: boolean;
}

interface AuthorizationServerRow {
  label: string;
  id: string;
  type: string;
  preferred: boolean;
  enabled: boolean;
  dpop: string;
  statusCheck: string;
  tokenLifetime: number;
  refresh: string;
  details: string;
}

@Component({
  selector: 'app-issuance-config-show',
  imports: [
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    DatePipe,
    MatExpansionModule,
    MatChipsModule,
    MatDividerModule,
    MatListModule,
    MatTabsModule,
    MatTableModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './issuance-config-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './issuance-config-show.component.scss',
})
export class IssuanceConfigShowComponent implements OnInit {
  config?: IssuanceConfig;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';
  readonly authServerDisplayedColumns = [
    'label',
    'id',
    'type',
    'preferred',
    'enabled',
    'dpop',
    'statusCheck',
    'token',
    'refresh',
    'details',
  ];

  constructor(
    private readonly issuanceConfigService: IssuanceConfigService,
    private readonly snackBar: MatSnackBar,
    private readonly configDocuments: ConfigDocumentService,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService,
    @Optional() private readonly route?: ActivatedRoute
  ) {}

  /** Index of the Registration Certificate tab, which `#registration-certificate` opens. */
  static readonly REGISTRATION_CERTIFICATE_TAB = 3;
  selectedTab = 0;

  /** What to confirm before a certificate from the EUDI Hub replaces the current one. */
  private eudiHubReplacementQuestion(): string | undefined {
    const settings = this.registrationCertificateConfig;
    if (!settings?.enabled || !settings.jwt) return undefined;
    return `This replaces the issuer registration certificate. A certificate from the EUDI Hub is not renewed automatically; request a new one before it expires and after the credential types change.\n\nRequest a registration certificate from the EUDI Hub?`;
  }

  /** Requesting a registration certificate from the EUDI Hub needs both roles. */
  get canRequestFromEudiHub(): boolean {
    return (
      this.jwtService.hasRole('registrar:manage') && this.jwtService.hasRole('issuance:manage')
    );
  }

  /**
   * Opens the EUDI Hub dialog, which registers the credential types, requests
   * a registration certificate and stores it in the issuer settings.
   */
  requestFromEudiHub(): void {
    const question = this.eudiHubReplacementQuestion();
    if (question && !confirm(question)) return;
    this.dialog
      .open<
        EudiHubRegistrationDialogComponent,
        EudiHubRegistrationDialogData,
        EudiHubRegistrationCertificate | undefined
      >(EudiHubRegistrationDialogComponent, {
        data: {
          kind: 'issuer',
          defaultName: 'Issuer registration certificate',
          supportUri: this.registrationCertificateConfig?.supportUri,
        },
        width: '720px',
        maxWidth: '95vw',
        // Escape or a backdrop click must not drop a request that is still running.
        disableClose: true,
      })
      .afterClosed()
      .subscribe((certificate) => {
        if (certificate) {
          this.snackBar.open(
            `Registration certificate from the EUDI Hub (${certificate.environment}) stored`,
            'Close',
            { duration: 4000 }
          );
        }
        // A failed request may still have stored a certificate.
        this.loadConfig();
      });
  }

  get primaryDisplay(): any {
    return this.config?.display?.[0];
  }

  get externalAuthorizationServers(): string[] {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (Array.isArray(authorizationServers)) {
      return authorizationServers
        .filter((server: any) => server?.type === 'external' && typeof server?.issuer === 'string')
        .map((server: any) => server.issuer);
    }

    return [];
  }

  get hostedAuthorizationServers(): any[] {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (!Array.isArray(authorizationServers)) {
      return [];
    }

    return authorizationServers.filter((server: any) => server?.type === 'oid4vp');
  }

  get chainedAuthorizationServer(): ChainedAuthorizationServerView | undefined {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (Array.isArray(authorizationServers)) {
      const chained = authorizationServers.find(
        (server: any) => server?.type === 'chained' && server?.enabled !== false
      );
      if (chained) {
        return {
          enabled: true,
          upstream: {
            issuer: chained.upstream?.issuer,
            clientId: chained.upstream?.clientId,
            scopes: chained.upstream?.scopes,
          },
          token: {
            lifetimeSeconds: chained.token?.lifetimeSeconds,
            refreshTokenEnabled: chained.token?.refreshTokenEnabled,
            refreshTokenExpiresInSeconds: chained.token?.refreshTokenExpiresInSeconds,
          },
          requireDPoP: chained.requireDPoP,
        };
      }
    }

    return undefined;
  }

  get registrationCertificateConfig(): any {
    return (this.config as any)?.registrationCertificate;
  }

  /** The certificate the issuer serves, with its issue and expiry times. */
  get registrationCertificateCache(): any {
    const jwt = this.registrationCertificateConfig?.jwt;
    if (typeof jwt !== 'string' || jwt.length === 0) return undefined;
    try {
      const { iat, exp } = decodeJwt(jwt);
      return { jwt, issuedAt: iat, expiresAt: exp };
    } catch {
      return { jwt };
    }
  }

  get registrationCertificateJwt(): string | null {
    const importedJwt = this.registrationCertificateConfig?.jwt;
    if (typeof importedJwt === 'string' && importedJwt.length > 0) {
      return importedJwt;
    }

    return null;
  }

  /** Status of the issuer registration certificate; `none` while it is turned off. */
  get registrationCertificateStatus(): RegistrationCertStatus {
    return getIssuerRegistrationCertStatus(this.registrationCertificateConfig);
  }

  /** What the status means and what to do next. */
  get registrationCertificateStatusText(): string {
    return (
      registrationCertStatusSentence(
        this.registrationCertificateStatus,
        formatRegistrationCertExpiresIn(this.registrationCertificateCache)
      ) ?? 'Turned off'
    );
  }

  get parsedRegistrationCertHeader(): string {
    const jwt = this.registrationCertificateJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeProtectedHeader(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT header: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  get parsedRegistrationCertPayload(): string {
    const jwt = this.registrationCertificateJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeJwt(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT payload: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  get authorizationServerRows(): AuthorizationServerRow[] {
    const servers = ((this.config as any)?.authorizationServers ?? []) as any[];
    const rows = servers
      .filter((server) => {
        if (server?.type === 'external') {
          return typeof server?.issuer === 'string' && server.issuer.length > 0;
        }
        return (
          server?.type === 'oid4vp' || server?.type === 'chained' || server?.type === 'built-in'
        );
      })
      .map((server) => {
        if (server?.type === 'external') {
          return {
            label: server.label || server.issuer,
            id: server.id || '-',
            type: 'external',
            preferred: false,
            enabled: server.enabled !== false,
            dpop: '-',
            statusCheck: '-',
            tokenLifetime: 0,
            refresh: '-',
            details: server.issuer,
          };
        }

        const refreshEnabled = server?.token?.refreshTokenEnabled ?? true;
        const refreshLifetime = server?.token?.refreshTokenExpiresInSeconds || 2592000;
        const isOid4vp = server?.type === 'oid4vp';
        const isBuiltIn = server?.type === 'built-in';
        return {
          label: server.label || server.id || 'Authorization Server',
          id: server.id || '-',
          type: server.type,
          preferred: false,
          enabled: server.enabled !== false,
          dpop: server.requireDPoP ? 'required' : 'optional',
          statusCheck: server.walletAttestationStatusCheckMode
            ? statusCheckModeLabel(server.walletAttestationStatusCheckMode)
            : `Issuer default: ${statusCheckModeLabel(this.config?.walletAttestationStatusCheckMode)}`,
          tokenLifetime:
            server?.token?.lifetimeSeconds || defaultAccessTokenLifetimeSeconds(server?.type),
          refresh: refreshEnabled ? `${refreshLifetime}s` : 'disabled',
          details: isBuiltIn
            ? 'issuer-local authorization server'
            : isOid4vp
              ? `presentation=${server.presentationConfigId || server.oid4vp?.presentationConfigId || 'n/a'}`
              : `issuer=${server.upstream?.issuer || 'n/a'}, client=${server.upstream?.clientId || 'n/a'}`,
        };
      });

    const preferredIndex = rows.findIndex((row) => row.enabled);
    if (preferredIndex >= 0) {
      rows[preferredIndex].preferred = true;
    }

    return rows;
  }

  readonly statusCheckModeLabel = statusCheckModeLabel;

  async copyRegistrationCertificateJwt(jwt: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      jwt,
      'Registration certificate JWT copied to clipboard',
      'Could not copy the registration certificate JWT. Select it below and copy it by hand.'
    );
  }

  ngOnInit(): void {
    if (this.route?.snapshot.fragment === 'registration-certificate') {
      this.selectedTab = IssuanceConfigShowComponent.REGISTRATION_CERTIFICATE_TAB;
    }
    this.loadConfig();
  }

  loadConfig(): void {
    this.loadError = '';
    this.issuanceConfigService.getConfig().then(
      (config) => {
        this.config = config;
      },
      (error) => {
        console.error('Load error:', error);
        this.loadError = getApiErrorMessage(error, 'Failed to load issuer settings');
      }
    );
  }

  getObjectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  formatDate(dateString?: string): string {
    if (!dateString) return 'Not set';
    return new Date(dateString).toLocaleString();
  }

  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('IssuanceConfig');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return !!this.config && this.configDocuments.isDownloading('IssuanceConfig', 'issuance');
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.config) return;
    await this.configDocuments.downloadWithFeedback('IssuanceConfig', 'issuance');
  }
}
