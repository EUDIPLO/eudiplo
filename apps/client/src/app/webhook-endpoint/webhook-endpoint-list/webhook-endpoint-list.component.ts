import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { WebhookEndpointEntity } from '@eudiplo/sdk-core';
import { getApiKeyAuthType } from '../../common/auth-display.util';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { focusRowAfterRemoval } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { getRole, JwtService } from '../../services/jwt.service';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { searchAndSort } from '../../utils/search-list';
import { WebhookEndpointService } from '../webhook-endpoint.service';

/** Roles that may manage webhook endpoints; either one is enough. */
const WEBHOOK_ROLES = [getRole('issuance:manage'), getRole('presentation:manage')];

@Component({
  selector: 'app-webhook-endpoint-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    FormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
  ],
  templateUrl: './webhook-endpoint-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './webhook-endpoint-list.component.scss',
})
export class WebhookEndpointListComponent extends BaseAsyncListComponent<WebhookEndpointEntity> {
  protected readonly loadFailedMessage = 'Failed to load webhook endpoints';

  readonly displayedColumns = ['name', 'url', 'auth', 'actions'];

  /** Text to find in an endpoint's ID, name, description or URL. */
  search = '';
  /** The last search result, kept until the endpoints or the search change. */
  private shown?: {
    endpoints: WebhookEndpointEntity[];
    search: string;
    result: WebhookEndpointEntity[];
  };

  /** IDs of the endpoints whose delete runs; their Delete waits for it. */
  readonly deleting = new Set<string>();
  /** Whether the caller may change webhook endpoints; read once instead of per row. */
  readonly canManage: boolean;

  /** Takes the focus after a delete removed the last row. */
  @ViewChild('listHeading') private readonly heading?: ElementRef<HTMLElement>;
  @ViewChild('table', { read: ElementRef }) private readonly table?: ElementRef<HTMLElement>;
  private readonly focusInjector = inject(Injector);

  constructor(
    private readonly webhookEndpointService: WebhookEndpointService,
    private readonly snackBar: MatSnackBar,
    jwtService: JwtService
  ) {
    super();
    this.canManage = jwtService.hasRole(WEBHOOK_ROLES);
  }

  get endpoints(): WebhookEndpointEntity[] {
    return this.items;
  }

  /** The endpoints that match the search, sorted by name. */
  get shownEndpoints(): WebhookEndpointEntity[] {
    if (this.shown?.endpoints !== this.items || this.shown.search !== this.search) {
      const result = searchAndSort(
        this.items,
        this.search,
        (endpoint) => [endpoint.id, endpoint.name, endpoint.description ?? '', endpoint.url],
        (endpoint) => endpoint.name || endpoint.id
      );
      this.shown = { endpoints: this.items, search: this.search, result };
    }
    return this.shown.result;
  }

  clearSearch(): void {
    this.search = '';
  }

  protected fetchItems(): Promise<WebhookEndpointEntity[]> {
    return this.webhookEndpointService.getAll();
  }

  /** Whether EUDIPLO sends an API key to the endpoint. */
  hasApiKey(endpoint: WebhookEndpointEntity): boolean {
    return getApiKeyAuthType(endpoint.auth as { type?: string }) !== 'None';
  }

  async deleteEndpoint(endpoint: WebhookEndpointEntity): Promise<void> {
    // Delete stays focusable while a delete runs (disabledInteractive).
    if (
      !this.canManage ||
      this.deleting.has(endpoint.id) ||
      !confirm(`Delete webhook endpoint "${endpoint.name || endpoint.id}"? This cannot be undone.`)
    ) {
      return;
    }

    this.deleting.add(endpoint.id);
    try {
      await this.webhookEndpointService.delete(endpoint.id);
      const index = this.shownEndpoints.indexOf(endpoint);
      this.items = this.items.filter((item) => item.id !== endpoint.id);
      this.snackBar.open('Webhook endpoint deleted successfully', 'Close', { duration: 3000 });
      // The row with the focused Delete button is gone: focus the endpoint now in its place.
      focusRowAfterRemoval(
        this.focusInjector,
        () => [
          ...(this.table?.nativeElement.querySelectorAll<HTMLElement>('a.endpoint-link') ?? []),
        ],
        index,
        () => this.heading?.nativeElement
      );
    } catch (error) {
      console.error('Delete error:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to delete webhook endpoint')
      );
    } finally {
      this.deleting.delete(endpoint.id);
    }
  }
}
