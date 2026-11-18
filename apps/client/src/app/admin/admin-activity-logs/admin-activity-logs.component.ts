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
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { type MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import type { ErrorStateMatcher } from '@angular/material/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { ActivatedRoute, ParamMap, Params, Router } from '@angular/router';
import type { AuditLogResponseDto, AuditLogRetentionResponseDto } from '@eudiplo/sdk-core';
import { Subject, from, merge, of } from 'rxjs';
import { catchError, debounceTime, map, startWith, switchMap } from 'rxjs/operators';

import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import {
  ACTION_TYPES,
  ACTOR_LABELS,
  type AuditActionType,
  type AuditActorType,
  type AuditObjectType,
  type ActionDescription,
  OBJECT_TYPES,
  describeAction,
  objectTypeOf,
  titleCase,
} from './activity-log-labels';
import { type ActivityLogQuery, ActivityLogService } from './activity-log.service';

/** Entries of one day, newest first. */
interface DayGroup {
  day: string;
  label: string;
  logs: AuditLogResponseDto[];
}

/** One changed field of an entry, with its value before and after the change. */
interface FieldChange {
  field: string;
  before?: string;
  after?: string;
}

interface ActionGroup {
  objectType: AuditObjectType;
  label: string;
  actions: { value: AuditActionType; label: string }[];
}

const actorIcons: Record<AuditLogResponseDto['actorType'], string> = {
  user: 'person',
  client: 'key',
  system: 'settings',
};

/** A logged value for display: strings as they are, anything else as compact JSON. */
function display(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The day of a timestamp in local time, as YYYY-MM-DD, for grouping. */
function localDay(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
/** The longest search text or id the backend accepts. */
const MAX_TEXT_LENGTH = 255;

/** Text the backend accepts: it trims before it checks the length. */
function textLength(control: AbstractControl): ValidationErrors | null {
  const length = String(control.value ?? '').trim().length;
  return length > MAX_TEXT_LENGTH
    ? { maxlength: { requiredLength: MAX_TEXT_LENGTH, length } }
    : null;
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

@Component({
  selector: 'app-admin-activity-logs',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    LoadErrorComponent,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatPaginatorModule,
  ],
  templateUrl: './admin-activity-logs.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './admin-activity-logs.component.scss',
})
export class AdminActivityLogsComponent implements OnInit {
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;
  @ViewChild('searchInput') private readonly searchInput?: ElementRef<HTMLInputElement>;

  readonly filters = new FormGroup({
    q: new FormControl('', { nonNullable: true, validators: textLength }),
    objectType: new FormControl<AuditObjectType | ''>('', { nonNullable: true }),
    actionType: new FormControl<AuditActionType[]>([], { nonNullable: true }),
    actorType: new FormControl<AuditActorType | ''>('', { nonNullable: true }),
    actorId: new FormControl('', { nonNullable: true, validators: textLength }),
    requestId: new FormControl('', { nonNullable: true, validators: textLength }),
    time: new FormControl<TimeFilter>('', { nonNullable: true }),
    from: new FormControl('', { nonNullable: true }),
    to: new FormControl('', { nonNullable: true, validators: endsAfterStart }),
  });

  /** Filters apply as the user types, so their errors show at once, not on blur. */
  readonly showErrorsAtOnce: ErrorStateMatcher = {
    isErrorState: (control) => !!control?.invalid,
  };
  readonly maxTextLength = MAX_TEXT_LENGTH;
  readonly objectTypes = OBJECT_TYPES.map((value) => ({ value, label: titleCase(value) }));
  readonly actorOptions = Object.entries(ACTOR_LABELS).map(([value, label]) => ({ value, label }));
  readonly timeOptions = Object.entries(WITHIN).map(([value, { label }]) => ({ value, label }));
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;

  /** The entries of the current page. */
  logs: AuditLogResponseDto[] = [];
  /** The entries of the current page, by day. */
  dayGroups: DayGroup[] = [];
  /** Entries that match the filters, on all pages. */
  total = 0;
  pageIndex = 0;
  pageSize = DEFAULT_PAGE_SIZE;
  loading = true;
  /** Whether a page has loaded once; until then the page shows no filters. */
  loaded = false;
  /**
   * Whether the page on screen was asked for with filters. Decides between
   * "No activity yet" and "No activity matches", so clearing a filter does
   * not show the empty log before the unfiltered page has loaded.
   */
  loadedFiltered = false;
  /** Set when the entries could not be loaded, so the page does not claim there are none. */
  loadError = '';
  retention?: AuditLogRetentionResponseDto;
  /** Entries whose details are open. */
  readonly expanded = new Set<string>();

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
          return from(this.service.search(this.buildQuery())).pipe(
            catchError((error: unknown) => {
              this.loadError = getApiErrorMessage(error, 'Failed to load activity logs');
              // Entries of an earlier query no longer match what the filters ask for.
              this.showPage([], 0);
              return of(null);
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((page) => {
        // A bookmark or Refresh can point past the last page, for example
        // after the nightly pruning: show the last page instead.
        if (page?.items.length === 0 && page.total > 0 && this.pageIndex > 0) {
          this.pageIndex = Math.max(0, page.totalPages - 1);
          this.reload$.next();
          return;
        }
        this.loading = false;
        if (page) {
          this.loaded = true;
          this.loadedFiltered = this.hasActiveFilters();
          this.showPage(page.items, page.total);
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
    // `disabledInteractive` keeps Refresh clickable while it looks disabled.
    if (this.loading) return;
    this.reload$.next();
  }

  /** Clear search removes itself; the search field keeps the focus. */
  clearSearch(): void {
    this.filters.controls.q.setValue('');
    this.searchInput?.nativeElement.focus();
  }

  /**
   * A click on the chosen chip deselects it; choose it again, so one chip is
   * always chosen and nothing is loaded again.
   */
  selectObjectType(event: Pick<MatChipListboxChange, 'value' | 'source'>): void {
    const value = event.value as AuditObjectType | '' | undefined;
    if (value === undefined) {
      // After the chip has finished handling the click that deselected it.
      const chosen = this.filters.controls.objectType.value;
      queueMicrotask(() => (event.source.value = chosen));
      return;
    }
    if (value !== this.filters.controls.objectType.value) {
      this.filters.controls.objectType.setValue(value);
    }
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

  /** Changes the page size and keeps the first entry of the current page in view. */
  setPageSize(size: number): void {
    this.pageIndex = Math.floor((this.pageIndex * this.pageSize) / size);
    this.pageSize = size;
    this.reload$.next();
  }

  clearFilters(): void {
    this.filters.reset();
    // Clear Filters removes itself, and with it the focus.
    focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
  }

  hasActiveFilters(): boolean {
    const { q, objectType, actionType, actorType, actorId, requestId, time } =
      this.filters.getRawValue();
    return !!(
      q.trim() ||
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
    return this.objectTypes
      .filter((object) => !chosen || object.value === chosen)
      .map((object) => ({
        objectType: object.value,
        label: object.label,
        actions: ACTION_TYPES.filter((action) => objectTypeOf(action) === object.value).map(
          (value) => ({ value, label: describeAction(value).label })
        ),
      }));
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

  describe(log: AuditLogResponseDto): ActionDescription {
    return describeAction(log.actionType);
  }

  actorLabel(log: AuditLogResponseDto): string {
    return log.actorDisplay || log.actorId || 'Unknown';
  }

  /**
   * The id the Actor ID filter matches, when the label shows something else:
   * for a user, the label is the client they signed in with.
   */
  hiddenActorId(log: AuditLogResponseDto): string {
    return log.actorId && log.actorDisplay && log.actorId !== log.actorDisplay ? log.actorId : '';
  }

  actorTypeLabel(log: AuditLogResponseDto): string {
    return ACTOR_LABELS[log.actorType] ?? log.actorType;
  }

  /** How many entries a retention run deleted, for its row. */
  deletedEntries(log: AuditLogResponseDto): number | undefined {
    const deleted = log.after?.['deletedEntries'];
    return log.actionType === 'audit_log_pruned' && typeof deleted === 'number'
      ? deleted
      : undefined;
  }

  /** A person for users, a key for API clients, a gear for the system. */
  actorIcon(log: AuditLogResponseDto): string {
    return actorIcons[log.actorType] ?? 'help';
  }

  /** The changed fields with their values; for a new object, its fields after the change. */
  fieldChanges(log: AuditLogResponseDto): FieldChange[] {
    const fields = log.changedFields?.length
      ? log.changedFields
      : Object.keys(log.after ?? log.before ?? {});
    return fields.map((field) => ({
      field,
      before: display(log.before?.[field]),
      after: display(log.after?.[field]),
    }));
  }

  /** Whether any field had a value before the change, so a Before column says something. */
  hasBefore(changes: FieldChange[]): boolean {
    return changes.some((change) => change.before !== undefined);
  }

  isExpanded(log: AuditLogResponseDto): boolean {
    return this.expanded.has(log.id);
  }

  toggle(log: AuditLogResponseDto): void {
    if (this.expanded.has(log.id)) {
      this.expanded.delete(log.id);
    } else {
      this.expanded.add(log.id);
    }
  }

  async copyLog(log: AuditLogResponseDto): Promise<void> {
    const text = JSON.stringify(log, null, 2);
    await copyToClipboard(this.snackBar, text, 'Copied to clipboard');
  }

  private showPage(logs: AuditLogResponseDto[], total: number): void {
    this.logs = logs;
    this.total = total;
    this.dayGroups = this.groupByDay(logs);
  }

  /** The filters as `GET /admin/audit-logs/search` query. */
  private buildQuery(): ActivityLogQuery {
    const { q, objectType, actionType, actorType, actorId, requestId } = this.filters.getRawValue();
    return {
      page: this.pageIndex + 1,
      pageSize: this.pageSize,
      ...(q.trim() ? { q: q.trim() } : {}),
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
    const { q, objectType, actionType, actorType, actorId, requestId, time, from, to } =
      this.filters.getRawValue();
    const custom = time === 'custom';
    const queryParams: Params = {
      q: q.trim() || null,
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
        q: params.get('q') ?? '',
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

  /** Consecutive entries of the same local day, labelled "Today", "Yesterday" or the date. */
  private groupByDay(logs: AuditLogResponseDto[]): DayGroup[] {
    const today = localDay(new Date().toISOString());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = localDay(yesterdayDate.toISOString());
    const groups: DayGroup[] = [];
    for (const log of logs) {
      const day = localDay(log.timestamp);
      let group = groups.at(-1);
      if (group?.day !== day) {
        let label: string;
        if (day === today) {
          label = 'Today';
        } else if (day === yesterday) {
          label = 'Yesterday';
        } else {
          label = new Date(log.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
        }
        group = { day, label, logs: [] };
        groups.push(group);
      }
      group.logs.push(log);
    }
    return groups;
  }
}
