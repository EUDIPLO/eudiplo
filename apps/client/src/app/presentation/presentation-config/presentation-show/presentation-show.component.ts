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
import { presentationManagementControllerReissueRegistrationCertificate } from '@eudiplo/sdk-core';
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
    private readonly configDocuments: ConfigDocumentService
  ) {}

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
    return getRegistrationCertStatus(this.config);
  }

  get registrationCertExpiresIn(): string | null {
    return formatRegistrationCertExpiresIn(this.config?.registrationCertCache as any);
  }

  get registrationCertCache(): {
    jwt?: string;
    source?: string;
    issuedAt?: number;
    expiresAt?: number;
  } | null {
    return (this.config?.registrationCertCache as any) ?? null;
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
    if (!this.config) return;
    this.reissuing = true;
    presentationManagementControllerReissueRegistrationCertificate({
      path: { id: this.config.id },
    })
      .then((res: any) => {
        if (res?.data) {
          this.config = res.data;
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
