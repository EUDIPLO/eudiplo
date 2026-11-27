import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { PresentationConfig } from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-management.service';
import { MatTooltipModule } from '@angular/material/tooltip';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import {
  formatRegistrationCertExpiresIn,
  getRegistrationCertStatus,
  getRegistrationCertTimes,
  REGISTRATION_CERT_STATUS_LABELS,
  type RegistrationCertStatus,
  type RegistrationCertTimes,
} from '../../../utils/registration-cert-status';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../../utils/error-message';
import { focusAfterRenderIfLost } from '../../../common/focus-if-lost.util';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { MatDialog } from '@angular/material/dialog';
import { JwtService } from '../../../services/jwt.service';
import {
  EudiHubRegistrationDialogComponent,
  type EudiHubRegistrationDialogData,
} from '../../../registrar/eudi-hub-dialog/eudi-hub-registration-dialog.component';
import type { EudiHubRegistrationCertificate } from '../../../registrar/eudi-hub.service';
import { formatLifetime } from '../../../utils/duration';
import { RoleLockDirective } from '../../../common/role-lock.directive';
import { PRESENTATION_WRITE_ROLES } from '../../../services/resource-roles';

@Component({
  selector: 'app-presentation-show',
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatDividerModule,
    MatExpansionModule,
    MatTabsModule,
    RouterModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './presentation-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./presentation-show.component.scss'],
})
export class PresentationShowComponent implements OnInit {
  /** Creating, changing and deleting it needs presentation:manage; reading needs less. */
  readonly writeRoles = PRESENTATION_WRITE_ROLES;

  config?: PresentationConfig;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';

  readonly statusCheckModeLabels: Record<'strict' | 'best_effort' | 'disabled', string> = {
    strict: 'Strict',
    best_effort: 'Best effort',
    disabled: 'Disabled',
  };

  /** True while the configuration is being deleted, so Delete waits for it. */
  deleting = false;

  /** Where focus goes after a successful Retry removed the error card with its Retry button. */
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;

  /** Index of the Security tab, which `#security` opens. */
  static readonly SECURITY_TAB = 2;
  selectedTab = 0;

  constructor(
    private readonly presentationService: PresentationManagementService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly configDocuments: ConfigDocumentService,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService,
    private readonly injector: Injector
  ) {}

  /** New Verification opens the request page, which needs `presentation:request`. */
  get canRequestPresentation(): boolean {
    return this.jwtService.hasRole('presentation:request');
  }

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
      config.registration_cert?.jwt &&
      !confirm(
        'This replaces the registration certificate of this verification config with one from the EUDI Hub. It is not renewed automatically; request a new one before it expires and after the DCQL query changes.\n\nRequest a registration certificate from the EUDI Hub?'
      )
    ) {
      return;
    }
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
          purpose: config.registration_cert?.purpose,
          privacyPolicy: config.registration_cert?.privacy_policy,
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
    if (this.route.snapshot.fragment === 'security') {
      this.selectedTab = PresentationShowComponent.SECURITY_TAB;
    }
    void this.loadPresentation();
  }

  async loadPresentation(): Promise<void> {
    const retrying = this.loadError !== '';
    this.loadError = '';
    try {
      const presentationId = this.route.snapshot.paramMap.get('id');
      if (presentationId) {
        this.config = await this.presentationService.getPresentationById(presentationId);
      }
    } catch (error) {
      console.error('Error loading verification config:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load verification config');
    }
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
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
    return getRegistrationCertStatus(this.config);
  }

  get registrationCertLabel(): string {
    return REGISTRATION_CERT_STATUS_LABELS[this.registrationCertStatus];
  }

  get registrationCertExpiresIn(): string | null {
    return formatRegistrationCertExpiresIn(this.registrationCertTimes);
  }

  /** Issue and expiry time of the registration certificate, read from its JWT. */
  get registrationCertTimes(): RegistrationCertTimes | undefined {
    return getRegistrationCertTimes(this.config);
  }

  get registrationCertJwt(): string | null {
    return this.config?.registration_cert?.jwt || null;
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

  /** Formats a lifetime in seconds as on the credential configuration pages. */
  formatLifetime(seconds?: number | null): string {
    return formatLifetime(seconds);
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

  async deletePresentation(): Promise<void> {
    const config = this.config;
    if (
      !config ||
      this.deleting ||
      !this.jwtService.hasRole('presentation:manage') ||
      !confirm(`Delete verification config "${config.id}"? This cannot be undone.`)
    ) {
      return;
    }
    this.deleting = true;
    try {
      await this.presentationService.deleteConfiguration(config.id);
      this.snackBar.open('Verification config deleted', 'Close', { duration: 3000 });
      await this.router.navigate(['../'], { relativeTo: this.route });
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to delete verification config')
      );
      console.error('Delete error:', error);
    } finally {
      this.deleting = false;
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
