import type { Session, SessionOutcomeCredentialDto } from '@eudiplo/sdk-core';
import { isPresentationSession } from './session-management.service';

/** Statuses after which a session no longer changes. */
const FINISHED_STATUSES = new Set(['completed', 'expired', 'failed', 'cancelled']);

/** Whether a session has ended, so it shows a result and no longer needs polling. */
export function isFinishedSession(status: string | null | undefined): boolean {
  return !!status && FINISHED_STATUSES.has(status);
}

/** What the session details page says about how a session ended. */
export interface SessionResultSummary {
  tone: 'success' | 'error' | 'neutral';
  icon: string;
  title: string;
  /** Why it ended this way, or null when nothing was recorded. */
  message: string | null;
  /** The wallet's own text with its error or notification; wallet-controlled. */
  walletDescription: string | null;
  /** The reason the operator gave when cancelling the session. */
  cancelReason: string | null;
  /** Machine-readable failure code, for failed sessions. */
  code: string | null;
  /** The wallet refused a presentation request, likely because of how it was built. */
  checkRequest: boolean;
  credentials: SessionOutcomeCredentialDto[];
}

type ResultSession = Pick<
  Session,
  'status' | 'outcome' | 'errorReason' | 'failureCode' | 'cancelReason' | 'requestId' | 'consumed'
>;

/** Titles for presentation failures the wallet reported, by failure code. */
const WALLET_FAILURE_TITLES: Record<string, string> = {
  access_denied: 'The user declined the request in the wallet',
};

/**
 * How a finished session ended, from its status and `outcome`. Null while the
 * session is still pending.
 */
export function sessionResult(session: ResultSession): SessionResultSummary | null {
  const outcome = session.outcome ?? null;
  const presentation = isPresentationSession(session);
  const base = {
    message: outcome?.message ?? session.errorReason ?? null,
    walletDescription: null,
    cancelReason: null,
    code: null,
    checkRequest: false,
    credentials: outcome?.credentials ?? [],
  };

  switch (session.status) {
    case 'failed':
      return failedResult(session, presentation, base);
    case 'completed':
      return {
        ...base,
        tone: 'success',
        icon: 'check_circle',
        title: presentation ? 'Verification succeeded' : 'Credentials issued',
        message: null,
      };
    case 'expired':
      // An issuance whose offer was redeemed got its credentials; only the
      // wallet's optional confirmation is missing.
      if (!presentation && session.consumed) {
        return {
          ...base,
          tone: 'neutral',
          icon: 'help',
          title: 'Credentials issued, not confirmed',
          message:
            'The wallet redeemed the offer but did not confirm the credentials before the session expired. Wallets do not have to send this confirmation.',
        };
      }
      return {
        ...base,
        tone: 'neutral',
        icon: 'timer_off',
        title: 'Session expired',
        message: presentation
          ? 'No wallet answered the request before it expired.'
          : 'No wallet redeemed the offer before it expired.',
      };
    case 'cancelled': {
      const cancelReason = session.cancelReason || null;
      const before = presentation
        ? 'It was cancelled before a wallet answered the request.'
        : 'It was cancelled before a wallet redeemed the offer.';
      return {
        ...base,
        tone: 'neutral',
        icon: 'cancel',
        title: 'Session cancelled',
        // Older sessions kept the reason only in the session log (Logs tab).
        message: cancelReason ? before : `${before} No reason was given.`,
        cancelReason,
      };
    }
    default:
      return null;
  }
}

function failedResult(
  session: ResultSession,
  presentation: boolean,
  base: Omit<SessionResultSummary, 'tone' | 'icon' | 'title'>
): SessionResultSummary {
  const outcome = session.outcome ?? null;
  const code = session.failureCode ?? outcome?.error ?? null;
  const failed = { ...base, tone: 'error' as const, icon: 'error', code };

  if (outcome?.source === 'wallet' && !presentation) {
    // An OpenID4VCI notification: the backend's message names the event.
    return {
      ...failed,
      title: outcome.message ?? 'The wallet reported an error',
      message:
        'The credential was already issued. Revoke it under Credential Status if it must not stay valid.',
      walletDescription: outcome.description ?? null,
    };
  }
  if (outcome?.source === 'wallet') {
    const known = code ? WALLET_FAILURE_TITLES[code] : undefined;
    return {
      ...failed,
      title: known ?? 'The wallet rejected the request',
      // The wallet's own text, or a title naming the case, replaces the
      // generic message EUDIPLO built from the wallet's error.
      message: outcome.description || known ? null : base.message,
      walletDescription: outcome.description ?? null,
      checkRequest: !known,
    };
  }
  return { ...failed, title: presentation ? 'Verification failed' : 'Issuance failed' };
}

/**
 * Class of a session status badge, `status-<status>`, whose tone the
 * `session-status-badges` mixin sets; empty for a status that is not a string.
 */
export function sessionStatusClass(status: unknown): string {
  return typeof status === 'string' ? `status-${status}` : '';
}

/** Readable label of a session status. */
export function sessionStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'fetched':
      return 'Fetched';
    case 'completed':
      return 'Completed';
    case 'expired':
      return 'Expired';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status || 'Unknown';
  }
}
