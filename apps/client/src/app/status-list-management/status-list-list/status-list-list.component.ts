import {
  Component,
  OnInit,
  ViewChild,
  AfterViewInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { StatusListResponseDto } from '@eudiplo/sdk-core';
import { StatusListManagementService } from '../status-list-management.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

@Component({
  selector: 'app-status-list-list',
  imports: [
    CommonModule,
    RouterModule,
    MatTableModule,
    MatSortModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatSnackBarModule,
    FlexLayoutModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
  ],
  templateUrl: './status-list-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './status-list-list.component.scss',
})
export class StatusListListComponent implements OnInit, AfterViewInit {
  @ViewChild(MatSort) sort!: MatSort;

  dataSource = new MatTableDataSource<StatusListResponseDto>([]);
  isLoading = true;
  /** Set when the lists could not be loaded, so the page does not claim there are none. */
  loadError = '';

  displayedColumns = [
    'id',
    'credentialConfigurationId',
    'keyChainId',
    'bits',
    'usage',
    'expiresAt',
    'actions',
  ];

  constructor(
    private readonly statusListService: StatusListManagementService,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router
  ) {}

  ngOnInit(): void {
    void this.loadData();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
  }

  private async loadData(): Promise<void> {
    this.isLoading = true;
    this.loadError = '';
    try {
      const lists = await this.statusListService.getLists();
      this.dataSource.data = lists;
    } catch (error) {
      console.error('Error loading status lists:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load status lists');
    } finally {
      this.isLoading = false;
    }
  }

  async refresh(): Promise<void> {
    await this.loadData();
  }

  getUsagePercentage(list: StatusListResponseDto): number {
    return this.statusListService.getUsagePercentage(list);
  }

  getUsageColor(list: StatusListResponseDto): string {
    const percentage = this.getUsagePercentage(list);
    if (percentage >= 90) return 'warn';
    if (percentage >= 70) return 'accent';
    return 'primary';
  }

  formatCapacity(capacity: number): string {
    return this.statusListService.formatCapacity(capacity);
  }

  navigateToCreate(): void {
    this.router.navigate(['/status-lists', 'create']);
  }

  navigateToEdit(list: StatusListResponseDto): void {
    this.router.navigate(['/status-lists', list.id]);
  }

  async deleteList(list: StatusListResponseDto): Promise<void> {
    if (list.usedEntries > 0) {
      this.snackBar.open('Cannot delete a status list that has entries in use', 'Close', {
        duration: 5000,
      });
      return;
    }

    if (!confirm(`Delete status list "${list.id}"? This cannot be undone.`)) {
      return;
    }

    try {
      await this.statusListService.deleteList(list.id);
      this.snackBar.open('Status list deleted successfully', 'Close', { duration: 3000 });
      this.refresh();
    } catch (error) {
      console.error('Error deleting status list:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete status list'));
    }
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
