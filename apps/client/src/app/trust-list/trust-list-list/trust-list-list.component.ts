import { CommonModule } from '@angular/common';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { TrustList } from '@eudiplo/sdk-core';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TrustListService } from '../trust-list.service';
import { TrustListStatusComponent } from '../trust-list-status/trust-list-status.component';

@Component({
  selector: 'app-trust-list-list',
  imports: [
    MatTableModule,
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    MatTooltipModule,
    RouterModule,
    FlexLayoutModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
    TrustListStatusComponent,
  ],
  templateUrl: './trust-list-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './trust-list-list.component.scss',
})
export class TrustListListComponent extends BaseAsyncListComponent<TrustList> {
  protected readonly loadFailedMessage = 'Failed to load trust lists';

  get lists(): TrustList[] {
    return this.items;
  }

  displayedColumns: (keyof TrustList | 'actions')[] = ['id', 'description', 'actions'];

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
