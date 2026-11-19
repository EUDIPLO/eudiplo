import { ChangeDetectionStrategy, Component } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { StatusListResponseDto } from '@eudiplo/sdk-core';
import { StatusListManagementService } from '../status-list-management.service';
import { formatCapacity, getUsageColor, getUsagePercentage } from '../status-list-usage';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { LoadErrorComponent } from '../../common/load-error.component';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { ItemRoutePipe } from '../../common/item-route.pipe';

@Component({
  selector: 'app-status-list-list',
  imports: [
    ItemRoutePipe,
    DecimalPipe,
    FormsModule,
    RouterModule,
    MatTableModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
  ],
  templateUrl: './status-list-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './status-list-list.component.scss',
})
export class StatusListListComponent extends BaseAsyncListComponent<StatusListResponseDto> {
  protected readonly loadFailedMessage = 'Failed to load status lists';

  get lists(): StatusListResponseDto[] {
    return this.items;
  }

  displayedColumns = [
    'id',
    'credentialConfigurationId',
    'keyChainId',
    'bits',
    'usage',
    'expiresAt',
    'actions',
  ];

  constructor(private readonly statusListService: StatusListManagementService) {
    super();
  }

  protected fetchItems(): Promise<StatusListResponseDto[]> {
    return this.statusListService.getLists();
  }

  /** Also finds lists by their JWT status, such as "expired". */
  protected override searchTexts(list: StatusListResponseDto): string[] {
    return [
      list.id,
      list.credentialConfigurationId ?? '',
      list.keyChainId ?? '',
      this.getExpirationLabel(list),
    ];
  }

  protected override sortName(list: StatusListResponseDto): string {
    return list.id;
  }

  getUsagePercentage(list: StatusListResponseDto): number {
    return getUsagePercentage(list);
  }

  getUsageColor(list: StatusListResponseDto): string {
    return getUsageColor(list);
  }

  formatCapacity(capacity: number): string {
    return formatCapacity(capacity);
  }

  /** Why Delete waits or refuses, else what it does. */
  listDeleteTooltip(list: StatusListResponseDto): string {
    if (list.usedEntries > 0) return 'Cannot delete: entries in use';
    return this.deleteTooltip(list.id, 'Delete status list', 'Deleting the status list…');
  }

  /** A list with entries in use cannot be deleted; its button only looks disabled. */
  deleteList(list: StatusListResponseDto): Promise<void> {
    if (list.usedEntries > 0) {
      this.snackBar.open('Cannot delete a status list that has entries in use', 'Close', {
        duration: 5000,
      });
      return Promise.resolve();
    }
    return this.deleteItem({
      item: list,
      id: list.id,
      question: `Delete status list "${list.id}"? This cannot be undone.`,
      request: () => this.statusListService.deleteList(list.id),
      deleted: 'Status list deleted successfully',
      failed: 'Failed to delete status list',
    });
  }

  async copyUri(uri: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      uri,
      'URI copied to clipboard',
      'Could not copy the URI. Open the status list and copy it from its URI field.'
    );
  }

  getExpirationStatus(list: StatusListResponseDto): 'valid' | 'expiring' | 'expired' | 'none' {
    if (!list.expiresAt) return 'none';
    const expiresAt = new Date(list.expiresAt);
    const now = new Date();
    const diffMs = expiresAt.getTime() - now.getTime();
    if (diffMs < 0) return 'expired';
    // Expiring if less than 1 hour remaining
    if (diffMs < 60 * 60 * 1000) return 'expiring';
    return 'valid';
  }

  /** Tone of the JWT status badge. */
  expirationBadgeClass(list: StatusListResponseDto): string {
    const tone = { valid: 'status-active', expiring: 'status-warning', expired: 'status-danger' };
    const status = this.getExpirationStatus(list);
    return `badge above-link ${status === 'none' ? '' : tone[status]}`.trim();
  }

  /** The JWT status as the badge names it. */
  getExpirationLabel(list: StatusListResponseDto): string {
    return { valid: 'Valid', expiring: 'Expiring', expired: 'Expired', none: 'Not generated' }[
      this.getExpirationStatus(list)
    ];
  }

  getExpirationTooltip(list: StatusListResponseDto): string {
    if (!list.expiresAt) return 'JWT not generated yet';
    const status = this.getExpirationStatus(list);
    const expiresAt = new Date(list.expiresAt);
    switch (status) {
      case 'expired':
        return `Expired ${expiresAt.toLocaleString()}. Will regenerate on next request.`;
      case 'expiring':
        return `Expires soon: ${expiresAt.toLocaleString()}`;
      case 'valid':
        return `Expires ${expiresAt.toLocaleString()}`;
      default:
        return 'JWT not generated yet';
    }
  }
}
