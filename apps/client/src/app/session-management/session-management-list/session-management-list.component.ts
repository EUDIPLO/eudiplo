import { SelectionModel } from '@angular/cdk/collections';
import { CommonModule } from '@angular/common';
import {
  Component,
  ViewChild,
  AfterViewInit,
  DestroyRef,
  ElementRef,
  Injector,
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
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSort, MatSortModule, SortDirection } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Params, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { fromDay, toDay } from '../../utils/local-day';
import { Session } from '@eudiplo/sdk-core';
import { from, merge, of as observableOf, Subject } from 'rxjs';
import { catchError, debounceTime, map, startWith, switchMap } from 'rxjs/operators';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import {
  CancelSessionDialogComponent,
  CancelSessionDialogData,
  CancelSessionDialogResult,
} from '../cancel-session-dialog/cancel-session-dialog.component';
import {
  isCancelConflict,
  isCancellable,
  isPresentationSession,
  SessionManagementService,
  SessionQueryParams,
} from '../session-management.service';
import { maySessionChange, SESSION_CHANGER_ROLES } from '../session-roles';
import { JwtService } from '../../services/jwt.service';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { openErrorSnackBar } from '../../utils/error-snackbar';

// Define the SessionStatus type
export type SessionStatus = 'active' | 'fetched' | 'completed' | 'expired' | 'failed' | 'cancelled';

type SessionType = 'all' | 'issuance' | 'presentation';
type SortField = NonNullable<SessionQueryParams['sortBy']>;

/** Statuses of offers and requests a wallet has not finished yet. */
const PENDING_STATUSES: SessionStatus[] = ['active', 'fetched'];
const STATUSES = new Set<string>([
  'active',
  'fetched',
  'completed',
  'expired',
  'failed',
  'cancelled',
]);
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
  'credential_deleted',
  'credential_failure',
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
    LoadErrorComponent,
  ],
  providers: [provideNativeDateAdapter()],
  templateUrl: './session-management-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './session-management-list.component.scss',
})
export class SessionManagementListComponent implements OnInit, AfterViewInit {
  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;
  /** Takes the focus when the bulk actions go away with the selection they acted on. */
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;

