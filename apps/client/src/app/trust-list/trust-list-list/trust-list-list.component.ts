import { CommonModule } from '@angular/common';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { TrustList } from '@eudiplo/sdk-core';
import { MatCardModule } from '@angular/material/card';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TrustListService } from '../trust-list.service';
import { ItemRoutePipe } from '../../common/item-route.pipe';
import { RoleLockDirective } from '../../common/role-lock.directive';
import { SHARED_WRITE_ROLES } from '../../services/resource-roles';

@Component({
  selector: 'app-trust-list-list',
  imports: [
    ItemRoutePipe,
    MatTableModule,
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    MatTooltipModule,
    RouterModule,
    MatCardModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './trust-list-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './trust-list-list.component.scss',
})
export class TrustListListComponent extends BaseAsyncListComponent<TrustList> {
  /** Creating, changing and deleting it needs issuance:manage or presentation:manage; reading needs less. */
  readonly writeRoles = SHARED_WRITE_ROLES;

  protected readonly loadFailedMessage = 'Failed to load trust lists';

  get lists(): TrustList[] {
    return this.items;
  }

  displayedColumns: (keyof TrustList | 'actions')[] = [
    'id',
    'description',
    'sequenceNumber',
    'updatedAt',
    'actions',
  ];

  constructor(
    private readonly trustListService: TrustListService,
    protected readonly configDocuments: ConfigDocumentService
  ) {
    super();
  }

  protected fetchItems(): Promise<TrustList[]> {
    return this.trustListService.getAll();
  }

  async downloadConfig(list: TrustList): Promise<void> {
    await this.configDocuments.downloadWithFeedback('TrustList', list.id);
  }
}
