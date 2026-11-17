import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { PresentationConfig } from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-management.service';
import { MatTooltipModule } from '@angular/material/tooltip';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import {
  formatRegistrationCertExpiresIn,
  getRegistrationCertStatus,
  type RegistrationCertStatus,
} from '../../../utils/registration-cert-status';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { MatDialog } from '@angular/material/dialog';
import { JwtService } from '../../../services/jwt.service';
import {
  EudiHubRegistrationDialogComponent,
  type EudiHubRegistrationDialogData,
} from '../../../registrar/eudi-hub-dialog/eudi-hub-registration-dialog.component';
import type { EudiHubRegistrationCertificate } from '../../../registrar/eudi-hub.service';

@Component({
  selector: 'app-presentation-show',
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    MatListModule,
    MatChipsModule,
    MatDividerModule,
    MatExpansionModule,
    MatTabsModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './presentation-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./presentation-show.component.scss'],
})
export class PresentationShowComponent implements OnInit {
  config?: PresentationConfig;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';
  reissuing = false;

  readonly statusCheckModeLabels: Record<'strict' | 'best_effort' | 'disabled', string> = {
    strict: 'Strict',
    best_effort: 'Best effort',
    disabled: 'Disabled',
  };

  constructor(
    private readonly presentationService: PresentationManagementService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly configDocuments: ConfigDocumentService,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService
  ) {}

  /** Requesting a registration certificate from the EUDI Hub needs both roles. */
  get canRequestFromEudiHub(): boolean {
    return (
      this.jwtService.hasRole('registrar:manage') && this.jwtService.hasRole('presentation:manage')
    );
  }

  /**
   * Opens the EUDI Hub dialog, which registers the DCQL query, requests a
   * registration certificate and stores it in this configuration.
   */
  requestFromEudiHub(): void {
    const config = this.config;
    if (!config) return;
    if (
      config.registration_cert &&
      !confirm(
        'This stores a registration certificate from the EUDI Hub in this configuration; it takes precedence over the current registration certificate settings, which are kept. It is not reissued automatically; request a new one before it expires and after the DCQL query changes.\n\nRequest a registration certificate from the EUDI Hub?'
      )
    ) {
      return;
    }
    const purposeEn = (
      config.registration_cert?.body as
        { purpose?: { lang?: string; content?: string }[] } | undefined
    )?.purpose?.find((entry) => entry.lang?.startsWith('en'))?.content;
    this.dialog
      .open<
        EudiHubRegistrationDialogComponent,
        EudiHubRegistrationDialogData,
        EudiHubRegistrationCertificate | undefined
      >(EudiHubRegistrationDialogComponent, {
        data: {
          kind: 'presentation',
          presentationConfigId: config.id,
          defaultName: config.description?.trim() || config.id,
          purposeEn,
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
        void this.loadPresentation();
      });
  }

  ngOnInit(): void {
    this.loadPresentation();
  }

  async loadPresentation(): Promise<void> {
    this.loadError = '';
    try {
      const presentationId = this.route.snapshot.paramMap.get('id');
      if (presentationId) {
        this.config = await this.presentationService.getPresentationById(presentationId);
      }
    } catch (error) {
      console.error('Error loading presentation:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load presentation configuration');
    }
  }

  get credentialQueries(): any[] {
    return this.config?.dcql_query?.credentials || [];
  }

  get statusCheckMode(): 'strict' | 'best_effort' | 'disabled' {
    const configured = (this.config as any)?.statusCheckMode;
    if (configured === 'best_effort' || configured === 'disabled') {
      return configured;
    }

    return 'strict';
  }

  get registrationCertStatus(): RegistrationCertStatus {
    if (!this.config) return 'none';
    return getRegistrationCertStatus({
      registration_cert: this.config.registration_cert,
      registrationCertCache: this.registrationCertCache as never,
    });
  }

  get registrationCertExpiresIn(): string | null {
    return formatRegistrationCertExpiresIn(this.registrationCertCache);
  }

  get registrationCertCache(): {
    jwt?: string;
    source?: string;
    issuedAt?: number;
    expiresAt?: number;
  } | null {
    const cache = (this.config?.registrationCertCache as any) ?? null;
    if (cache) return cache;
    // An imported JWT is cached in the background after it was saved, for
    // example from the EUDI Hub; until then its own times are shown.
    const jwt = this.config?.registration_cert?.jwt;
    if (typeof jwt !== 'string' || jwt.length === 0) return null;
    try {
      const { iat, exp } = decodeJwt(jwt);
      return { jwt, source: 'imported', issuedAt: iat, expiresAt: exp };
    } catch {
      return { jwt, source: 'imported' };
    }
  }

  get registrationCertJwt(): string | null {
    const cachedJwt = this.registrationCertCache?.jwt;
    if (cachedJwt) return cachedJwt;

    const configuredJwt = (this.config as any)?.registration_cert?.jwt;
    return typeof configuredJwt === 'string' && configuredJwt.length > 0 ? configuredJwt : null;
  }

  get registrationCertSource(): string | null {
    const source = this.registrationCertCache?.source;
    return typeof source === 'string' && source.length > 0 ? source : null;
  }

  get parsedRegistrationCertHeader(): string {
    const jwt = this.registrationCertJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeProtectedHeader(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT header: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  get parsedRegistrationCertPayload(): string {
    const jwt = this.registrationCertJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeJwt(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT payload: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  reissueRegistrationCert(): void {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (!this.config || this.reissuing) return;
    this.reissuing = true;
    this.presentationService
      .reissueRegistrationCertificate(this.config.id)
      .then((updated) => {
        if (updated) {
          this.config = updated;
        }
        this.snackBar.open('Registration certificate reissued', 'Close', {
          duration: 3000,
        });
      })
      .catch((err) => {
        console.error('Failed to reissue registration certificate', err);
        openErrorSnackBar(
          this.snackBar,
          getApiErrorMessage(err, 'Failed to reissue registration certificate')
        );
      })
      .finally(() => {
        this.reissuing = false;
      });
  }

  formatLifetime(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
    return `${Math.floor(seconds / 86400)} days`;
  }

  formatJsonValue(value: any): string {
    return JSON.stringify(value, null, 2);
  }

  isTrustedAuthorityObject(value: unknown): value is {
    url: string;
    verifierKey?: unknown;
    verifierX509Der?: string;
  } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'url' in value &&
      typeof (value as { url?: unknown }).url === 'string'
    );
  }

  formatTrustedAuthorityValue(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (this.isTrustedAuthorityObject(value)) {
      return value.url;
    }

    return JSON.stringify(value, null, 2);
  }

  deletePresentation() {
    if (
      this.config &&
      confirm(`Delete presentation configuration "${this.config.id}"? This cannot be undone.`)
    ) {
      this.presentationService
        .deleteConfiguration(this.config.id)
        .then(() => {
          this.snackBar.open('Presentation deleted successfully', 'Close', {
            duration: 3000,
          });
          this.router.navigate(['../'], { relativeTo: this.route });
        })
        .catch((error) => {
          openErrorSnackBar(
            this.snackBar,
            getApiErrorMessage(error, 'Failed to delete presentation')
          );
          console.error('Delete error:', error);
        });
    }
  }

  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('PresentationConfig');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return (
      !!this.config && this.configDocuments.isDownloading('PresentationConfig', this.config.id)
    );
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.config) return;
    await this.configDocuments.downloadWithFeedback('PresentationConfig', this.config.id);
  }
}
