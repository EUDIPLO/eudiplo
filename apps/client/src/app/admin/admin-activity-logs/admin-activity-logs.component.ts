import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { AuditLogResponseDto, auditLogControllerGetAuditLogs } from '@eudiplo/sdk-core';
import { getApiErrorMessage } from '../../utils/error-message';

@Component({
  selector: 'app-admin-activity-logs',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatTableModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatPaginatorModule,
    MatSelectModule,
    MatFormFieldModule,
  ],
  templateUrl: './admin-activity-logs.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './admin-activity-logs.component.scss',
})
export class AdminActivityLogsComponent implements OnInit {
  activityLogs: AuditLogResponseDto[] = [];
  filteredLogs: AuditLogResponseDto[] = [];
  visibleLogs: AuditLogResponseDto[] = [];
  activityLoading = false;
  activityError = '';
  readonly fetchLimit = 500;

  pageIndex = 0;
  pageSize = 25;
  readonly pageSizeOptions = [10, 25, 50, 100];

  selectedObjectType: string | null = null;

  displayedColumns: string[] = ['timestamp', 'action', 'actor', 'changedFields', 'actions'];

  constructor(private snackBar: MatSnackBar) {}

  ngOnInit(): void {
    this.loadActivityLogs();
  }

  async loadActivityLogs(): Promise<void> {
    this.activityLoading = true;
    this.activityError = '';

    try {
      const response = await auditLogControllerGetAuditLogs<true>({
        query: { limit: this.fetchLimit },
      });

      this.activityLogs = response.data || [];
      this.pageIndex = 0;
      this.updateVisibleLogs();
    } catch (error) {
      this.activityError = getApiErrorMessage(error, 'Failed to load activity logs');
      this.snackBar.open('Failed to load activity logs', 'Close', { duration: 5000 });
    } finally {
      this.activityLoading = false;
    }
  }

  onPageChange(event: PageEvent): void {
    this.pageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    this.updateVisibleLogs();
  }

  onFilterChange(): void {
    this.pageIndex = 0;
    this.updateVisibleLogs();
  }

  private updateVisibleLogs(): void {
    let filtered = this.activityLogs;

    if (this.selectedObjectType) {
      filtered = filtered.filter((log) => log.actionType?.includes(this.selectedObjectType!));
    }

    this.filteredLogs = filtered;
    const start = this.pageIndex * this.pageSize;
    const end = start + this.pageSize;
    this.visibleLogs = filtered.slice(start, end);
  }

  getObjectTypes(): { label: string; value: string }[] {
    const objectTypes = new Set<string>();

    for (const log of this.activityLogs) {
      if (log.actionType) {
        const match = log.actionType.match(
          /^(.+?)(?:_created|_updated|_deleted|_reset|_cancelled)$/
        );
        if (match) {
          objectTypes.add(match[1]);
        }
      }
    }

    const typeLabels: Record<string, string> = {
      tenant: 'Tenant',
      presentation_config: 'Presentation Config',
      issuance_config: 'Issuance Config',
      credential_config: 'Credential Config',
      attribute_provider: 'Attribute Provider',
      status_list_config: 'Status List Config',
      webhook_endpoint: 'Webhook Endpoint',
      session: 'Session',
    };

    return Array.from(objectTypes)
      .sort((a, b) => a.localeCompare(b))
      .map((type) => ({
        label: typeLabels[type] || type,
        value: type,
      }));
  }
  actorLabel(log: AuditLogResponseDto): string {
    const display = log.actorDisplay || log.actorId || 'Unknown';
    return `${display} (${log.actorType})`;
  }

  actionLabel(actionType?: string): string {
    if (!actionType) return 'Unknown';
    const labels: Record<string, string> = {
      tenant_created: 'Tenant Created',
      tenant_updated: 'Tenant Updated',
      tenant_deleted: 'Tenant Deleted',
      presentation_config_created: 'Presentation Config Created',
      presentation_config_updated: 'Presentation Config Updated',
      presentation_config_deleted: 'Presentation Config Deleted',
      issuance_config_updated: 'Issuance Config Updated',
      credential_config_created: 'Credential Config Created',
      credential_config_updated: 'Credential Config Updated',
      credential_config_deleted: 'Credential Config Deleted',
      attribute_provider_created: 'Attribute Provider Created',
      attribute_provider_updated: 'Attribute Provider Updated',
      attribute_provider_deleted: 'Attribute Provider Deleted',
      status_list_config_updated: 'Status List Config Updated',
      status_list_config_reset: 'Status List Config Reset',
      webhook_endpoint_created: 'Webhook Endpoint Created',
      webhook_endpoint_updated: 'Webhook Endpoint Updated',
      webhook_endpoint_deleted: 'Webhook Endpoint Deleted',
      session_cancelled: 'Session Cancelled',
    };
    return labels[actionType] || actionType;
  }

  formatTimestamp(timestamp?: string): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
  }

  getChangedFieldsText(changedFields?: string[]): string {
    if (!changedFields || changedFields.length === 0) return 'N/A';
    return changedFields.join(', ');
  }

  copyToClipboard(log: AuditLogResponseDto): void {
    const text = JSON.stringify(log, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      this.snackBar.open('Copied to clipboard', 'Close', { duration: 2000 });
    });
  }

  refresh(): void {
    this.selectedObjectType = null;
    this.pageIndex = 0;
    this.loadActivityLogs();
  }
}
