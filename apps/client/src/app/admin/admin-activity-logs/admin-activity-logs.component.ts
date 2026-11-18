import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { AuditLogResponseDto, auditLogControllerGetAuditLogs } from '@eudiplo/sdk-core';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

/** What an entry's action did, as the page shows it. */
export interface ActionDescription {
  /** The object the action is about, such as `credential_config`. */
  object: string;
  /** The verb, such as `created`; empty when the action type has none of the known verbs. */
  verb: string;
  /** For example "Credential Config Created". */
  label: string;
  /** Colour role of the verb. */
  tone: 'tone-success' | 'tone-info' | 'tone-danger' | 'tone-neutral';
  icon: string;
}

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

/** The verbs action types end with, with their colour and icon. */
const verbs: Record<string, { tone: ActionDescription['tone']; icon: string }> = {
  created: { tone: 'tone-success', icon: 'add' },
  added: { tone: 'tone-success', icon: 'add' },
  imported: { tone: 'tone-success', icon: 'download' },
  generated: { tone: 'tone-success', icon: 'key' },
  updated: { tone: 'tone-info', icon: 'edit' },
  reset: { tone: 'tone-info', icon: 'restart_alt' },
  reattached: { tone: 'tone-info', icon: 'link' },
  exported: { tone: 'tone-neutral', icon: 'upload' },
  detached: { tone: 'tone-neutral', icon: 'link_off' },
  deleted: { tone: 'tone-danger', icon: 'delete' },
  cancelled: { tone: 'tone-danger', icon: 'block' },
};

const actorIcons: Record<AuditLogResponseDto['actorType'], string> = {
  user: 'person',
  client: 'key',
  system: 'settings',
};

/** Words of object types that are not simply capitalised. */
const words: Record<string, string> = {
  oidc: 'OpenID Connect',
  config: 'Config',
};

/** "credential_config" as "Credential Config", "oidc_client" as "OpenID Connect Client". */
function titleCase(snake: string): string {
  return snake
    .split('_')
    .map((word) => words[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Splits an action type into its object and verb, for any action the backend logs. */
export function describeAction(actionType: string | undefined): ActionDescription {
  if (!actionType) {
    return { object: '', verb: '', label: 'Unknown', tone: 'tone-neutral', icon: 'help' };
  }
  const verb = Object.keys(verbs).find((candidate) => actionType.endsWith(`_${candidate}`));
  if (!verb) {
    return {
      object: actionType,
      verb: '',
      label: titleCase(actionType),
      tone: 'tone-neutral',
      icon: 'history',
    };
  }
  const object = actionType.slice(0, -(verb.length + 1));
  return { object, verb, label: `${titleCase(object)} ${titleCase(verb)}`, ...verbs[verb] };
}

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

@Component({
  selector: 'app-admin-activity-logs',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    LoadErrorComponent,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatPaginatorModule,
  ],
  templateUrl: './admin-activity-logs.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './admin-activity-logs.component.scss',
})
export class AdminActivityLogsComponent implements OnInit {
  activityLogs: AuditLogResponseDto[] = [];
  /** The entries that match the search and the object type, on all pages. */
  filteredLogs: AuditLogResponseDto[] = [];
  /** The entries of the current page, by day. */
  dayGroups: DayGroup[] = [];
  /** The object types of the loaded entries, for the filter chips. */
  objectTypes: { label: string; value: string }[] = [];
  activityLoading = false;
  activityError = '';
  readonly fetchLimit = 500;

  pageIndex = 0;
  pageSize = 25;
  readonly pageSizeOptions = [10, 25, 50, 100];

  /** Object type the entries are limited to; empty for all. */
  selectedObjectType = '';
  /** Text to find in an entry's action, actor or changed fields. */
  search = '';
  /** Entries whose details are open. */
  readonly expanded = new Set<string>();

  constructor(private readonly snackBar: MatSnackBar) {}

  ngOnInit(): void {
    void this.loadActivityLogs();
  }

  async loadActivityLogs(): Promise<void> {
    this.activityLoading = true;
    this.activityError = '';

    try {
      const response = await auditLogControllerGetAuditLogs<true>({
        query: { limit: this.fetchLimit },
      });

      this.activityLogs = response.data || [];
      this.objectTypes = this.collectObjectTypes();
      this.pageIndex = 0;
      this.applyFilters();
    } catch (error) {
      this.activityError = getApiErrorMessage(error, 'Failed to load activity logs');
    } finally {
      this.activityLoading = false;
    }
  }

  /** Filters by object type and search, keeps the page within the results and groups it by day. */
  applyFilters(): void {
    const term = this.search.trim().toLowerCase();
    this.filteredLogs = this.activityLogs.filter((log) => {
      const action = describeAction(log.actionType);
      if (this.selectedObjectType && action.object !== this.selectedObjectType) return false;
      if (!term) return true;
      return [action.label, this.actorLabel(log), ...(log.changedFields ?? [])].some((value) =>
        value.toLowerCase().includes(term)
      );
    });
    const lastPage = Math.max(0, Math.ceil(this.filteredLogs.length / this.pageSize) - 1);
    this.pageIndex = Math.min(this.pageIndex, lastPage);
    const start = this.pageIndex * this.pageSize;
    this.dayGroups = this.groupByDay(this.filteredLogs.slice(start, start + this.pageSize));
  }

  /** A new search or object type starts on the first page. */
  onFilterChange(): void {
    this.pageIndex = 0;
    this.applyFilters();
  }

  selectObjectType(value: string): void {
    this.selectedObjectType = value;
    this.onFilterChange();
  }

  clearFilters(): void {
    this.search = '';
    this.selectedObjectType = '';
    this.onFilterChange();
  }

  get hasFilters(): boolean {
    return this.search.trim() !== '' || this.selectedObjectType !== '';
  }

  onPageChange(event: PageEvent): void {
    this.pageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    this.applyFilters();
  }

  /** Changes the page size and keeps the first entry of the current page in view. */
  setPageSize(size: number): void {
    this.pageIndex = Math.floor((this.pageIndex * this.pageSize) / size);
    this.pageSize = size;
    this.applyFilters();
  }

  describe(log: AuditLogResponseDto): ActionDescription {
    return describeAction(log.actionType);
  }

  actorLabel(log: AuditLogResponseDto): string {
    return log.actorDisplay || log.actorId || 'Unknown';
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

  refresh(): void {
    this.clearFilters();
    void this.loadActivityLogs();
  }

  private collectObjectTypes(): { label: string; value: string }[] {
    const objects = new Set(
      this.activityLogs.map((log) => describeAction(log.actionType).object).filter(Boolean)
    );
    return [...objects]
      .map((value) => ({ value, label: titleCase(value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
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