  dataSource = new MatTableDataSource<Session>([]);
  readonly isPresentationSession = isPresentationSession;
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
  /** Set when the sessions could not be loaded, so the page does not claim there are none. */
  loadError = '';

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
    { value: 'cancelled', label: 'Cancelled' },
  ];

  updatedOptions = Object.entries(UPDATED_WITHIN).map(([value, { label }]) => ({ value, label }));

  failureCodeOptions = KNOWN_FAILURE_CODES;

  issuanceConfigOptions: ConfigOption[] = [];
  presentationConfigOptions: ConfigOption[] = [];

  deletingSelected = false;
  cancellingSelected = false;

  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly credentialConfigService = inject(CredentialConfigService);
  private readonly presentationManagementService = inject(PresentationManagementService);
  private readonly sessionManagementService = inject(SessionManagementService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly jwtService = inject(JwtService);
  private readonly refresh$ = new Subject<void>();

  ngOnInit(): void {
    // sessions:read alone reads sessions but cancels and deletes none.
    if (!this.jwtService.hasRole(SESSION_CHANGER_ROLES)) {
      this.displayedColumns = this.displayedColumns.filter((column) => column !== 'select');
    }
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
          this.loadError = '';
          const query = this.buildQuery();
          this.storeInUrl(query);
          return from(this.sessionManagementService.getAllSessions(query)).pipe(
            catchError((error: unknown) => {
              console.error('Error loading sessions:', error);
              this.loadError = getApiErrorMessage(error, 'Failed to load sessions');
              // Rows of an earlier query no longer match what the filters ask for,
              // and bulk actions must not act on rows the user no longer sees.
              this.dataSource.data = [];
              this.totalItems = 0;
              this.selection.clear();
              return observableOf(null);
            })
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

  readonly canOfferIssuance = this.jwtService.hasRole('issuance:offer');
  readonly canRequestPresentation = this.jwtService.hasRole('presentation:request');
  readonly readOnlyRowHint = 'Your roles let you read this session but not cancel or delete it';
  /**
   * Like the backend, sessions:read lists the sessions a wallet can still use
   * only for the types the caller creates or manages.
   */
  readonly hidesOpenSessions =
    this.jwtService.hasRole('sessions:read') &&
    !(
      maySessionChange((roles) => this.jwtService.hasRole(roles), { requestId: undefined }) &&
      maySessionChange((roles) => this.jwtService.hasRole(roles), { requestId: 'presentation' })
    );

  /** Whether the caller may cancel and delete this session, not only read it. */
  canChange(session: Session): boolean {
    return maySessionChange((roles) => this.jwtService.hasRole(roles), session);
  }

  /** Rows of the page the caller may cancel and delete. */
  private get changeableRows(): Session[] {
    return this.dataSource.data.filter((session) => this.canChange(session));
  }

  get hasChangeableRows(): boolean {
    return this.changeableRows.length > 0;
  }

  // Selection methods
  isAllSelected() {
    const numRows = this.changeableRows.length;
    return numRows > 0 && this.selection.selected.length === numRows;
  }

  masterToggle() {
    if (this.isAllSelected()) {
      this.selection.clear();
      return;
    }

    this.selection.select(...this.changeableRows);
  }

  checkboxLabel(row?: Session): string {
    if (!row) {
      return `${this.isAllSelected() ? 'deselect' : 'select'} all`;
    }
    if (!this.canChange(row)) {
      return `row ${row.id}: ${this.readOnlyRowHint}`;
    }
    return `${this.selection.isSelected(row) ? 'deselect' : 'select'} row ${row.id}`;
  }

  async deleteSelectedSessions() {
    // `disabledInteractive` keeps Delete Selected clickable while it looks disabled.
    if (this.runningBulkAction) return;
    const sessions = [...this.selection.selected];
    const count = sessions.length;
    if (
      count === 0 ||
      !confirm(
        `Delete ${count} ${count === 1 ? 'session' : 'sessions'}? Credentials issued in them ` +
          'keep their status. This cannot be undone.'
      )
    ) {
      return;
    }

    this.deletingSelected = true;
    try {
      const outcomes = await Promise.allSettled(
        sessions.map((session) => this.sessionManagementService.deleteSession(session.id))
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      if (rejected.length) {
        console.error('Error deleting sessions:', rejected);
        openErrorSnackBar(
          this.snackBar,
          `Deleted ${count - rejected.length} of ${count} sessions; ` +
            getApiErrorMessage(rejected[0].reason, `${rejected.length} failed`)
        );
      } else {
        this.snackBar.open(`Deleted ${count} ${count === 1 ? 'session' : 'sessions'}`, 'Close', {
          duration: 3000,
        });
      }
      this.selection.clear();
      this.focusHeadingIfLost();
      this.refreshSessions();
    } finally {
      this.deletingSelected = false;
    }
  }

  /** Selected sessions a wallet has neither redeemed nor finished, the only ones that can be cancelled. */
  get cancellableSelected(): Session[] {
    return this.selection.selected.filter(isCancellable);
  }

  /**
   * The bulk action that is running, if any. Both bulk actions wait for it, so
   * a cancellation and a delete never work on the same selection at once.
   */
  get runningBulkAction(): string {
    if (this.cancellingSelected) return 'Cancelling the selected sessions…';
    if (this.deletingSelected) return 'Deleting the selected sessions…';
    return '';
  }

  /** Cancel Selected stays focusable while it cannot be used, so its tooltip says why. */
  get cancelSelectedTooltip(): string {
    if (this.runningBulkAction) return this.runningBulkAction;
    if (this.cancellableSelected.length === 0) {
      return 'None of the selected sessions can be cancelled: a wallet has redeemed them or they have ended';
    }
    return 'Cancel the selected offers a wallet has not redeemed yet, so it can no longer use them';
  }

  async cancelSelectedSessions() {
    // `disabledInteractive` keeps Cancel Selected clickable while it looks disabled.
    if (this.runningBulkAction) return;
    const sessions = this.cancellableSelected;
    if (sessions.length === 0) {
      return;
    }

    const result = await new Promise<CancelSessionDialogResult | undefined>((resolve) =>
      this.dialog
        .open<CancelSessionDialogComponent, CancelSessionDialogData, CancelSessionDialogResult>(
          CancelSessionDialogComponent,
          { data: { count: sessions.length }, width: '480px' }
        )
        .afterClosed()
        .subscribe(resolve)
    );
    if (!result) {
      return;
    }

    this.cancellingSelected = true;
    try {
      // A session a wallet redeemed or finished in the meantime is rejected (409).
      const outcomes = await Promise.allSettled(
        sessions.map((session) =>
          this.sessionManagementService.cancelSession(session.id, result.reason)
        )
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      const conflicts = rejected.filter((outcome) => isCancelConflict(outcome.reason)).length;
      const errors = rejected.filter((outcome) => !isCancelConflict(outcome.reason));
      if (rejected.length) {
        openErrorSnackBar(
          this.snackBar,
          [
            `Cancelled ${sessions.length - rejected.length} of ${sessions.length} sessions`,
            ...(conflicts ? [`${conflicts} no longer pending`] : []),
            ...(errors.length
              ? [getApiErrorMessage(errors[0].reason, `${errors.length} failed`)]
              : []),
          ].join('; ')
        );
      } else {
        this.snackBar.open(
          `Cancelled ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`,
          'Close',
          { duration: 4000 }
        );
      }
      this.selection.clear();
      this.focusHeadingIfLost();
      await this.refreshSessions();
    } finally {
      this.cancellingSelected = false;
    }
  }

  /** The bulk actions go away with the selection, and with them the focused button. */
  private focusHeadingIfLost(): void {
    focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
  }

  clearSelection() {
    this.selection.clear();
    this.focusHeadingIfLost();
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
