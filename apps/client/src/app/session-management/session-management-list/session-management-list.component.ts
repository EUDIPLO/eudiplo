import { SelectionModel } from '@angular/cdk/collections';
import { CommonModule } from '@angular/common';
import {
  Component,
  ViewChild,
  AfterViewInit,
  DestroyRef,
  OnInit,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { provideNativeDateAdapter } from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSort, MatSortModule, SortDirection } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Params, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { Session } from '@eudiplo/sdk-core';
import { from, merge, of as observableOf, Subject } from 'rxjs';
import { catchError, debounceTime, map, startWith, switchMap } from 'rxjs/operators';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { SessionManagementService, SessionQueryParams } from '../session-management.service';

// Define the SessionStatus type
export type SessionStatus = 'active' | 'fetched' | 'completed' | 'expired' | 'failed';

type SessionType = 'all' | 'issuance' | 'presentation';
type SortField = NonNullable<SessionQueryParams['sortBy']>;

/** Statuses of offers and requests a wallet has not finished yet. */
const PENDING_STATUSES: SessionStatus[] = ['active', 'fetched'];
const STATUSES = new Set<string>(['active', 'fetched', 'completed', 'expired', 'failed']);
const DEFAULT_PAGE_SIZE = 25;
const SORT_FIELDS = new Set<string>(['id', 'status', 'createdAt', 'updatedAt', 'requestId']);

/** Relative update windows, kept as is in the URL so a bookmark stays relative. */
const UPDATED_WITHIN = {
  '15m': { label: 'Last 15 minutes', ms: 15 * 60_000 },
  '1h': { label: 'Last hour', ms: 60 * 60_000 },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
} as const;
type UpdatedWithin = keyof typeof UPDATED_WITHIN;
/** `''` is any time, `custom` the date range of `updatedFrom` / `updatedTo`. */
type UpdatedFilter = '' | UpdatedWithin | 'custom';

/**
 * Stable verification failure codes. Wallets can report other codes (e.g.
 * OAuth errors), so the filter also accepts free text.
 */
const KNOWN_FAILURE_CODES = [
  'access_denied',
  'certificate_expired',
  'no_trust_chain_to_root',
  'signature_invalid',
  'trust_chain_not_trusted',
  'trust_list_unavailable',
  'verification_error',
  'x5c_missing',
];

interface ConfigOption {
  /** `issuance:<credential config id>` or `presentation:<presentation config id>` */
  value: string;
  label: string;
}

