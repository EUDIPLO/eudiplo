import { Injectable } from '@angular/core';
import {
  type AuditLogControllerSearchAuditLogsData,
  type AuditLogPageResponseDto,
  type AuditLogRetentionResponseDto,
  auditLogControllerGetRetention,
  auditLogControllerSearchAuditLogs,
} from '@eudiplo/sdk-core';

export type ActivityLogQuery = NonNullable<AuditLogControllerSearchAuditLogsData['query']>;

@Injectable({ providedIn: 'root' })
export class ActivityLogService {
  async search(query: ActivityLogQuery): Promise<AuditLogPageResponseDto> {
    const response = await auditLogControllerSearchAuditLogs<true>({ query });
    return response.data;
  }

  async retention(): Promise<AuditLogRetentionResponseDto> {
    const response = await auditLogControllerGetRetention<true>();
    return response.data;
  }
}
