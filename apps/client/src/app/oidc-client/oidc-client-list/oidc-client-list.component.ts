import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import type { OidcClientResponseDto } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { JwtService } from '../../services/jwt.service';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { searchAndSort } from '../../utils/search-list';
import { PROFILE_LABELS } from '../oidc-client-create/oidc-client-form';
import { OidcClientService } from '../oidc-client.service';

@Component({
  selector: 'app-oidc-client-list',
  imports: [
    MatTableModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    FormsModule,
    RouterModule,
    LoadErrorComponent,
  ],
  templateUrl: './oidc-client-list.component.html',
  styleUrl: './oidc-client-list.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OidcClientListComponent extends BaseAsyncListComponent<OidcClientResponseDto> {
  protected readonly loadFailedMessage = 'Failed to load OIDC clients';

  readonly displayedColumns = ['name', 'id', 'profile', 'scopes', 'actions'];

  /** Text to find in a client's name, client ID or scopes. */
  search = '';
  /** The last search result, kept until the clients or the search change. */
  private shown?: {
    clients: OidcClientResponseDto[];
    search: string;
    result: OidcClientResponseDto[];
  };

  /** The client whose delete runs; its Delete waits for it. */
  deletingId?: string;

  private readonly snackBar = inject(MatSnackBar);
  private readonly jwtService = inject(JwtService);

  constructor(private readonly oidcClientService: OidcClientService) {
    super();
  }

  get clients(): OidcClientResponseDto[] {
    return this.items;
  }

  /** The clients that match the search, sorted by name. */
  get shownClients(): OidcClientResponseDto[] {
    if (this.shown?.clients !== this.items || this.shown.search !== this.search) {
      const result = searchAndSort(
        this.items,
        this.search,
        (client) => [client.name, client.id, ...client.scopes.map(({ scope }) => scope)],
        (client) => client.name
      );
      this.shown = { clients: this.items, search: this.search, result };
    }
    return this.shown.result;
  }

  clearSearch(): void {
    this.search = '';
  }

  protected fetchItems(): Promise<OidcClientResponseDto[]> {
    return this.oidcClientService.getAll();
  }

  profileLabel(client: OidcClientResponseDto): string {
    return PROFILE_LABELS[client.profile];
  }

  async deleteClient(client: OidcClientResponseDto): Promise<void> {
    if (
      this.deletingId === client.id ||
      !this.jwtService.hasRole('presentation:manage') ||
      !confirm(
        `Delete OIDC client "${client.name}"? Applications using it can no longer sign users in. This cannot be undone.`
      )
    ) {
      return;
    }
    this.deletingId = client.id;
    try {
      await this.oidcClientService.delete(client.id);
      this.items = this.items.filter((c) => c.id !== client.id);
      this.snackBar.open('OIDC client deleted', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Delete error:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete OIDC client'));
    } finally {
      this.deletingId = undefined;
    }
  }
}
