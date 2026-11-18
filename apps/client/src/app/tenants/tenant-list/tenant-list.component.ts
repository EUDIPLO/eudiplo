import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSortModule, Sort, SortDirection } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  tenantControllerDeleteTenant,
  tenantControllerGetTenants,
  TenantResponseDto,
} from '@eudiplo/sdk-core';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-tenant-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    RouterModule,
    MatTooltipModule,
    MatSnackBarModule,
    LoadErrorComponent,
    MatProgressSpinnerModule,
    FormsModule,
    MatDividerModule,
    MatMenuModule,
    MatSortModule,
    MatPaginatorModule,
  ],
  templateUrl: './tenant-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './tenant-list.component.scss',
})
export class TenantListComponent implements OnInit {
  /** The name column also shows the ID. */
  displayedColumns: (keyof TenantResponseDto | 'actions')[] = [
    'name',
    'description',
    'status',
    'actions',
  ];
  tenants: TenantResponseDto[] = [];
  /** The tenants that match the search, on all pages. */
  filteredTenants: TenantResponseDto[] = [];
  /** The tenants of the current page. */
  shownTenants: TenantResponseDto[] = [];
  /** Text to find in a tenant's ID, name or description. */
  search = '';
  pageIndex = 0;
  pageSize = 10;
  readonly pageSizeOptions = [10, 25, 50];
  /** Sorted by name until the user picks another column or direction. */
  sortActive: 'name' | 'status' | '' = 'name';
  sortDirection: SortDirection = 'asc';
  loading = true;
  /** Set when the list could not be loaded, so it is not shown as empty. */
  loadError = '';

  constructor(private snackBar: MatSnackBar) {}

  ngOnInit(): void {
    void this.loadTenants();
  }

  async loadTenants(): Promise<void> {
    this.loading = true;
    this.loadError = '';
    try {
      this.tenants = await tenantControllerGetTenants<true>().then((res) => res.data);
      this.applyFilters();
    } catch (error) {
      console.error('Error loading tenants:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load tenants');
    } finally {
      this.loading = false;
    }
  }

  /** Filters by the search, keeps the page within the results and picks the tenants to show. */
  applyFilters(): void {
    const term = this.search.trim().toLowerCase();
    this.filteredTenants = term
      ? this.tenants.filter((tenant) =>
          [tenant.id, tenant.name, tenant.description ?? ''].some((value) =>
            value.toLowerCase().includes(term)
          )
        )
      : [...this.tenants];
    this.sortTenants(this.filteredTenants);
    const lastPage = Math.max(0, Math.ceil(this.filteredTenants.length / this.pageSize) - 1);
    this.pageIndex = Math.min(this.pageIndex, lastPage);
    const start = this.pageIndex * this.pageSize;
    this.shownTenants = this.filteredTenants.slice(start, start + this.pageSize);
  }

  onSortChange(sort: Sort): void {
    this.sortActive = sort.direction ? (sort.active as 'name' | 'status') : '';
    this.sortDirection = sort.direction;
    this.applyFilters();
  }

  /** Sorts in place; numbers in names sort by value, so "Tenant 2" comes before "Tenant 10". */
  private sortTenants(tenants: TenantResponseDto[]): void {
    if (!this.sortActive || !this.sortDirection) return;
    const key = this.sortActive;
    const factor = this.sortDirection === 'asc' ? 1 : -1;
    const value = (tenant: TenantResponseDto) =>
      key === 'name' ? tenant.name || tenant.id : (tenant.status ?? '');
    tenants.sort(
      (a, b) =>
        factor *
        (value(a).localeCompare(value(b), undefined, { numeric: true, sensitivity: 'base' }) ||
          a.id.localeCompare(b.id, undefined, { numeric: true }))
    );
  }

  /** One of three tonal colours per tenant, the same on every visit. */
  avatarTone(tenant: TenantResponseDto): string {
    let hash = 0;
    for (const char of tenant.id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    return ['tone-primary', 'tone-secondary', 'tone-tertiary'][hash % 3];
  }

  /** A new search starts on the first page. */
  onSearchChange(): void {
    this.pageIndex = 0;
    this.applyFilters();
  }

  clearSearch(): void {
    this.search = '';
    this.onSearchChange();
  }

  onPageChange(event: PageEvent): void {
    this.pageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    this.applyFilters();
  }

  /** Changes the page size and keeps the first tenant of the current page in view. */
  setPageSize(size: number): void {
    this.pageIndex = Math.floor((this.pageIndex * this.pageSize) / size);
    this.pageSize = size;
    this.applyFilters();
  }

  /** The paginator shows only when the tenants do not fit on the smallest page. */
  get paginated(): boolean {
    return this.tenants.length > this.pageSizeOptions[0];
  }

  /** First letter of the tenant's name, or of its ID without a name, for its avatar. */
  initial(tenant: TenantResponseDto): string {
    return (tenant.name || tenant.id).charAt(0);
  }

  deleteTenant(tenant: TenantResponseDto): void {
    if (!confirm(`Delete tenant "${tenant.name}" and all its data? This cannot be undone.`)) {
      return;
    }
    tenantControllerDeleteTenant({ path: { id: tenant.id } }).then(
      () => {
        this.tenants = this.tenants.filter((t) => t.id !== tenant.id);
        this.applyFilters();
        this.snackBar.open('Tenant deleted successfully', 'Close', { duration: 3000 });
      },
      (error) => {
        console.error('Error deleting tenant:', error);
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete tenant'));
      }
    );
  }
}
