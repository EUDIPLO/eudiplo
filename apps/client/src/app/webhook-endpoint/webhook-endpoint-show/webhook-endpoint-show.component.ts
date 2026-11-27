import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  type OnInit,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { WebhookEndpointEntity } from '@eudiplo/sdk-core';
import { getApiKeyAuthType, getApiKeyHeaderName } from '../../common/auth-display.util';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { WebhookEndpointService } from '../webhook-endpoint.service';
import { RoleLockDirective } from '../../common/role-lock.directive';
import { SHARED_WRITE_ROLES } from '../../services/resource-roles';

@Component({
  selector: 'app-webhook-endpoint-show',
  imports: [
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
  templateUrl: './webhook-endpoint-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './webhook-endpoint-show.component.scss',
})
export class WebhookEndpointShowComponent implements OnInit {
  /** Creating, changing and deleting it needs issuance:manage or presentation:manage; reading needs less. */
  readonly writeRoles = SHARED_WRITE_ROLES;

  endpoint: WebhookEndpointEntity | undefined;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';
  /** While the delete runs; Delete waits for it. */
  deleting = false;

  /** Takes the focus after a successful Retry, which removed the focused Retry button. */
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;
  private readonly injector = inject(Injector);

  constructor(
    private readonly webhookEndpointService: WebhookEndpointService,
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
      const retrying = this.loadError !== '';
      this.loadError = '';
      this.webhookEndpointService.getById(id).then(
        (endpoint) => {
          this.endpoint = endpoint;
          if (retrying) {
            focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
          }
        },
        (error) => {
          console.error('Load error:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load webhook endpoint');
        }
      );
    }
  }

  /** How EUDIPLO authenticates to the endpoint, as the list's badge says it. */
  get authLabel(): string {
    return getApiKeyAuthType(this.endpoint?.auth as { type?: string } | undefined) === 'None'
      ? 'No authentication'
      : 'API key';
  }

  getAuthHeaderName(): string | null {
    return getApiKeyHeaderName(
      this.endpoint?.auth as { type?: string; config?: { headerName?: string } } | undefined
    );
  }

  async copyUrl(): Promise<void> {
    if (!this.endpoint) return;
    await copyToClipboard(
      this.snackBar,
      this.endpoint.url,
      'URL copied to clipboard',
      'Could not copy the URL'
    );
  }

  deleteEndpoint(): void {
    // Delete stays focusable while the delete runs (disabledInteractive).
    if (
      !this.endpoint ||
      this.deleting ||
      !confirm(
        `Delete webhook endpoint "${this.endpoint.name || this.endpoint.id}"? This cannot be undone.`
      )
    ) {
      return;
    }
    this.deleting = true;
    this.webhookEndpointService
      .delete(this.endpoint.id)
      .then(() => {
        this.snackBar.open('Webhook endpoint deleted successfully', 'Close', { duration: 3000 });
        this.router.navigate(['../'], { relativeTo: this.route });
      })
      .catch((error) => {
        openErrorSnackBar(
          this.snackBar,
          getApiErrorMessage(error, 'Failed to delete webhook endpoint')
        );
        console.error('Delete error:', error);
      })
      .finally(() => (this.deleting = false));
  }

  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('WebhookEndpoint');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return (
      !!this.endpoint && this.configDocuments.isDownloading('WebhookEndpoint', this.endpoint.id)
    );
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.endpoint) return;
    await this.configDocuments.downloadWithFeedback('WebhookEndpoint', this.endpoint.id);
  }
}
