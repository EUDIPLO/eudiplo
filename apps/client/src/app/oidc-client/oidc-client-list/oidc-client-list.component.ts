import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import type { OidcClientResponseDto } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { PROFILE_LABELS } from '../oidc-client-create/oidc-client-form';
import { OidcClientService } from '../oidc-client.service';

@Component({
  selector: 'app-oidc-client-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    RouterModule,
    FlexLayoutModule,
    LoadErrorComponent,
  ],
  templateUrl: './oidc-client-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OidcClientListComponent extends BaseAsyncListComponent<OidcClientResponseDto> {
  protected readonly loadFailedMessage = 'Failed to load OIDC clients';

  readonly displayedColumns = ['id', 'name', 'scopes', 'profile', 'actions'];

  constructor(private readonly oidcClientService: OidcClientService) {
    super();
  }

  get clients(): OidcClientResponseDto[] {
    return this.items;
  }

  protected fetchItems(): Promise<OidcClientResponseDto[]> {
    return this.oidcClientService.getAll();
  }

  profileLabel(client: OidcClientResponseDto): string {
    return PROFILE_LABELS[client.profile];
  }

  scopeNames(client: OidcClientResponseDto): string {
    return client.scopes.map(({ scope }) => scope).join(', ') || '—';
  }
}
