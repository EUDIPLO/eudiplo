import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import type { ErrorStateMatcher } from '@angular/material/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, ParamMap, Params, Router } from '@angular/router';
import type { AuditLogResponseDto, AuditLogRetentionResponseDto } from '@eudiplo/sdk-core';
import { Subject, from, merge, of } from 'rxjs';
import { catchError, debounceTime, map, startWith, switchMap } from 'rxjs/operators';

import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { getApiErrorMessage } from '../../utils/error-message';
import {
  ACTION_TYPES,
  ACTOR_LABELS,
  type AuditActionType,
  type AuditActorType,
  type AuditObjectType,
  OBJECT_LABELS,
  OBJECT_TYPES,
  actionLabel,
  detailsOf,
  objectTypeOf,
} from './activity-log-labels';
import { type ActivityLogQuery, ActivityLogService } from './activity-log.service';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/** Relative windows, kept as is in the URL so a bookmark stays relative. */
const WITHIN = {
  '1h': { label: 'Last hour', ms: 60 * 60_000 },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
} as const;
type Within = keyof typeof WITHIN;
/** `''` is any time, `custom` the range of `from` / `to`. */
type TimeFilter = '' | Within | 'custom';

/** Value of a `datetime-local` input: a local time to the minute. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** The longest id the backend accepts as a filter. */
const MAX_ID_LENGTH = 255;

/** An id the backend accepts: it trims before it checks the length. */
function idLength(control: AbstractControl): ValidationErrors | null {
  const length = String(control.value ?? '').trim().length;
  return length > MAX_ID_LENGTH ? { maxlength: { requiredLength: MAX_ID_LENGTH, length } } : null;
}

/** On `to`: a custom range must not end before it starts. */
function endsAfterStart(control: AbstractControl): ValidationErrors | null {
  const time = control.parent?.get('time')?.value;
  const from = control.parent?.get('from')?.value;
  const to = control.value;
  const reversed =
    time === 'custom' &&
    LOCAL_DATE_TIME.test(from) &&
    LOCAL_DATE_TIME.test(to) &&
    new Date(from) > new Date(to);
  return reversed ? { reversed: true } : null;
}

interface ActionGroup {
  objectType: AuditObjectType;
  label: string;
  actions: { value: AuditActionType; label: string }[];
}

@Component({
  selector: 'app-admin-activity-logs',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatTableModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatPaginatorModule,
    MatSelectModule,
    MatFormFieldModule,
    LoadErrorComponent,
  ],
  templateUrl: './admin-activity-logs.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './admin-activity-logs.component.scss',
})
export class AdminActivityLogsComponent implements OnInit {
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;

  readonly filters = new FormGroup({
    objectType: new FormControl<AuditObjectType | ''>('', { nonNullable: true }),
    actionType: new FormControl<AuditActionType[]>([], { nonNullable: true }),
    actorType: new FormControl<AuditActorType | ''>('', { nonNullable: true }),
    actorId: new FormControl('', {
      nonNullable: true,
      validators: idLength,
    }),
    requestId: new FormControl('', {
      nonNullable: true,
      validators: idLength,
    }),
    time: new FormControl<TimeFilter>('', { nonNullable: true }),
    from: new FormControl('', { nonNullable: true }),
    to: new FormControl('', { nonNullable: true, validators: endsAfterStart }),
  });

  /** Filters apply as the user types, so their errors show at once, not on blur. */
  readonly showErrorsAtOnce: ErrorStateMatcher = {
    isErrorState: (control) => !!control?.invalid,
  };
  readonly maxIdLength = MAX_ID_LENGTH;

  readonly objectOptions = OBJECT_TYPES.map((value) => ({ value, label: OBJECT_LABELS[value] }));
  readonly actorOptions = Object.entries(ACTOR_LABELS).map(([value, label]) => ({ value, label }));
  readonly timeOptions = Object.entries(WITHIN).map(([value, { label }]) => ({ value, label }));
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  readonly displayedColumns = ['timestamp', 'action', 'actor', 'details', 'actions'];
  readonly actionLabel = actionLabel;
  readonly detailsOf = detailsOf;

  logs: AuditLogResponseDto[] = [];
  total = 0;
  pageIndex = 0;
  pageSize = DEFAULT_PAGE_SIZE;
  loading = true;
  /** Set when the entries could not be loaded, so the page does not claim there are none. */
  loadError = '';
  retention?: AuditLogRetentionResponseDto;

