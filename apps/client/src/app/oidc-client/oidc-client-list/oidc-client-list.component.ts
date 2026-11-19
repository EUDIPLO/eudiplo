import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import type { OidcClientResponseDto } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { PROFILE_LABELS } from '../oidc-client-create/oidc-client-form';
import { oidcClientDeleteConfirmation } from '../oidc-client-delete-confirmation';
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

  constructor(private readonly oidcClientService: OidcClientService) {
    super();
  }

  get clients(): OidcClientResponseDto[] {
    return this.items;
  }

  protected override searchTexts(client: OidcClientResponseDto): string[] {
    return [client.name, client.id, ...client.scopes.map(({ scope }) => scope)];
  }

  protected override sortName(client: OidcClientResponseDto): string {
    return client.name;
  }

  protected fetchItems(): Promise<OidcClientResponseDto[]> {
    return this.oidcClientService.getAll();
  }

  profileLabel(client: OidcClientResponseDto): string {
    return PROFILE_LABELS[client.profile];
  }

  deleteClient(client: OidcClientResponseDto): Promise<boolean> {
    return this.deleteItem({
      item: client,
      id: client.id,
      question: oidcClientDeleteConfirmation(client.name),
      request: () => this.oidcClientService.delete(client.id),
      deleted: 'OIDC client deleted',
      failed: 'Failed to delete OIDC client',
    });
  }
}
