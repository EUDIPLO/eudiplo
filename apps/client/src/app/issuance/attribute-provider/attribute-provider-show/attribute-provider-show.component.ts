import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { AttributeProviderEntity } from '@eudiplo/sdk-core';
import { getApiKeyAuthType, getApiKeyHeaderName } from '../../../common/auth-display.util';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import { AttributeProviderService } from '../attribute-provider.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../../utils/error-message';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { confirmAndDelete } from '../../../common/confirm-delete';
import { RoleLockDirective } from '../../../common/role-lock.directive';
import { ISSUANCE_WRITE_ROLES } from '../../../services/resource-roles';

@Component({
  selector: 'app-attribute-provider-show',
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    RouterModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './attribute-provider-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './attribute-provider-show.component.scss',
})
export class AttributeProviderShowComponent implements OnInit {
  /** Creating, changing and deleting it needs issuance:manage; reading needs less. */
  readonly writeRoles = ISSUANCE_WRITE_ROLES;

  provider: AttributeProviderEntity | undefined;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';
  /** True while the provider is deleted; Delete waits for it. */
  deleting = false;

  constructor(
    private readonly attributeProviderService: AttributeProviderService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly configDocuments: ConfigDocumentService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.loadError = '';
      this.attributeProviderService.getById(id).then(
        (provider) => (this.provider = provider),
        (error) => {
          console.error('Load error:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load attribute provider');
        }
      );
    }
  }

  getAuthType(): string {
    return getApiKeyAuthType(this.provider?.auth as { type?: string } | undefined);
  }

  getAuthHeaderName(): string | null {
    return getApiKeyHeaderName(
      this.provider?.auth as { type?: string; config?: { headerName?: string } } | undefined
    );
  }

  /**
   * Deletes the provider after the caller confirmed it, then returns to the list. A second click
   * while the delete runs does nothing.
   */
  async deleteProvider(): Promise<void> {
    const provider = this.provider;
    if (!provider || this.deleting) {
      return;
    }
    const deleted = await confirmAndDelete(this.snackBar, {
      question: `Delete attribute provider "${provider.name || provider.id}"? This cannot be undone.`,
      request: () => this.attributeProviderService.delete(provider.id),
      deleted: 'Attribute provider deleted successfully',
      failed: 'Failed to delete attribute provider',
      busy: (busy) => (this.deleting = busy),
    });
    if (deleted) {
      void this.router.navigate(['../'], { relativeTo: this.route });
    }
  }

  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('AttributeProvider');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return (
      !!this.provider && this.configDocuments.isDownloading('AttributeProvider', this.provider.id)
    );
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.provider) return;
    await this.configDocuments.downloadWithFeedback('AttributeProvider', this.provider.id);
  }
}