  private readonly service = inject(ActivityLogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reload$ = new Subject<void>();
  private retrying = false;

  ngOnInit(): void {
    this.restore(this.route.snapshot.queryParamMap);

    // An action that does not belong to the chosen object would match nothing.
    this.filters.controls.objectType.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((objectType) => {
        if (!objectType) return;
        const actions = this.filters.controls.actionType.value;
        const kept = actions.filter((action) => objectTypeOf(action) === objectType);
        if (kept.length !== actions.length) this.filters.controls.actionType.setValue(kept);
      });

    // The range check on `to` also depends on these.
    merge(this.filters.controls.time.valueChanges, this.filters.controls.from.valueChanges)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.filters.controls.to.updateValueAndValidity({ emitEvent: false }));
    this.filters.controls.to.updateValueAndValidity({ emitEvent: false });

    // Typing in a text field should not send a request per keystroke.
    const filterChange = this.filters.valueChanges.pipe(
      debounceTime(300),
      map(() => {
        this.pageIndex = 0;
      })
    );

    merge(filterChange, this.reload$)
      .pipe(
        startWith(undefined),
        switchMap(() => {
          this.storeInUrl();
          // The fields say what to fix; the backend would only refuse the query.
          if (this.filters.invalid) return of(null);
          this.loading = true;
          this.loadError = '';
          const query = this.buildQuery();
          return from(this.service.search(query)).pipe(
            catchError((error: unknown) => {
              this.loadError = getApiErrorMessage(error, 'Failed to load activity logs');
              // Rows of an earlier query no longer match what the filters ask for.
              this.logs = [];
              this.total = 0;
              return of(null);
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((page) => {
        // A bookmark or Refresh can point past the last page, for example
        // after the nightly pruning: show the last page instead.
        if (page && page.items.length === 0 && page.total > 0 && this.pageIndex > 0) {
          this.pageIndex = Math.max(0, page.totalPages - 1);
          this.reload$.next();
          return;
        }
        this.loading = false;
        if (page) {
          this.logs = page.items;
          this.total = page.total;
          if (this.retrying) {
            focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
          }
        }
        this.retrying = false;
      });

    // Without the retention the page still works; it just cannot explain gaps.
    this.service
      .retention()
      .then((retention) => (this.retention = retention))
      .catch(() => undefined);
  }

  refresh(): void {
    this.reload$.next();
  }

  retry(): void {
    this.retrying = true;
    this.reload$.next();
  }

  onPageChange(event: PageEvent): void {
    this.pageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    this.reload$.next();
  }

  clearFilters(): void {
    this.filters.reset();
    // Clear Filters removes itself, and with it the focus.
    focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
  }

  hasActiveFilters(): boolean {
    const { objectType, actionType, actorType, actorId, requestId, time } =
      this.filters.getRawValue();
    return !!(
      objectType ||
      actionType.length ||
      actorType ||
      actorId.trim() ||
      requestId.trim() ||
      time
    );
  }

  /** Whether the custom range ends before it starts. */
  rangeReversed(): boolean {
    return this.filters.controls.to.hasError('reversed');
  }

  /** The actions to choose from, grouped by object, limited to the chosen object. */
  actionGroups(): ActionGroup[] {
    const chosen = this.filters.controls.objectType.value;
    return OBJECT_TYPES.filter((objectType) => !chosen || objectType === chosen).map(
      (objectType) => ({
        objectType,
        label: OBJECT_LABELS[objectType],
        actions: ACTION_TYPES.filter((action) => objectTypeOf(action) === objectType).map(
          (value) => ({ value, label: actionLabel(value) })
        ),
      })
    );
  }

  /** A sentence about the retention, or '' while it is unknown. */
  retentionNote(): string {
    if (!this.retention) return '';
    const { retentionDays, maxEntriesPerTenant } = this.retention;
    const limits = [
      ...(retentionDays > 0 ? [`entries older than ${retentionDays} days`] : []),
      ...(maxEntriesPerTenant > 0
        ? [`all but the newest ${maxEntriesPerTenant.toLocaleString()} entries`]
        : []),
    ];
    if (limits.length === 0) return 'Entries are kept until the operator sets a retention.';
    return `The operator's retention settings delete ${limits.join(' and ')} every night.`;
  }

  actorLabel(log: AuditLogResponseDto): string {
    const display = log.actorDisplay || log.actorId || 'Unknown';
    return `${display} (${ACTOR_LABELS[log.actorType] ?? log.actorType})`;
  }

  /**
   * The id the Actor ID filter matches, when the label shows something else:
   * for a user, the label is the client they signed in with.
   */
  hiddenActorId(log: AuditLogResponseDto): string {
    return log.actorId && log.actorDisplay && log.actorId !== log.actorDisplay ? log.actorId : '';
  }

  copyLabel(log: AuditLogResponseDto): string {
    return `Copy log entry ${actionLabel(log.actionType)} of ${this.formatTimestamp(log.timestamp)}`;
  }

  formatTimestamp(timestamp?: string): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
  }

  async copyLog(log: AuditLogResponseDto): Promise<void> {
    await copyToClipboard(this.snackBar, JSON.stringify(log, null, 2), 'Copied to clipboard');
  }

  /** The filters as `GET /admin/audit-logs/search` query. */
  private buildQuery(): ActivityLogQuery {
    const { objectType, actionType, actorType, actorId, requestId } = this.filters.getRawValue();
    return {
      page: this.pageIndex + 1,
      pageSize: this.pageSize,
      ...(objectType ? { objectType } : {}),
      ...(actionType.length ? { actionType } : {}),
      ...(actorType ? { actorType } : {}),
      ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
      ...(requestId.trim() ? { requestId: requestId.trim() } : {}),
      ...this.timeRange(),
    };
  }

  /** Relative to now for a preset, the entered local times for a custom range. */
  private timeRange(): Pick<ActivityLogQuery, 'from' | 'to'> {
    const { time, from, to } = this.filters.getRawValue();
    if (time === 'custom') {
      return {
        ...(LOCAL_DATE_TIME.test(from) ? { from: new Date(from).toISOString() } : {}),
        // A minute is the finest the input offers; include all of it.
        ...(LOCAL_DATE_TIME.test(to)
          ? { to: new Date(new Date(to).getTime() + 59_999).toISOString() }
          : {}),
      };
    }
    if (time) return { from: new Date(Date.now() - WITHIN[time].ms).toISOString() };
    return {};
  }

  /** Keep the view in the URL so it can be bookmarked or shared. */
  private storeInUrl(): void {
    const { objectType, actionType, actorType, actorId, requestId, time, from, to } =
      this.filters.getRawValue();
    const custom = time === 'custom';
    const queryParams: Params = {
      objectType: objectType || null,
      actionType: actionType.length ? actionType : null,
      actorType: actorType || null,
      actorId: actorId.trim() || null,
      requestId: requestId.trim() || null,
      within: time && !custom ? time : null,
      from: custom && from ? from : null,
      to: custom && to ? to : null,
      page: this.pageIndex > 0 ? this.pageIndex + 1 : null,
      pageSize: this.pageSize !== DEFAULT_PAGE_SIZE ? this.pageSize : null,
    };
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  private restore(params: ParamMap): void {
    const objectType = params.get('objectType');
    const actorType = params.get('actorType');
    const within = params.get('within');
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    const validFrom = LOCAL_DATE_TIME.test(from) ? from : '';
    const validTo = LOCAL_DATE_TIME.test(to) ? to : '';
    let time: TimeFilter = '';
    if (within && within in WITHIN) time = within as Within;
    else if (validFrom || validTo) time = 'custom';

    this.filters.setValue(
      {
        objectType: OBJECT_TYPES.includes(objectType as AuditObjectType)
          ? (objectType as AuditObjectType)
          : '',
        actionType: params
          .getAll('actionType')
          .filter((action): action is AuditActionType =>
            ACTION_TYPES.includes(action as AuditActionType)
          ),
        actorType: actorType && actorType in ACTOR_LABELS ? (actorType as AuditActorType) : '',
        actorId: params.get('actorId') ?? '',
        requestId: params.get('requestId') ?? '',
        time,
        from: validFrom,
        to: validTo,
      },
      { emitEvent: false }
    );

    const page = Number(params.get('page'));
    const pageSize = Number(params.get('pageSize'));
    if (PAGE_SIZE_OPTIONS.includes(pageSize)) this.pageSize = pageSize;
    if (Number.isInteger(page) && page > 1) this.pageIndex = page - 1;
  }
}
