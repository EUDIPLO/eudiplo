import { Injectable } from '@angular/core';
import type { CredentialStatusValue } from './credential-status/credential-status';
import {
  client,
  CredentialStatusDto,
  sessionControllerCancel,
  sessionControllerDeleteSession,
  sessionControllerGetAllSessions,
  sessionControllerGetCredentialStatus,
  sessionControllerGetSession,
  sessionControllerRevokeAll,
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

/** Offers and requests a wallet has neither redeemed nor finished, the only ones that can be cancelled. */
export function isCancellable(session: Pick<Session, 'status' | 'consumed'>): boolean {
  return (session.status === 'active' || session.status === 'fetched') && !session.consumed;
}

/** Whether a cancellation was rejected because the session is no longer pending (HTTP 409). */
export function isCancelConflict(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 409;
}

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
   * Delete a session by ID. Credentials issued in the session keep their
   * status; use {@link updateCredentialStatus} to revoke them.
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
   * Cancel a pending offer or presentation request, so a wallet can no longer use it
   */
  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    await sessionControllerCancel({
      path: { id: sessionId },
      body: reason ? { reason } : {},
    });
  }

  /**
   * Get the status of every credential issued in a session that carries one
   */
  async getCredentialStatus(sessionId: string): Promise<CredentialStatusDto[]> {
    const response = await sessionControllerGetCredentialStatus({ path: { id: sessionId } });
    return response.data ?? [];
  }

  /**
   * Set the status of the credentials issued in a session, optionally only
   * those of one credential configuration. Revocation is final.
   */
  async updateCredentialStatus(
    sessionId: string,
    status: CredentialStatusValue,
    credentialConfigurationId?: string
  ): Promise<void> {
    await sessionControllerRevokeAll({
      body: {
        sessionId,
        status,
        ...(credentialConfigurationId !== undefined && { credentialConfigurationId }),
      },
    });
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
