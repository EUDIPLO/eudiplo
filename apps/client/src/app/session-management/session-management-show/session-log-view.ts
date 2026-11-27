import type { SessionLogEntry } from '../session-management.service';

/** One short detail value shown as a key/value row. */
interface SessionLogField {
  key: string;
  value: string;
}

/** How the Logs tab shows one entry's detail. */
export interface SessionLogView {
  /** Error class, for example `SdJwtError`; shown as a chip next to the stage. */
  errorName?: string;
  /** Detail values that are strings, numbers or booleans. */
  fields: SessionLogField[];
  /** Everything else in the detail (objects, arrays), as formatted JSON; behind a "Details" toggle. */
  extra?: string;
  /** Stack trace, stored only with `LOG_SESSION_STORE=verbose`; behind a "Stack trace" toggle. */
  stack?: string;
}

/**
 * Splits a session log entry's detail for display. `errorMessage` is dropped
 * when the message line already carries it.
 */
export function sessionLogView(entry: SessionLogEntry): SessionLogView {
  const view: SessionLogView = { fields: [] };
  const rest: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry.detail ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === 'errorName' && typeof value === 'string') {
      view.errorName = value;
    } else if (key === 'errorStack' && typeof value === 'string') {
      view.stack = value;
    } else if (
      key === 'errorMessage' &&
      typeof value === 'string' &&
      value !== '' &&
      entry.message.includes(value)
    ) {
      // The message line already carries it.
      continue;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      view.fields.push({ key, value: String(value) });
    } else {
      rest[key] = value;
    }
  }

  if (Object.keys(rest).length > 0) {
    view.extra = JSON.stringify(rest, null, 2);
  }
  return view;
}
