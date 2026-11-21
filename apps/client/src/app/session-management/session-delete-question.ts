import type { Session } from '@eudiplo/sdk-core';

import { isPresentationSession } from './session-management.service';
import { isFinishedSession } from './session-outcome';

/**
 * What deleting a session means for the credentials issued in it. The Credential Status card on
 * the session page is the only place in the Web Client that changes their status; the backend
 * keeps the status entries, so the API still can, by session ID.
 */
export const DELETED_SESSION_CREDENTIALS =
  'Credentials issued in a deleted session keep their status, but the Web Client can no longer revoke, suspend or reinstate them; only POST /api/session/revoke with the session ID still can.';

/** How many session IDs the question lists before it says how many more there are. */
const LISTED_SESSIONS = 5;

/**
 * Question before the selected sessions are deleted: names them, says which are still pending,
 * and, when an issuance session is among them, what happens to its credentials.
 */
export function sessionDeleteQuestion(sessions: readonly Session[]): string {
  const count = sessions.length;
  const ids = sessions.slice(0, LISTED_SESSIONS).map((session) => `• ${session.id}`);
  if (count > LISTED_SESSIONS) ids.push(`and ${count - LISTED_SESSIONS} more`);
  const pending = sessions.filter((session) => !isFinishedSession(session.status)).length;
  const issuance = sessions.some((session) => !isPresentationSession(session));

  return [
    `Delete ${count} ${count === 1 ? 'session' : 'sessions'}?`,
    ids.join('\n'),
    pendingNote(count, pending),
    issuance ? DELETED_SESSION_CREDENTIALS : '',
    'This cannot be undone.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Says that pending sessions lose their offer or request; empty when none is pending. */
function pendingNote(count: number, pending: number): string {
  if (pending === 0) return '';
  if (count === 1) return 'It is still pending: a wallet can no longer use its offer or request.';
  const which = pending === count ? 'All of them are' : `${pending} of them are`;
  return `${which} still pending: a wallet can no longer use their offers or requests.`;
}
