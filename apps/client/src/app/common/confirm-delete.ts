import type { MatSnackBar } from '@angular/material/snack-bar';

import { getApiErrorMessage } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';

/** What a Delete asks, sends and reports. */
export interface DeleteAction {
  /** The question to confirm, such as `Delete status list "a"? This cannot be undone.` */
  question: string;
  request: () => Promise<unknown>;
  /** Snackbar text after the delete, such as "Status list deleted successfully". */
  deleted: string;
  /** Prefix of the error, such as "Failed to delete status list". */
  failed: string;
  /** Called with true when the request starts and with false when it has ended. */
  busy: (busy: boolean) => void;
}

/**
 * Deletes after the user confirmed it and says how it went: a snackbar on success, the reason
 * on failure. A refused request (403) also reaches the role-change notice through the API
 * client, so the caller does not check roles itself. Returns whether the item was deleted.
 */
export async function confirmAndDelete(
  snackBar: MatSnackBar,
  action: DeleteAction
): Promise<boolean> {
  if (!confirm(action.question)) {
    return false;
  }
  action.busy(true);
  try {
    await action.request();
    snackBar.open(action.deleted, 'Close', { duration: 3000 });
    return true;
  } catch (error) {
    console.error(`${action.failed}:`, error);
    openErrorSnackBar(snackBar, getApiErrorMessage(error, action.failed));
    return false;
  } finally {
    action.busy(false);
  }
}
