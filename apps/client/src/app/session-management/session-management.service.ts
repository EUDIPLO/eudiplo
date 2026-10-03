import { Injectable } from '@angular/core';
import {
  client,
  sessionControllerDeleteSession,
  sessionControllerGetAllSessions,
  sessionControllerGetSession,
  PaginatedSessionResponseDto,
  Session,
  SessionControllerGetAllSessionsData,
} from '@eudiplo/sdk-core';

export interface SessionLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type SessionQueryParams = NonNullable<SessionControllerGetAllSessionsData['query']>;

@Injectable({
  providedIn: 'root',
})
export class SessionManagementService {
  constructor() {}

  /**
   * Get sessions with pagination and optional filters
   */
  async getAllSessions(params: SessionQueryParams = {}): Promise<PaginatedSessionResponseDto> {
    try {
      const response = await sessionControllerGetAllSessions({ query: params });
      return response.data as PaginatedSessionResponseDto;
    } catch (error) {
      console.error('Error fetching sessions:', error);
      throw new Error('Failed to load sessions', { cause: error });
    }
  }

  /**
   * Get a specific session by ID
   */
  async getSession(id: string): Promise<Session> {
    return sessionControllerGetSession({
      path: { id },
    }).then((response) => {
      if (response.data) {
        return response.data;
      } else {
        throw new Error('Session not found');
      }
    });
  }

  /**
   * Format a date string for display
   */
  formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
  }

  /**
   * Get session status display text
   */
  getStatusDisplay(status: any): string {
    if (typeof status === 'object' && status !== null) {
      return JSON.stringify(status);
    }
    return status?.toString() || 'Unknown';
  }

  /**
   * Revoke/delete a session by ID
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await sessionControllerDeleteSession({
        path: { id: sessionId },
      });
    } catch (error) {
      console.error('Error deleting session:', error);
      throw new Error(`Failed to delete session ${sessionId}`, { cause: error });
    }
  }

  /**
   * Get log entries for a session
   */
  async getSessionLogs(sessionId: string): Promise<SessionLogEntry[]> {
    const response = await client.get<SessionLogEntry[]>({
      security: [{ scheme: 'bearer', type: 'http' }],
      url: '/api/session/{id}/logs',
      path: { id: sessionId },
    });
    return (response.data as SessionLogEntry[]) ?? [];
  }
}