/** A local calendar day as `yyyy-mm-dd`, the format kept in the URL. */
function toDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDay(value: string | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

@Component({
  selector: 'app-session-management-list',
  imports: [
    MatTableModule,
    MatSortModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatDatepickerModule,
    MatAutocompleteModule,
    MatCardModule,
    MatTooltipModule,
    MatCheckboxModule,
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    RouterModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    MatPaginatorModule,
  ],
  providers: [provideNativeDateAdapter()],
  templateUrl: './session-management-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './session-management-list.component.scss',
})
export class SessionManagementListComponent implements OnInit, AfterViewInit {
  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;

  dataSource = new MatTableDataSource<Session>([]);
  filters = new FormGroup({
    q: new FormControl('', { nonNullable: true }),
    type: new FormControl<SessionType>('all', { nonNullable: true }),
    status: new FormControl<SessionStatus[]>([], { nonNullable: true }),
    config: new FormControl('', { nonNullable: true }),
    createdFrom: new FormControl<Date | null>(null),
    createdTo: new FormControl<Date | null>(null),
    updated: new FormControl<UpdatedFilter>('', { nonNullable: true }),
    updatedFrom: new FormControl<Date | null>(null),
    updatedTo: new FormControl<Date | null>(null),
    failureCode: new FormControl('', { nonNullable: true }),
  });
  selection = new SelectionModel<Session>(true, []);

  totalItems = 0;
  pageSize = DEFAULT_PAGE_SIZE;
  initialPageIndex = 0;
  initialSort: { active: string; direction: SortDirection } = { active: '', direction: '' };
  pageSizeOptions = [10, 25, 50, 100];
  isLoadingResults = true;

  displayedColumns: (keyof Session | 'select' | 'type' | 'actions')[] = [
    'select',
    'id',
    'type',
    'status',
    'reference',
    'createdAt',
    'updatedAt',
    'actions',
  ];

  typeOptions = [
    { value: 'all', label: 'All Sessions' },
    { value: 'issuance', label: 'Issuance Sessions' },
    { value: 'presentation', label: 'Presentation Sessions' },
  ];

  statusOptions = [
    { value: 'active', label: 'Active' },
    { value: 'fetched', label: 'Fetched' },
    { value: 'completed', label: 'Completed' },
    { value: 'expired', label: 'Expired' },
    { value: 'failed', label: 'Failed' },
  ];

  updatedOptions = Object.entries(UPDATED_WITHIN).map(([value, { label }]) => ({ value, label }));

  failureCodeOptions = KNOWN_FAILURE_CODES;

  issuanceConfigOptions: ConfigOption[] = [];
  presentationConfigOptions: ConfigOption[] = [];

  deletingSelected = false;

  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly credentialConfigService = inject(CredentialConfigService);
  private readonly presentationManagementService = inject(PresentationManagementService);
  private readonly sessionManagementService = inject(SessionManagementService);
  private readonly refresh$ = new Subject<void>();

  ngOnInit(): void {
    this.restoreFilters(this.route.snapshot.queryParamMap);
    this.restoreTableState(this.route.snapshot.queryParams);
    void this.loadConfigOptions();
  }

  ngAfterViewInit(): void {
    // Typing in the search box should not send a request per keystroke.
    const filterChange = this.filters.valueChanges.pipe(
      debounceTime(300),
      map(() => undefined)
    );

    // Reset to page 1 when sort or filters change
    merge(this.sort.sortChange, filterChange)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => (this.paginator.pageIndex = 0));

    // Reload data on any triggering event (sort, page change, filter change, manual refresh)
    merge(this.sort.sortChange, this.paginator.page, filterChange, this.refresh$)
      .pipe(
        startWith({}),
        switchMap(() => {
          this.isLoadingResults = true;
          const query = this.buildQuery();
          this.storeInUrl(query);
          return from(this.sessionManagementService.getAllSessions(query)).pipe(
            catchError(() => observableOf(null))
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.isLoadingResults = false;
        if (result) {
          this.dataSource.data = result.items;
          this.totalItems = result.total;
          this.selection.clear();
        }
      });
  }

  refreshSessions(): void {
    this.refresh$.next();
  }

  /** Only offers and requests the wallet has not finished yet. */
  showPending(): void {
    this.filters.controls.status.setValue([...PENDING_STATUSES]);
  }

  isPendingSelected(): boolean {
    const selected = this.filters.controls.status.value;
    return (
      selected.length === PENDING_STATUSES.length &&
      PENDING_STATUSES.every((status) => selected.includes(status))
    );
  }

  hasActiveFilters(): boolean {
    const { q, type, status, config, createdFrom, createdTo, updated, failureCode } =
      this.filters.getRawValue();
    return !!(
      q.trim() ||
      type !== 'all' ||
      status.length ||
      config ||
      createdFrom ||
      createdTo ||
      updated ||
      failureCode.trim()
    );
  }

  /** Failure code suggestions matching what has been typed so far. */
  matchingFailureCodes(): string[] {
    const typed = this.filters.controls.failureCode.value.trim().toLowerCase();
    return this.failureCodeOptions.filter((code) => code.includes(typed));
  }

  clearFilters(): void {
    this.filters.reset();
  }

  /** The filters as `GET /session` query, built from the form, sort and paginator. */
  private buildQuery(): SessionQueryParams {
    const { q, type, status, config, createdFrom, createdTo, failureCode } =
      this.filters.getRawValue();
    const [configKind, ...configId] = config.split(':');
    // Map the 'type' column sort to its underlying DB field 'requestId'
    const sortActive = this.sort.active === 'type' ? 'requestId' : this.sort.active;
    return {
      page: this.paginator.pageIndex + 1,
      pageSize: this.paginator.pageSize,
      ...(type !== 'all' ? { type } : {}),
      ...(status.length ? { status } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(configKind === 'issuance' ? { credentialConfigurationId: configId.join(':') } : {}),
      ...(configKind === 'presentation' ? { requestId: configId.join(':') } : {}),
      ...(createdFrom ? { createdFrom: createdFrom.toISOString() } : {}),
      ...(createdTo ? { createdTo: endOfDay(createdTo).toISOString() } : {}),
      ...this.updatedRange(),
      ...(failureCode.trim() ? { failureCode: failureCode.trim() } : {}),
      ...(sortActive && this.sort.direction
        ? { sortBy: sortActive as SortField, sortOrder: this.sort.direction }
        : {}),
    };
  }

  /** The update range: relative to now for a preset, whole days for a custom range. */
  private updatedRange(): Pick<SessionQueryParams, 'updatedFrom' | 'updatedTo'> {
    const { updated, updatedFrom, updatedTo } = this.filters.getRawValue();
    if (updated === 'custom')
      return {
        ...(updatedFrom ? { updatedFrom: updatedFrom.toISOString() } : {}),
        ...(updatedTo ? { updatedTo: endOfDay(updatedTo).toISOString() } : {}),
      };
    if (updated)
      return { updatedFrom: new Date(Date.now() - UPDATED_WITHIN[updated].ms).toISOString() };
    return {};
  }

  /** Keep the view in the URL so it can be bookmarked or shared. */
  private storeInUrl(query: SessionQueryParams): void {
    const { createdFrom, createdTo, updated, updatedFrom, updatedTo } = this.filters.getRawValue();
    const custom = updated === 'custom';
    const queryParams: Params = {
      q: query.q ?? null,
      type: query.type ?? null,
      status: query.status ?? null,
      credentialConfigurationId: query.credentialConfigurationId ?? null,
      requestId: query.requestId ?? null,
      createdFrom: createdFrom ? toDay(createdFrom) : null,
      createdTo: createdTo ? toDay(createdTo) : null,
      updatedWithin: updated && !custom ? updated : null,
      updatedFrom: custom && updatedFrom ? toDay(updatedFrom) : null,
      updatedTo: custom && updatedTo ? toDay(updatedTo) : null,
      failureCode: query.failureCode ?? null,
      page: query.page && query.page > 1 ? query.page : null,
      pageSize: query.pageSize !== DEFAULT_PAGE_SIZE ? query.pageSize : null,
      sortBy: query.sortBy ?? null,
      sortOrder: query.sortOrder ?? null,
    };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      replaceUrl: true,
    });
  }

  private restoreFilters(params: {
    get(name: string): string | null;
    getAll(name: string): string[];
  }): void {
    const type = params.get('type');
    const credentialConfigurationId = params.get('credentialConfigurationId');
    const requestId = params.get('requestId');
    const updatedWithin = params.get('updatedWithin');
    const updatedFrom = fromDay(params.get('updatedFrom'));
    const updatedTo = fromDay(params.get('updatedTo'));
    this.filters.setValue(
      {
        q: params.get('q') ?? '',
        type: type === 'issuance' || type === 'presentation' ? type : 'all',
        status: params
          .getAll('status')
          .filter((status): status is SessionStatus => STATUSES.has(status)),
        config: this.restoreConfig(credentialConfigurationId, requestId),
        createdFrom: fromDay(params.get('createdFrom')),
        createdTo: fromDay(params.get('createdTo')),
        updated: this.restoreUpdated(updatedWithin, !!(updatedFrom || updatedTo)),
        updatedFrom,
        updatedTo,
        failureCode: params.get('failureCode') ?? '',
      },
      { emitEvent: false }
    );
  }

  private restoreConfig(
    credentialConfigurationId: string | null,
    requestId: string | null
  ): string {
    if (credentialConfigurationId) return `issuance:${credentialConfigurationId}`;
    if (requestId) return `presentation:${requestId}`;
    return '';
  }

  /** A known preset wins over a custom range; without either, any time. */
  private restoreUpdated(updatedWithin: string | null, hasRange: boolean): UpdatedFilter {
    if (updatedWithin && updatedWithin in UPDATED_WITHIN) return updatedWithin as UpdatedWithin;
    return hasRange ? 'custom' : '';
  }

  /** Initial sort and page, bound to `matSort` and the paginator in the template. */
  private restoreTableState(params: Params): void {
    const page = Number(params['page']);
    const pageSize = Number(params['pageSize']);
    if (this.pageSizeOptions.includes(pageSize)) this.pageSize = pageSize;
    if (Number.isInteger(page) && page > 1) this.initialPageIndex = page - 1;
    const sortBy = params['sortBy'] as SortField;
    const sortOrder = params['sortOrder'];
    if (SORT_FIELDS.has(sortBy) && (sortOrder === 'asc' || sortOrder === 'desc')) {
      this.initialSort = { active: sortBy === 'requestId' ? 'type' : sortBy, direction: sortOrder };
    }
  }

  /** Fill the configuration selector with the tenant's configurations. */
  private async loadConfigOptions(): Promise<void> {
    const [credentials, presentations] = await Promise.all([
      this.credentialConfigService.loadConfigurations().catch(() => []),
      this.presentationManagementService.loadConfigurations().catch(() => []),
    ]);
    this.issuanceConfigOptions = credentials.map((config) => ({
      value: `issuance:${config.id}`,
      label: config.id,
    }));
    this.presentationConfigOptions = presentations.map((config) => ({
      value: `presentation:${config.id}`,
      label: config.description ? `${config.id} (${config.description})` : config.id,
    }));
  }

  // Selection methods
  isAllSelected() {
    const numSelected = this.selection.selected.length;
    const numRows = this.dataSource.data.length;
    return numSelected === numRows;
  }

  masterToggle() {
    if (this.isAllSelected()) {
      this.selection.clear();
      return;
    }

    this.selection.select(...this.dataSource.data);
  }

  checkboxLabel(row?: Session): string {
    if (!row) {
      return `${this.isAllSelected() ? 'deselect' : 'select'} all`;
    }
    return `${this.selection.isSelected(row) ? 'deselect' : 'select'} row ${row.id}`;
  }

  async deleteSelectedSessions() {
    if (this.selection.selected.length === 0) {
      return;
    }

    const selectedSessions = [...this.selection.selected]; // Create a copy
    const selectedCount = selectedSessions.length;

    this.deletingSelected = true;
    try {
      // Delete each selected session
      const deletePromises = selectedSessions.map((session) =>
        this.sessionManagementService.deleteSession(session.id)
      );

      await Promise.all(deletePromises);

      // Clear selection and refresh the list
      this.selection.clear();
      await this.refreshSessions();

      // You can add a snackbar notification here if you have it set up
      console.log(`Successfully deleted ${selectedCount} sessions`);
    } catch (error) {
      console.error('Error deleting sessions:', error);
      // You can add error notification here
    } finally {
      this.deletingSelected = false;
    }
  }

  clearSelection() {
    this.selection.clear();
  }

  getSessionStatus(session: Session): SessionStatus {
    return session.status as SessionStatus;
  }

  getStatusDisplay(status: any): string {
    return this.sessionManagementService.getStatusDisplay(status);
  }

  getStatusClass(status: any): string {
    return 'status-' + (status as SessionStatus);
  }
}
